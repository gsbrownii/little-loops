#!/usr/bin/env python3
"""Record the Little Loops voice pack with Kokoro (open-source neural text-to-speech, runs offline).

    npm run voice            # = node tools/voice-lines.mjs && python tools/voice/make_voice.py

Reads tools/voice/lines.json (written by tools/voice-lines.mjs), records every line that has no
clip yet into audio/<name>/<sha>.mp3, writes audio/<name>/index.json (normalized text -> clip),
deletes clips no longer used, and makes audio/silence.mp3 (used to unlock audio on iOS).
Only new or changed lines are recorded, so re-running after a content change is quick.

One-time setup (about 400 MB, outside the app folder; see README "Voice"):
    python -m venv %LOCALAPPDATA%/little-loops-voice/venv
    %LOCALAPPDATA%/little-loops-voice/venv/Scripts/pip install kokoro-onnx soundfile lameenc
    download kokoro-v1.0.onnx and voices-v1.0.bin from
    https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0) into
    %LOCALAPPDATA%/little-loops-voice/models/
Set LL_VOICE_HOME to use another folder. Kokoro (Apache-2.0) voices may be used freely.
"""
import argparse, json, os, sys, time
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
HOME = Path(os.environ.get('LL_VOICE_HOME') or Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'little-loops-voice')

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument('--voice', default='bf_emma', help='Kokoro voice id (default bf_emma)')
p.add_argument('--name', default='Emma', help='display name shown in grown-up settings')
p.add_argument('--lang', default='en-gb', help='Kokoro language (en-gb / en-us)')
p.add_argument('--out', default='audio/emma', help='output folder, relative to the app')
p.add_argument('--speed', type=float, default=1.0)
p.add_argument('--bitrate', type=int, default=40, help='MP3 kbit/s (mono)')
p.add_argument('--force', action='store_true', help='re-record every line')
p.add_argument('--limit', type=int, default=0, help='record at most N new lines (testing)')
p.add_argument('--shard', default='', help='i/n: record only every n-th new line starting at i (run several at once)')
p.add_argument('--threads', type=int, default=0, help='CPU threads for the voice model (0 = all)')
a = p.parse_args()

import numpy as np, lameenc
from kokoro_onnx import Kokoro

lines = json.loads((APP / 'tools/voice/lines.json').read_text(encoding='utf-8'))
out = APP / a.out
out.mkdir(parents=True, exist_ok=True)

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

todo = [l for l in lines if a.force or not (out / l['file']).exists()]
if a.shard:
    i, n = (int(x) for x in a.shard.split('/'))
    todo = todo[i::n]
if a.limit:
    todo = todo[:a.limit]
print(f'voice: {len(lines)} lines, {len(todo)} to record with {a.voice} -> {a.out}', flush=True)

if todo:
    models = HOME / 'models'
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
        tmp = out / (l['file'] + '.part')
        tmp.write_bytes(encode(tidy(np.asarray(samples, dtype=np.float32), sr), sr))
        os.replace(tmp, out / l['file'])
        if i % 50 == 0 or i == len(todo):
            el = time.time() - t0
            print(f'  {i}/{len(todo)}  {el:.0f}s elapsed, ~{el / i * (len(todo) - i):.0f}s left', flush=True)

# index: every line that has a clip; remove clips nobody uses
index = {l['key']: l['file'] for l in lines if (out / l['file']).exists()}
used = set(index.values())
removed = 0
for f in out.glob('*.mp3'):
    if f.name not in used:
        f.unlink(); removed += 1
(out / 'index.json').write_text(json.dumps({
    'schema': 'voice-pack/1', 'voice': a.voice, 'name': a.name,
    'lang': 'en-GB' if a.lang.lower() == 'en-gb' else 'en-US',
    'engine': 'kokoro-v1.0', 'lines': dict(sorted(index.items())),
}, ensure_ascii=False, indent=0), encoding='utf-8', newline='\n')

silence = APP / 'audio/silence.mp3'
if not silence.exists():
    silence.write_bytes(encode(np.zeros(6000, dtype=np.float32), 24000))

size = sum(f.stat().st_size for f in out.glob('*.mp3'))
print(f'voice: {len(index)}/{len(lines)} lines recorded, {removed} unused clip(s) removed, {size / 1048576:.1f} MB in {a.out}')
missing = len(lines) - len(index)
sys.exit(1 if missing else 0)
