#!/usr/bin/env node
// Re-record the voice pack after content changes:  npm run voice  [-- --force | --voice af_heart --name Heart ...]
// 1. collects every spoken line (tools/voice-lines.mjs -> tools/voice/lines.json)
// 2. records the new ones with Kokoro (tools/voice/make_voice.py), using the Python environment in
//    LL_VOICE_HOME (default: %LOCALAPPDATA%/little-loops-voice). See README "Voice" for the one-time setup.
// Then run `npm run precache` so the new clips are cached for offline use.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from './serve.mjs';

const home = process.env.LL_VOICE_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'little-loops-voice');
const py = [path.join(home, 'venv', 'Scripts', 'python.exe'), path.join(home, 'venv', 'bin', 'python')].find((p) => fs.existsSync(p));
if (!py) {
  console.error(`voice: no Python environment at ${home}/venv. One-time setup: see README "Voice".`);
  process.exit(1);
}
let r = spawnSync(process.execPath, [path.join(APP_ROOT, 'tools/voice-lines.mjs')], { stdio: 'inherit' });
if (r.status) process.exit(r.status);
r = spawnSync(py, [path.join(APP_ROOT, 'tools/voice/make_voice.py'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PYTHONWARNINGS: 'ignore', LL_VOICE_HOME: home } });
if (r.status === 0) console.log('voice: done. Now run: npm run precache');
process.exit(r.status ?? 1);
