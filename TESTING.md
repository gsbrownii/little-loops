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

The app now speaks with a **recorded voice (Emma)** shipped as small MP3 clips, so the device's
own text-to-speech is only a fallback. Check these first:

- 🔴 **Recorded voice plays after the start tap** on iPad Safari, the installed iPad app,
  Android Chrome and Fire/Silk: the home screen should say "Pick a game! Tap a picture." in
  Emma's (British) voice, not a device voice. Check it again after 10+ minutes idle, after the
  app was in the background and after the screen locked (the moments iOS may withdraw the
  permission the start tap gave the app's 3 audio players).
- 🔴 **Is iOS using the normal player?** On iPad Safari and the installed iPad app, connect
  Safari's Web Inspector (Mac: Develop menu) and run
  `(await import(new URL('js/core/speech.js', document.baseURI).href)).speech.stats`
  after a session: `webAudio` should stay 0 through normal use, after coming back from the
  background, after a Siri request or a declined phone call, and with the silent switch on.
  Above 0 means the device used the Web Audio fallback: note the iOS version, and watch the
  Memory timeline over about 20 Loop Machine rounds (the fallback keeps only a few clips).
- 🔴 **iPhone/iPad silent switch and volume:** recorded clips play as media, so they should
  be heard with the ring/silent switch on. Check the volume balance against sound effects.
  (On iOS 16 and older, the Web Audio fallback and sound effects follow the switch.)
- 🔴 **Offline:** in airplane mode, every game still speaks in Emma's voice (the clips are
  cached on the first visit; that first visit downloads about 11 MB, so do it on Wi-Fi). In
  the installed iOS app, Web Inspector should show the clips answered with 206 by the Service
  Worker; check after a reboot too.
- 🔴 **Short first visit, then offline:** open the site once on a slow or cellular connection,
  close it after about a minute, switch to airplane mode and launch from the icon. Lines whose
  recordings arrived are in Emma's voice, the rest in a device voice, and nothing is ever
  silent. Go online and start once more: later, offline, everything is Emma. On iPad, also
  check an update that was downloaded on a flaky network and is applied at an offline launch.
- 🔴 **Interruptions (iOS):** with a game open, trigger a Siri request, an alarm or timer, or
  an incoming call you decline, without leaving the app. Then tap the speaker button and finish
  a round: the instruction is heard (Emma or a device voice), the speaker stops glowing, and
  queued lines like "Play again, or pick a machine." still play. Repeat after returning from
  the background and with the silent switch on. (Headless Chrome can't reproduce this.)
- 🟡 **Nothing talks in the background:** leave the app right after tapping Play on a robot
  puzzle, or right after a correct Loop Machine answer (switch tabs on desktop, Home button on
  Android or the installed app, lock the screen on iPad). Nothing should talk while away, not
  even a device voice. On return the caption shows and is said again, and the next lines speak
  normally. Pressing Home or locking mid-line stops the voice at once. On iPad, a line due at
  the moment you return is heard and not clipped.
- 🟡 **Slow network, quick taps:** on a first visit over a throttled network (iOS Network Link
  Conditioner "3G" or "Very Bad Network", Android Chrome remote-debugging throttling, toggling
  offline mid-line), tap through screens quickly. The new screen's instruction is never held up
  by the previous line, no old line plays on the new screen, a line is never heard twice or in
  two voices at once, and Home, hiding the app and the speaker button silence everything.
- 🟡 **Latency:** time from a tap to the voice for a line not heard before, and the gaps inside
  multi-part lines ("Is it … lake, … or cat?", "Great job!" then the next line), with Low Power
  Mode off and on. A pause of about 4 seconds before each part means iOS isn't preloading clips.
- 🟡 The speaker button after every robot win says "<praise> Tap the green arrow for the next
  puzzle!" in Emma's voice (both halves), and on every other screen too; also with the silent
  switch on.
- 🟡 With **Read word answers aloud** on (grown-up settings), play several Big and Super
  word-order rounds: "The words are: …" is always all in Emma's voice, also offline.
- 🟡 Voice speed Slow / Fast in grown-up settings changes the clips' speed without making
  them sound squeaky or deep (Safari keeps the pitch; only the Web Audio fallback changes it).
- 🟡 Lines are never cut off or overlapping when tapping quickly, and nothing keeps talking
  after leaving a game.
- 🟡 Picking a device voice in grown-up settings switches everything to that voice; picking
  "Emma" switches back.
- 🟡 Android Chrome and Fire/Silk with data saver or battery saver on: clips still preload and
  the voice still finishes downloading for offline use.
- 🟡 Plain Safari (not installed): after about 7 days unused, Safari may delete the cached
  clips; the next visit downloads them again (about 11 MB). Installed apps are usually exempt.
- 🟡 **Bluetooth headphones or speaker** (AirPods, a car or kids' headset) on iPad and Android:
  the first word of a line after a quiet spell is not cut off, and the parts of a multi-part
  line ("Is it … lake, … or cat?") don't lose their first syllable or come with long gaps.
- 🟡 **Music and media controls:** start the app while music or a podcast plays. Note whether
  it pauses (expected on iOS, where the app's audio takes over) and tell parents. After a few
  lines, check the iOS lock screen / Control Center and the Android notification shade: there
  should be no leftover "Now Playing" player for Little Loops, and pressing play there must not
  make the app talk in the background.

Device text-to-speech (used only for unrecorded lines or when a grown-up picks a device voice):

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
- 🔴 **Cold launch on a low-end tablet** (Fire 7, an older Android tablet), with the voice fully
  cached: force-stop the installed app and launch it again. The start screen should appear in
  about a second, and the first line should start without a noticeable delay.
- 🟡 **Slow first install:** throttle to about 300 kbps (or add over a second of latency per
  request) and watch the server or proxy log: each voice clip is downloaded once, and the
  number of cached clips keeps growing after the app is installed until all are there. On iOS,
  also check that missing clips get filled in over the next launches (WebKit may stop the
  service worker sooner), and that sending the app to the background during the first install
  leaves an app that still opens offline.
- 🟡 **Storage:** `navigator.storage.estimate()` shows about 12 MB once installed (about 24 MB
  for a moment during an update). An update over cellular downloads only the changed clips.
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
