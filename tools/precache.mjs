#!/usr/bin/env node
// Generate the service worker's precache list and cache version.
//
//   node tools/precache.mjs           rewrite sw.js: the list between the "// <precache>" and
//                                     "// </precache>" marker lines, and CACHE = 'little-loops-<hash>'
//   node tools/precache.mjs --check   exit 1 if sw.js is stale (use before every deploy / in CI)
//   node tools/precache.mjs --list    print the files that would be precached
//
// Precached: index.html, manifest.webmanifest, css/**, js/**, data/**, art/**, icons/**, plus './'
// (the scope root, an alias of index.html). Never: tools/, docs/, schemas/, node_modules/, .git/,
// dotfiles, *.md, package*.json, sw.js itself, editor/OS junk. Paths are app-relative ('js/app.js'),
// sorted by code point, so output is deterministic on every OS. The version is a short SHA-256 of
// every listed path + its bytes: any content change gives a new cache and triggers an app update.
//
// File names must be usable as plain relative URLs. A name containing '#' (starts a fragment), '?'
// (starts a query), '%' (an escape), '\' (read as '/') or a control character would make the
// service worker request the wrong URL, its all-or-nothing install would fail, and the app would
// never work offline or update. Such names are refused with an error (exit 1, also in --check), so
// a badly named content file (e.g. AI-generated) cannot be deployed by accident. Spaces and
// non-ASCII letters are fine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_FILES = ['index.html', 'manifest.webmanifest'];
export const ROOT_DIRS = ['css', 'js', 'data', 'art', 'icons'];
// Only ROOT_FILES and ROOT_DIRS are scanned, so top-level tools/ docs/ schemas/ sw.js are never seen.
// Inside the scanned folders, skip these at any depth:
const SKIP_DIRS = new Set(['node_modules']);
const SKIP_FILE = /^\.|^package(-lock)?\.json$|^(thumbs\.db|desktop\.ini)$|\.(md|map|tmp|bak|orig|swp|log)$|~$/i;
const MARK_OPEN = '// <precache>';
const MARK_CLOSE = '// </precache>';
const VERSION_RE = /^(\s*const CACHE = )'little-loops-[^']*';/m;
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** All precacheable files, app-relative with forward slashes, sorted. */
export function collectFiles(root = APP_ROOT) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!d.name.startsWith('.') && !SKIP_DIRS.has(d.name)) walk(childRel);
      } else if (d.isFile() && !SKIP_FILE.test(d.name)) {
        out.push(childRel);
      }
    }
  };
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(root, f))) out.push(f);
  for (const dir of ROOT_DIRS) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return out.sort(byCodePoint);
}

// Text files are hashed with LF line endings, so a Windows checkout (git autocrlf -> CRLF) and
// Linux CI / GitHub Pages compute the same version.
const TEXT_EXT = /\.(html|css|js|mjs|json|webmanifest|svg|txt|xml)$/i;

const UNSAFE_CHARS = /[#?%\\\u0000-\u001f\u007f]/;
const PROBE_BASE = 'https://example.invalid/app/';

/** True if `rel` resolves, as a relative URL, to exactly that file (no query/fragment/escape/slash surprises). */
export function isUrlSafePath(rel) {
  if (UNSAFE_CHARS.test(rel)) return false;
  try {
    const u = new URL(rel, PROBE_BASE);
    return !u.search && !u.hash && decodeURIComponent(u.pathname) === `/app/${rel}`;
  } catch {
    return false;
  }
}

/** Paths from `files` that cannot be used as relative URLs (see the header). */
export function unsafePaths(files) {
  return files.filter((f) => !isUrlSafePath(f));
}

/** { files, urls (with './' first), version, bytes }. Throws if any file name is not URL-safe. */
export function buildPrecache(root = APP_ROOT) {
  const files = collectFiles(root);
  const bad = unsafePaths(files);
  if (bad.length) {
    throw new Error(
      `${bad.length} file name(s) cannot be used as URLs (no # ? % \\ or control characters). `
      + `Rename them (and any references to them):\n${bad.map((f) => `  ${JSON.stringify(f)}`).join('\n')}`,
    );
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const f of files) {
    let buf = fs.readFileSync(path.join(root, f));
    bytes += buf.length;
    if (TEXT_EXT.test(f) && buf.includes(13)) buf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    hash.update(f).update('\0').update(buf).update('\0');
  }
  return { files, urls: ['./', ...files], version: hash.digest('hex').slice(0, 10), bytes };
}

const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Return sw.js text with the generated list + version applied. Throws if the markers are missing. */
export function applyToSW(swText, { urls, version }) {
  const eol = swText.includes('\r\n') ? '\r\n' : '\n';
  const lines = swText.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === MARK_OPEN);
  const close = lines.findIndex((l, i) => i > open && l.trim() === MARK_CLOSE);
  if (open < 0 || close < 0) throw new Error(`sw.js must contain the marker lines "${MARK_OPEN}" and "${MARK_CLOSE}"`);
  if (!VERSION_RE.test(swText)) throw new Error("sw.js must contain a line like: const CACHE = 'little-loops-<version>';");
  const indent = `${/^\s*/.exec(lines[open])[0]}  `;
  const body = urls.map((u) => `${indent}${quote(u)},`);
  const next = [...lines.slice(0, open + 1), ...body, ...lines.slice(close)].join(eol);
  return next.replace(VERSION_RE, `$1'little-loops-${version}';`);
}

/** Parse the current list + version out of sw.js (for --check diffs). */
export function readSW(swText) {
  const lines = swText.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === MARK_OPEN);
  const close = lines.findIndex((l, i) => i > open && l.trim() === MARK_CLOSE);
  const urls = open < 0 || close < 0 ? [] : lines.slice(open + 1, close)
    .map((l) => /^\s*'((?:[^'\\]|\\.)*)',?\s*$/.exec(l)?.[1])
    .filter((u) => u != null)
    .map((u) => u.replace(/\\(.)/g, '$1'));
  const version = /const CACHE = 'little-loops-([^']*)';/.exec(swText)?.[1] ?? null;
  return { urls, version };
}

/** Files named in data/app.json that do not exist (they would 404 at runtime and are not precached). */
function missingRegistryFiles(root, files) {
  const have = new Set(files);
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, 'data/app.json'), 'utf8'));
    return (reg.modules || [])
      .flatMap((m) => [m.entry, m.css, m.tile?.art])
      .filter((f) => typeof f === 'string' && f && !have.has(f));
  } catch {
    return [];
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const swFile = path.join(APP_ROOT, 'sw.js');
  const pc = buildPrecache(APP_ROOT);
  const summary = `${pc.files.length} files + './', ${(pc.bytes / 1024).toFixed(1)} KB, version ${pc.version}`;

  if (args.has('--list')) {
    for (const u of pc.urls) console.log(u);
    console.log(`(${summary})`);
    return 0;
  }

  for (const f of missingRegistryFiles(APP_ROOT, pc.files)) {
    console.warn(`precache: warning: data/app.json references "${f}" but it does not exist`);
  }
  const big = pc.files.filter((f) => fs.statSync(path.join(APP_ROOT, f)).size > 2 * 1024 * 1024);
  for (const f of big) console.warn(`precache: warning: "${f}" is over 2 MB (every visitor downloads it on install)`);

  const current = fs.readFileSync(swFile, 'utf8');
  const next = applyToSW(current, pc);

  if (args.has('--check')) {
    if (next === current) {
      console.log(`precache: sw.js is up to date (${summary})`);
      return 0;
    }
    const old = readSW(current);
    const oldSet = new Set(old.urls);
    const newSet = new Set(pc.urls);
    const added = pc.urls.filter((u) => !oldSet.has(u));
    const removed = old.urls.filter((u) => !newSet.has(u));
    console.error('precache: sw.js is STALE. Run: node tools/precache.mjs');
    if (old.version !== pc.version) console.error(`  version: ${old.version} -> ${pc.version}`);
    for (const u of added) console.error(`  + ${u}`);
    for (const u of removed) console.error(`  - ${u}`);
    if (!added.length && !removed.length && old.version === pc.version) console.error('  (formatting differs)');
    return 1;
  }

  if (next === current) {
    console.log(`precache: sw.js already up to date (${summary})`);
  } else {
    fs.writeFileSync(swFile, next);
    console.log(`precache: wrote sw.js (${summary})`);
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`precache: ${err.message}`);
    process.exitCode = 1;
  }
}
