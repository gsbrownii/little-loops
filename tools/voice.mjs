#!/usr/bin/env node
// Re-record the voice pack after content changes:  npm run voice  [-- --force | --limit N | --shard i/n ...]
// 1. collects every spoken line (tools/voice-lines.mjs -> tools/voice/lines.json)
// 2. records the new ones with Kokoro (tools/voice/make_voice.py) into the pack js/config.js uses
//    (APP.voicePack), with that pack's own voice, name, language, speed and bitrate (from its
//    index.json), so new lines always match the old ones. Flags you pass win (--out records into
//    another folder; the app keeps using APP.voicePack until js/config.js is changed).
//    Uses the Python environment in LL_VOICE_HOME (default: %LOCALAPPDATA%/little-loops-voice, or
//    ~/.local/share/little-loops-voice). See README "Voice" for the one-time setup.
// Then run `npm run precache` so the new clips are cached for offline use.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from './serve.mjs';

const home = process.env.LL_VOICE_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'little-loops-voice');
const py = [path.join(home, 'venv', 'Scripts', 'python.exe'), path.join(home, 'venv', 'bin', 'python')].find((p) => fs.existsSync(p));
if (!py) {
  console.error(`voice: no Python environment at ${home}/venv. One-time setup: see README "Voice".`);
  process.exit(1);
}

// The pack to record into, and its settings as defaults (anything given on the command line wins).
const user = process.argv.slice(2);
const flagValue = (flag) => {
  const i = user.findIndex((x) => x === flag || x.startsWith(`${flag}=`));
  if (i < 0) return null;
  return user[i].includes('=') ? user[i].slice(flag.length + 1) : user[i + 1] ?? null;
};
const { APP } = await import(pathToFileURL(path.join(APP_ROOT, 'js/config.js')).href);
const configured = path.posix.dirname(APP.voicePack); // e.g. audio/emma
const outDir = path.posix.normalize((flagValue('--out') || configured).replace(/\\/g, '/')).replace(/\/$/, '');
let idx = null;
try { idx = JSON.parse(fs.readFileSync(path.join(APP_ROOT, outDir, 'index.json'), 'utf8')); } catch { idx = null; }
const defaults = [];
const put = (flag, v) => { if (v != null && v !== '' && flagValue(flag) == null) defaults.push(flag, String(v)); };
put('--out', outDir);
if (idx) {
  put('--voice', idx.voice);
  put('--name', idx.name);
  put('--lang', idx.lang && String(idx.lang).toLowerCase()); // en-GB -> en-gb (Kokoro's spelling)
  put('--speed', idx.speed);
  put('--bitrate', idx.bitrate);
} else {
  console.log(`voice: ${outDir}/index.json does not exist yet: recording a new pack with make_voice.py's defaults unless you pass --voice/--name/--lang.`);
}
if (outDir !== configured) {
  console.warn(`voice: note: recording into ${outDir}, but js/config.js voicePack is ${APP.voicePack}. The app keeps using that pack until you change voicePack (see README "Voice").`);
}

let r = spawnSync(process.execPath, [path.join(APP_ROOT, 'tools/voice-lines.mjs')], { stdio: 'inherit' });
if (r.status) process.exit(r.status);
r = spawnSync(py, [path.join(APP_ROOT, 'tools/voice/make_voice.py'), ...defaults, ...user], { stdio: 'inherit', env: { ...process.env, PYTHONWARNINGS: 'ignore', LL_VOICE_HOME: home } });
if (r.status === 0) console.log('voice: done. Now run: npm run precache');
process.exit(r.status ?? 1);
