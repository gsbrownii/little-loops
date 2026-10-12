# Little Loops

Playful coding and thinking games for kids. Little ones (4–7) need no reading: every
instruction is spoken aloud, everything is tap or drag, and mistakes just get a gentle
"try again" and a hint. Loop Machine stretches up to age 12 with harder tiers.

- **Robot Puzzles**: drag arrow cards into a command strip, press Play, and guide the robot to
  the star. 15 levels. Levels 1–9 teach sequencing; 10–15 add obstacles and **repeat ×2 / ×3**
  cards (loops). When the robot goes wrong it stops right there so the child can debug, and a
  hint path appears after 2 misses.
- **Coloring**: build a picture from 6 animals × 6 accessories × 6 backgrounds (216
  combinations), then tap-to-fill with 12 colors and undo. **Print** (behind the parent gate)
  makes a clean full-page outline for paper coloring.
- **Loop Machine** (ages 4–12): a machine runs a "loop" (a pattern, number rule or word puzzle)
  and the child picks what goes in the **?** box. Three machines: Little ★ (4–6, no
  reading), Big ★★ (7–9), Super ★★★ (10–12, actually tricky: square numbers, Fibonacci,
  analogies, homophones, sentence building). 146 puzzles; 10-round sessions with gold and
  silver stars.
- **Story Movie** and **Builder**: shown as "coming soon".

**Privacy:** no accounts, no ads, no analytics, and the app itself makes no network calls. A
Content-Security-Policy blocks anything off-site. Progress is saved only in the device's
browser storage. After the first visit the whole app works offline. Spoken instructions use a
recorded voice that ships with the app (see [Voice](#voice)), so they stay on the device too.
Only if a grown-up picks a device voice marked "needs internet" does the browser send spoken
words to that voice's provider.

---

**Live:** <https://gsbrownii.github.io/little-loops/> (GitHub repository
[gsbrownii/little-loops](https://github.com/gsbrownii/little-loops)).

## Run it on your computer

Any static web server works. The included one needs only [Node.js](https://nodejs.org) 22+
(no `npm install`; there are zero dependencies):

```bash
npm start
```

Then open <http://localhost:8080/>. To test the GitHub Pages sub-path setup
(`/little-loops/`), use `npm run start:subpath` and open <http://localhost:8080/little-loops/>.

> Service workers (offline mode) and installing only work on `https://` or `localhost`.
> To try it on a real tablet, deploy to GitHub Pages (below). That's the easiest way to
> get HTTPS.

> **Seeing your edits:** the local copy uses the offline cache too, so after you change any
> file (a level, art, a puzzle or code) a normal reload still shows the old version. Run
> `npm run precache`, then reload and wait a moment on the start screen: the app swaps in the
> new version by itself (reload once more if you went into a game too quickly). A hard reload
> (Ctrl+Shift+R) shows your edits for that one load only; the next normal reload goes back to
> the cached copy until you run precache.

## Deploy to GitHub Pages

1. **Prepare** (every time you change anything). The service worker's cache version is a
   hash of all app files, so it must be regenerated after any edit (to see the change locally
   too), or returning visitors won't get the update:
   ```bash
   npm run precache
   ```
   ```bash
   npm run validate
   ```
   ```bash
   npm test
   ```
   If any of these reports ERROR, STALE or FAILED, don't publish. Copy the failing lines and
   ask a developer.
2. **Create a repository** on GitHub, e.g. `little-loops`. Pages is free for public
   repositories; a private one needs a paid plan.
3. **Upload the files.** Put the *contents* of this folder at the repository root, so that
   `index.html` is at the top level. Either:
   - **Git:**
     ```bash
     git init && git add . && git commit -m "Little Loops" && git branch -M main
     ```
     ```bash
     git remote add origin https://github.com/YOUR-NAME/little-loops.git && git push -u origin main
     ```
   - **No git:** on the repository page choose **Add file → Upload files** and drag in
     everything in this folder (including the hidden `.nojekyll` file), then **Commit**.
4. **Turn on Pages:** repository **Settings → Pages → Build and deployment → Source:
   "Deploy from a branch" → Branch: `main` / `(root)` → Save**.
5. After about a minute the app is live at `https://YOUR-NAME.github.io/little-loops/`.
   Open it once while online; after that it works offline.

**Updating later:** edit; if you changed anything the app says (levels, puzzles, phrases), run
`npm run voice` (see [Voice](#voice)); then `npm run precache`, `npm run validate` and
`npm test`; then commit and push:
```bash
git add -A && git commit -m "Describe the change" && git push
```
(Or upload the changed files plus `sw.js` on GitHub.) Devices pick up the new version the next
time the app is on its start or home screen. It never reloads in the middle of a game.

`.nojekyll` tells GitHub Pages to serve the files as-is. The app uses only relative URLs, so
it works at any sub-path or on a custom domain.

## Put it on a tablet

- **iPad / iPhone (Safari):** open the site → **Share** → **Add to Home Screen**.
- **Android (Chrome):** open the site → **⋮** menu → **Install app** (or *Add to Home
  screen*). The grown-up settings screen also shows an **Install** button when the browser
  offers one.
- Open it once online and leave it on the start or home screen for a minute or two (on Wi-Fi: the
  recorded voice is about 10 MB) so everything is cached; then airplane mode is fine. If it was
  closed sooner, the app still works offline and any line whose recording did not arrive yet is
  spoken by the device voice; the next online start downloads the rest.
- Tip: iOS **Guided Access** or Android **screen pinning** keeps kids inside the app.

## Grown-up settings

Tap the **gear** on the home screen, then **press and hold the yellow button for 3 seconds**
(the parent gate; it also protects **Print** in Coloring). Settings:

- Spoken instructions on/off, voice speed, and the voice: **Emma** (the recorded Little Loops
  voice, the default) or any voice built into the device. Device voices marked "needs
  internet" won't work offline.
- Sound effects on/off.
- Robot Puzzles: **Unlock all puzzle levels**.
- Loop Machine: **Read word answers aloud** (for kids who can't read the Big/Super answers yet).
- Install app, **Reset progress** (keeps these settings), privacy note.

## Project layout

```
index.html  manifest.webmanifest  sw.js  .nojekyll
css/base.css                     shared look: buttons, top bar, home, parent gate, print
js/app.js                        start screen, home, router, module loader
js/core/                         speech, sound, storage, drag & drop, parent gate, celebration…
js/modules/robot/                Robot Puzzles   (logic.js = the pure rules)
js/modules/coloring/             Coloring        (scene.js = the pure SVG renderer)
js/modules/machine/              Loop Machine    (tokens.js = picture/number/word tokens)
data/app.json                    which games appear on the home screen
data/robot/levels.json           the 15 robot levels
data/coloring/*.json             animals, accessories, backgrounds (line art as shape data)
data/machine/rounds.json         the Loop Machine puzzle bank
schemas/                         JSON Schemas for every content file
art/  icons/                     mascot, home tiles, app icons
audio/emma/                      the recorded voice: one small MP3 per spoken line + index.json
tools/                           local server, validators, precache, icons, tests (not deployed to the cache)
docs/ARCHITECTURE.md             module contract + specs for each game
docs/CONTENT-FORMAT.md           every content format, for people and for AI generators
TESTING.md                       what still needs checking on real tablets
```

## Content is data (ready for an AI content feature)

Every level, art part and puzzle is JSON, separate from the code, with a JSON Schema in
`schemas/` and a validator. A future AI feature can generate new files in the same format,
check them with `node tools/validate.mjs --root <folder>`, and drop them in. The renderers
sanitize everything, so bad or malicious content can't inject markup. See
`docs/CONTENT-FORMAT.md`.

To add **Story Movie** or **Builder**, follow "Future modules" in `docs/ARCHITECTURE.md`. A
draft story format already exists in `schemas/story.schema.json`.

## Voice

Everything the app says is pre-recorded in a natural voice (**Emma**, a British English voice
from the free, open-source [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) text-to-speech
model), so it sounds the same on every device and works offline. The clips (about 1,300 short
MP3s, about 10 MB) live in `audio/emma/`. A line without a recording, such as a newly added
puzzle, is spoken by the device's own voice until it is recorded, so new content never breaks.

**After changing anything the app says**, record the new lines (only new or changed lines are
recorded, in the voice pack `js/config.js` points at, with that pack's voice and settings), then
refresh the offline cache:
```bash
npm run voice
```
```bash
npm run precache
```
`npm run validate` warns if any line is missing a recording, or if clips are no longer used
(the next `npm run voice` removes those).

**One-time setup** on a new computer: Python 3.11, 3.12 or 3.13 (3.12 recorded the current
pack; the pinned kokoro-onnx 0.6.1 does not install on 3.14+), about 400 MB, kept outside this
folder (set `LL_VOICE_HOME` to use another folder). The exact package versions are pinned in
`tools/voice/requirements.txt`, so new lines are pronounced like the old ones.
- **Windows** (folder `%LOCALAPPDATA%\little-loops-voice`):
  ```bash
  py -3.12 -m venv "$LOCALAPPDATA/little-loops-voice/venv"
  ```
  ```bash
  "$LOCALAPPDATA/little-loops-voice/venv/Scripts/python" -m pip install -r tools/voice/requirements.txt
  ```
- **macOS / Linux** (folder `~/.local/share/little-loops-voice`):
  ```bash
  python3.12 -m venv ~/.local/share/little-loops-voice/venv
  ```
  ```bash
  ~/.local/share/little-loops-voice/venv/bin/python -m pip install -r tools/voice/requirements.txt
  ```

Then download `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx
[releases page](https://github.com/thewh1teagle/kokoro-onnx/releases) ("model-files-v1.0")
into the `models` folder next to `venv` (e.g. `%LOCALAPPDATA%\little-loops-voice\models\`).

**A different voice:** record a complete new pack into its own folder, e.g.
`npm run voice -- --voice af_heart --name Heart --lang en-us --out audio/heart` (about 45
minutes), point `voicePack` in `js/config.js` at `audio/heart/index.json`, delete the old
`audio/emma` folder, then run `npm run precache`. From then on a plain `npm run voice` records
new lines into `audio/heart` with that voice. (`npm run voice` refuses to change the voice,
language, speed or bitrate of an existing pack unless `--force` re-records every line, so one
pack never mixes two voices.)

## Scripts

| command | what it does |
|---|---|
| `npm start` | local server on port 8080 |
| `npm run start:subpath` | same, under `/little-loops/` like GitHub Pages |
| `npm run validate` | checks all content (including every spoken line), the registry, schemas and the offline cache list |
| `npm run validate:levels` / `validate:art` / `validate:machine` | one content type in detail |
| `npm run precache` | regenerate `sw.js`; run after every edit (to see it locally) and before every deploy |
| `npm run precache:check` | fail if `sw.js` is out of date |
| `npm run icons` | re-render the PNG icons from `icons/icon.svg` |
| `npm run voice` | record any new spoken lines in the voice pack set in `js/config.js` (Emma; see [Voice](#voice)) |
| `npm run voice:check` | fail if any spoken line has no recording |
| `npm test` | end-to-end smoke test in headless Chrome (all games, offline, sub-path, layouts) |
| `node tools/render-coloring.mjs --sheet combos` | preview coloring art (writes `coloring-combos.png` to your temp folder and prints the path; never write previews into this folder, or they get uploaded) |

The tools need Node 22+ and Chrome or Edge (found automatically; set `CHROME_PATH`
otherwise). Running the server directly in Git Bash on Windows? Write the sub-path without
a leading slash (`node tools/serve.mjs 8080 --base little-loops`): Git Bash turns
`/little-loops/` into a Windows folder path.

## Renaming the app

Change the name in `js/config.js` (`name` only), `index.html` (`<title>`,
`apple-mobile-web-app-title` and the `<noscript>` message) and `manifest.webmanifest` (`name`,
`short_name`). Then run `npm run precache`. **Never change `storageKey`** in `js/config.js`:
it is where every family's stars and pictures are saved, so changing it erases their progress.
