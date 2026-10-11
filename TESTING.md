# Testing on real tablets

Automated checks (`npm test`, `npm run validate`) run in headless Chrome on a desktop. They
cover logic, layout at many screen sizes, offline mode and the sub-path deploy. They **can't**
cover real touch screens, real speech voices, printers, iOS Safari or how kids actually
play. Deploy to GitHub Pages (HTTPS) first, then work through this list.

**Suggested devices:** an iPad (Safari, also installed to the Home Screen), an Android tablet
(Chrome), a small Android phone (~360 px wide), and if possible an **Amazon Fire** tablet
(Silk browser), since many kids use those.

Legend: 🔴 = most likely to need a fix · 🟡 = worth checking · 👶 = needs a real child

---

## 1. Speech (spoken instructions)

- 🔴 **First tap unlocks speech.** After pressing the big green ▶ on the start screen, the
  home screen should say "Pick a game! Tap a picture." Try iPad Safari, the installed iPad
  app, Android Chrome and Fire/Silk. Silk's speech support is the biggest unknown.
- 🔴 **Offline voices.** In airplane mode, do instructions still speak? On Android a voice
  must be downloaded (Settings → Accessibility → Text-to-speech → install voice data). In the
  app's grown-up settings, voices marked "needs internet" won't work offline.
- 🔴 **Silent switch / mute (iPhone and iPads with a switch).** Sounds are set to play even
  in silent mode (iOS 17+) because instructions are essential. Check that this happens and
  that parents are OK with it; on iOS 16 and older, effects may be silent.
- 🟡 After the app goes to the background and comes back (or the screen locks), does speech
  still work? iOS sometimes stops speech until a reload.
- 🟡 The replay (speaker) button on every screen repeats the instruction, and it glows while
  speaking.
- 🟡 Speech timing: on robot levels, the instruction and the "Up!", "Right!" card names
  shouldn't cut each other off awkwardly; each level's spoken intro (levels 3, 5, 6, 10, 11
  and 13 introduce new cards or ideas) is heard fully before card names like "Up!" interrupt it.
- 🟡 After every screen change (home → game, level → next level, round → next round, wizard
  step → next step), the first spoken instruction is actually heard, not clipped or dropped.
- 🟡 Fire/Silk and Android: in grown-up settings, check which voice is picked by default. It
  should be a built-in voice (not marked "needs internet"), so instructions still speak offline.
- 🟡 Voice speed Slow / Normal / Fast, and the voice picker, in grown-up settings.
- 🟡 Speech vs sound-effect volume balance at typical tablet volume.

## 2. Touch: drag & drop and taps

- 🔴 **Robot Puzzles drag:** dragging arrow cards into the strip on iPad and Android. The
  page must not scroll or bounce, nothing gets selected, and no magnifier or "Copy" callout
  appears. The dragged card floats ~28 px above the finger (so it's visible); check that
  dropping still lands where the finger is.
- 🔴 **Repeat blocks (levels 13–15):** can 4–5 year olds drag two arrows into one repeat
  block on a phone? The inner slots are 64 px but close together. 👶
- 🔴 **Parent gate:** press and hold 3 seconds. On iPad, a long press must not trigger text
  selection, haptic-touch menus or the magnifier. On Android, no context menu or vibration
  should cancel it. The ring fills, turns green with a ✓, and **opens when the finger lifts**.
- 🟡 Two fingers / a palm on the screen while dragging (only the first finger counts),
  Apple Pencil.
- 🟡 Dragging near screen edges: in Safari (not the installed app) a swipe from the left
  edge goes "back"; Android gesture navigation edges.
- 🟡 Loop Machine: tapping answers, and dragging an answer onto the **?** box; word-order
  rounds (tap words into slots).
- 🟡 Taps never double-fire (no double counting of answers, cards or fills). Double-tap
  never zooms the page.
- 🟡 A fast double tap on any button (start ▶, a home tile, Play, Next, Back/Home, a level
  number, the celebration's buttons) acts only once and never triggers something on the screen
  that opens next.

## 3. Coloring

- 🔴 **Small areas on phones:** can a child hit inner ears, cheeks, crown jewels and the
  dinosaur's spikes? There's tap assistance, plus a movement allowance of about 20 px or 5%
  of the picture so a wobbly tap still paints. Check that it feels right and doesn't paint
  the wrong area. 👶
- 🔴 **Print, iPad:** Print → hold the gate → the iOS print sheet (AirPrint)
  must open. Check it also works from the **installed** Home Screen app, where print support
  varies by iOS version. The preview must show only the black outline, one page, nothing cut
  off, on Letter and A4. If a "Ready! Tap to print." card with a big printer button appears
  instead of the print sheet, tap the printer: the print sheet must open (check Safari and the
  installed app). The card's ✕ or a tap outside it must close it without printing.
- 🔴 **Print, Android:** Chrome → print → Save as PDF / a Mopria printer: one page, outline only.
- 🟡 Fire tablets may not offer printing at all; the button should then do nothing harmful.
- 🟡 Undo, New picture, "surprise me" dice.
- 🟡 Colors are kept after closing the app: reopen it from the Home Screen icon, open
  Coloring, and tap the brush (**Keep painting**, the first button in the top bar); all the
  colors must be back. (A browser tab that reopens on the painting screen shows the painting
  straight after ▶.)
- 🟡 A new picture never loses the last painting: finish the 3 picks (or tap the dice, even
  several times) and the new picture starts blank; going back and tapping the brush before
  painting it brings the colored picture back. Only the last colored picture is kept:
  painting the new one and then starting another replaces it.
- 🟡 The selected color's ring isn't cramped at 360 px width.

## 4. Layout & screens

- 🟡 Rotate the device **during** a game (mid robot run, mid coloring, mid Loop Machine
  round): nothing is lost and the layout re-fits.
- 🟡 iPad **Split View / Slide Over** (narrow windows), iPad mini, 12.9″ iPad Pro, Fire HD 8
  (1280×800), small Android phones (360×640), notched phones in landscape (safe areas).
- 🟡 Safari's address bar showing and hiding (in the browser, not installed) must not cut
  off the bottom buttons.
- 🟡 On the smallest phones a very long robot program may make the command strip scroll
  inside itself. Check that kids can still reach every card.
- 🟡 Loop Machine Super tier: 8-word sentences and word "sets" fit and are readable.

## 5. Install, offline & updates (PWA)

- 🔴 **Install:** iPad Add to Home Screen (icon, name "Little Loops", opens full-screen
  without Safari bars). Android Install app: check the icon under the launcher's mask
  (circle/squircle) and the splash screen.
- 🔴 **Offline:** after one online visit, turn on airplane mode, launch from the home-screen
  icon, and open all three games.
- 🟡 **Updates:** deploy a change (remember `npm run precache`), then reopen the installed
  app. It should reload into the new version on the start or home screen, never mid-game.
  Installed iOS apps are often resumed rather than restarted, so updates may arrive only after
  returning to the home screen or a cold start.
- 🟡 iOS shows a brief plain screen on launch (no custom launch images).
- 🟡 Opening `…github.io/little-loops` **without** the trailing slash while offline won't
  load; the installed app always uses the right address.
- 🟡 **Progress persistence:** stars and pictures survive closing the app and a few days
  without use. Safari can clear storage of sites not used for 7 days; installed apps are
  usually exempt.

## 6. Performance on older devices

- 🟡 Low-end tablets (Fire 7, iPad 6th gen): robot animation smoothness, the celebration
  confetti, Loop Machine animations, how fast a tap fills a color, the screen-fitting pass when
  a robot level opens or the device rotates.

## 7. Play-testing with kids 👶

- Do 4-year-olds discover dragging on their own (an animated "ghost card" demo appears after
  7 s of no activity), and do they understand Play?
- Does the **repeat card** click at level 10? Do the hint dots help after 2 misses?
- Robot difficulty curve: where do kids get stuck or bored?
- Loop Machine: is Little ★ doable for 4–5s without reading? Is Super ★★★ a fun challenge
  for 10–12s rather than frustrating? Note any puzzles kids argue have two right answers.
- Coloring: do they get the animal → accessory → place steps? Is the print outline good for
  crayons?
- Watch for anything that feels like "failing", any confusing screen, and anything that
  needs reading for the youngest kids.

## 8. Accessibility & grown-ups

- 🟡 With *Reduce Motion* on (iOS/Android), animations calm down but games still make sense.
- 🟡 Grown-up settings are readable; "Reset progress" asks first, then keeps the settings.
- 🟡 VoiceOver/TalkBack: buttons have labels (helpful for parents and assistive tech).

---

### Reporting problems

Note the device, OS version, browser (or "installed app"), the game/level/round, and what
happened. A screenshot or screen recording helps a lot.
