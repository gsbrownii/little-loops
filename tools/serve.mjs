#!/usr/bin/env node
// Zero-dependency static server for local testing.
//   node tools/serve.mjs                 -> http://localhost:8080/
//   node tools/serve.mjs 8080 --base little-loops      (no leading slash: Git Bash rewrites /paths)
//        serves the app under a sub-path, exactly like GitHub Pages project sites.
// Also importable: `const { url, close } = await startServer({ port: 0, base: '/x/' })`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function normBase(b = '/') {
  let base = b;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base += '/';
  return base;
}

export function startServer({ port = 8080, base = '/', root = APP_ROOT, quiet = false } = {}) {
  base = normBase(base);
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (base !== '/') {
      if (pathname === '/' || pathname === base.slice(0, -1)) {
        res.writeHead(302, { location: base }).end();
        return;
      }
      if (!pathname.startsWith(base)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      pathname = `/${pathname.slice(base.length)}`;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(root, path.normalize(pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const url = `http://localhost:${actual}${base}`;
      if (!quiet) console.log(`Little Loops: ${url}`);
      resolve({ url, port: actual, server, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 8080);
  const baseIdx = args.indexOf('--base');
  startServer({ port, base: baseIdx >= 0 ? args[baseIdx + 1] : '/' }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
