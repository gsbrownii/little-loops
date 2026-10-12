#!/usr/bin/env python3
"""Record the Little Loops voice pack with Kokoro (open-source neural text-to-speech, runs offline).

    npm run voice            # = node tools/voice-lines.mjs && python tools/voice/make_voice.py --out <pack> ...

Reads tools/voice/lines.json (written by tools/voice-lines.mjs), records every line that has no
clip yet into <out>/<sha>.mp3, writes <out>/index.json (normalized text -> clip, plus the voice
settings), deletes clips no longer used, and makes audio/silence.mp3 (used to unlock audio on iOS).
Only new or changed lines are recorded, so re-running after a content change is quick.

`npm run voice` records into the pack js/config.js uses (APP.voicePack). The voice, name, language,
speed and bitrate come from that pack's index.json, so new lines always match the old ones; a flag
that would change them is refused unless --force re-records every line.

One-time setup (about 400 MB, outside the app folder; see README "Voice"). Python 3.11-3.13
(3.12 recorded the current pack; kokoro-onnx 0.6.1 does not install on 3.14+):
    Windows:      py -3.12 -m venv %LOCALAPPDATA%/little-loops-voice/venv
                  %LOCALAPPDATA%/little-loops-voice/venv/Scripts/python -m pip install -r tools/voice/requirements.txt
    macOS/Linux:  python3.12 -m venv ~/.local/share/little-loops-voice/venv
                  ~/.local/share/little-loops-voice/venv/bin/python -m pip install -r tools/voice/requirements.txt
    then download kokoro-v1.0.onnx and voices-v1.0.bin from
    https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0) into
    <that folder>/models/
Set LL_VOICE_HOME to use another folder. Kokoro (Apache-2.0) voices may be used freely.
"""
import argparse, json, os, sys, time
from importlib import metadata
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
# Same default as tools/voice.mjs
HOME = Path(os.environ.get('LL_VOICE_HOME') or Path(os.environ.get('LOCALAPPDATA') or Path.home() / '.local' / 'share') / 'little-loops-voice')
DEFAULTS = {'voice': 'bf_emma', 'name': 'Emma', 'lang': 'en-gb', 'speed': 1.0, 'bitrate': 40}

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument('--voice', help='Kokoro voice id (default: the pack\'s, else bf_emma)')
p.add_argument('--name', help='display name shown in grown-up settings (default: the pack\'s, else Emma)')
p.add_argument('--lang', help='Kokoro language en-gb / en-us (default: the pack\'s, else en-gb)')
p.add_argument('--out', default='audio/emma', help='output folder, relative to the app (npm run voice passes the configured pack)')
p.add_argument('--speed', type=float, help='default: the pack\'s, else 1.0')
p.add_argument('--bitrate', type=int, help='MP3 kbit/s, mono (default: the pack\'s, else 40)')
p.add_argument('--force', action='store_true', help='re-record every line (needed to change voice, lang, speed or bitrate)')
p.add_argument('--limit', type=int, default=0, help='record at most N new lines (testing)')
p.add_argument('--shard', default='', help='i/n: record only every n-th new line starting at i (run several at once)')
p.add_argument('--threads', type=int, default=0, help='CPU threads for the voice model (0 = all)')
a = p.parse_args()

out = APP / a.out
index_file = out / 'index.json'
old = None
if index_file.exists():
    try:
        old = json.loads(index_file.read_text(encoding='utf-8'))
    except Exception:
        old = None

# Settings: a flag, else what the pack was recorded with, else the defaults.
recorded = {}
if old:
    recorded = {'voice': old.get('voice'), 'name': old.get('name'), 'lang': (old.get('lang') or '').lower() or None,
                'speed': old.get('speed'), 'bitrate': old.get('bitrate')}
for key, default in DEFAULTS.items():
    if getattr(a, key) is None:
        setattr(a, key, recorded.get(key) if recorded.get(key) is not None else default)

# One pack never mixes settings: changing the voice, language, speed or bitrate means recording
# every line again (--force). (Older packs don't store speed/bitrate; those were the defaults.)
clips_exist = any(out.glob('*.mp3'))
if old and clips_exist and not a.force:
    before = {'voice': recorded.get('voice'), 'lang': recorded.get('lang'),
              'speed': recorded.get('speed') if recorded.get('speed') is not None else DEFAULTS['speed'],
              'bitrate': recorded.get('bitrate') if recorded.get('bitrate') is not None else DEFAULTS['bitrate']}
    now = {'voice': a.voice, 'lang': a.lang.lower(), 'speed': float(a.speed), 'bitrate': int(a.bitrate)}
    diff = [k for k in now if before[k] is not None and (abs(float(before[k]) - now[k]) > 1e-9 if k == 'speed' else str(before[k]).lower() != str(now[k]).lower())]
    if diff:
        print(f'voice: {a.out} was recorded with ' + ', '.join(f'{k}={before[k]}' for k in diff)
              + '; this run asks for ' + ', '.join(f'{k}={now[k]}' for k in diff) + '.\n'
              + '  New lines would not match the old ones. Re-record every line with --force, or record into another --out folder.',
              file=sys.stderr)
        sys.exit(2)

# The recording stack is pinned in tools/voice/requirements.txt: a different phonemizer or espeak
# can pronounce words differently from the clips already in the pack.
def pins():
    req = Path(__file__).with_name('requirements.txt')
    found = {}
    if req.exists():
        for line in req.read_text(encoding='utf-8').splitlines():
            line = line.split('#', 1)[0].strip()
            if '==' in line:
                name, ver = line.split('==', 1)
                found[name.strip().lower()] = ver.strip()
    return found

def installed(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None

lines = json.loads((APP / 'tools/voice/lines.json').read_text(encoding='utf-8'))
out.mkdir(parents=True, exist_ok=True)

todo = [l for l in lines if a.force or not (out / l['file']).exists()]
if a.shard:
    i, n = (int(x) for x in a.shard.split('/'))
    todo = todo[i::n]
if a.limit:
    todo = todo[:a.limit]
print(f'voice: {len(lines)} lines, {len(todo)} to record with {a.voice} ({a.lang}, speed {a.speed}, {a.bitrate} kbit/s) -> {a.out}', flush=True)

if todo and clips_exist and not a.force:
    off = [f'{k} {installed(k) or "not installed"} (pinned {v})' for k, v in pins().items()
           if k in ('kokoro-onnx', 'phonemizer', 'espeakng-loader') and installed(k) != v]
    if off:
        print('voice: warning: the recording stack differs from tools/voice/requirements.txt: ' + '; '.join(off)
              + '. New clips may not sound like the old ones.', flush=True)

import numpy as np, lameenc  # noqa: E402  (after the cheap checks above)

def encode(samples, sr):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    enc = lameenc.Encoder()
    enc.set_bit_rate(a.bitrate); enc.set_in_sample_rate(sr); enc.set_channels(1); enc.set_quality(2)
    return enc.encode(pcm) + enc.flush()

def tidy(s, sr):
    """Trim leading/trailing silence (keep a little air) and even out loudness."""
    loud = np.flatnonzero(np.abs(s) > 0.012)
    if loud.size:
        pad = int(sr * 0.06)
        s = s[max(0, loud[0] - pad): min(len(s), loud[-1] + pad)]
    peak = float(np.max(np.abs(s))) if s.size else 0
    if peak > 0:
        s = s * (0.89 / peak)
    fade = min(len(s) // 4, int(sr * 0.01))
    if fade:
        s[:fade] *= np.linspace(0, 1, fade); s[-fade:] *= np.linspace(1, 0, fade)
    return s.astype(np.float32)

def speakable(text):
    return (text.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
                .replace('—', ', ').replace('–', '-'))

def write_atomic(path, data):
    tmp = path.with_name(path.name + '.part')
    tmp.write_bytes(data)
    os.replace(tmp, path)

if todo:
    from kokoro_onnx import Kokoro
    models = HOME / 'models'
    if not (models / 'kokoro-v1.0.onnx').exists() or not (models / 'voices-v1.0.bin').exists():
        print(f'voice: the Kokoro model files are missing in {models} (kokoro-v1.0.onnx, voices-v1.0.bin). See README "Voice".', file=sys.stderr)
        sys.exit(1)
    if a.threads:
        os.environ['OMP_NUM_THREADS'] = str(a.threads)
        import onnxruntime as ort
        so = ort.SessionOptions(); so.intra_op_num_threads = a.threads; so.inter_op_num_threads = 1
        k = Kokoro.from_session(ort.InferenceSession(str(models / 'kokoro-v1.0.onnx'), sess_options=so, providers=['CPUExecutionProvider']), str(models / 'voices-v1.0.bin'))
    else:
        k = Kokoro(str(models / 'kokoro-v1.0.onnx'), str(models / 'voices-v1.0.bin'))
    t0 = time.time()
    for i, l in enumerate(todo, 1):
        samples, sr = k.create(speakable(l['text']), voice=a.voice, speed=a.speed, lang=a.lang)
        write_atomic(out / l['file'], encode(tidy(np.asarray(samples, dtype=np.float32), sr), sr))
        if i % 50 == 0 or i == len(todo):
            el = time.time() - t0
            print(f'  {i}/{len(todo)}  {el:.0f}s elapsed, ~{el / i * (len(todo) - i):.0f}s left', flush=True)

# index: every line that has a clip; remove clips no line uses (a clip another --shard run is
# writing right now belongs to a line, so it is kept) and leftovers of an interrupted write.
index = {l['key']: l['file'] for l in lines if (out / l['file']).exists()}
wanted = {l['file'] for l in lines}
removed = 0
for f in out.glob('*.mp3'):
    if f.name not in wanted:
        f.unlink(); removed += 1
for f in out.glob('*.part'):
    if time.time() - f.stat().st_mtime > 120:  # never one that a parallel shard is writing
        f.unlink()
engine = f"kokoro-onnx {installed('kokoro-onnx') or '?'} / kokoro-v1.0"
write_atomic(index_file, json.dumps({
    'schema': 'voice-pack/1', 'voice': a.voice, 'name': a.name,
    'lang': 'en-GB' if a.lang.lower() == 'en-gb' else 'en-US',
    'speed': a.speed, 'bitrate': a.bitrate,
    'engine': engine, 'lines': dict(sorted(index.items())),
}, ensure_ascii=False, indent=0).encode('utf-8'))

silence = APP / 'audio/silence.mp3'
if not silence.exists():
    write_atomic(silence, encode(np.zeros(6000, dtype=np.float32), 24000))

size = sum(f.stat().st_size for f in out.glob('*.mp3'))
print(f'voice: {len(index)}/{len(lines)} lines recorded, {removed} unused clip(s) removed, {size / 1048576:.1f} MB in {a.out}')
missing = len(lines) - len(index)
sys.exit(1 if missing else 0)
