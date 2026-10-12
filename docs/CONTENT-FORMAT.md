# Little Loops - Content Format Reference

This is the reference for every content file in Little Loops: what each field means, the
coordinate systems, the rules the game applies, and how to add content safely. It is written
for two readers:

- **people** editing levels and art by hand, and
- **an AI content generator** that will produce new levels, art parts, Loop Machine rounds and
  (later) stories.
  Give it this document plus the matching JSON Schema from `schemas/`, then run the validators
  on whatever it produces and feed any `ERROR` lines back to it.

All content is plain JSON under `data/`. Rendering code never hard-codes content, so a new file
that passes the validators simply works. Renderers also sanitize at runtime (numbers coerced,
path data whitelisted), so bad content cannot inject markup. That runtime check is a safety net,
not a gate: **only ship content that passes `node tools/validate.mjs`**. A broken coloring part
(or Loop Machine round) is skipped at runtime with a console warning and the screen still opens
with the rest, but it silently disappears from the game; robot level fields are clamped to safe
defaults instead of rejected. Only `node tools/validate.mjs` reports these as errors.

Contents

1. [Files at a glance](#1-files-at-a-glance)
2. [Rules for every file](#2-rules-for-every-file)
3. [Coordinate systems](#3-coordinate-systems)
4. [Coloring parts](#4-coloring-parts-coloring-parts1)
5. [Robot levels](#5-robot-levels-robot-levels1)
6. [Loop Machine rounds](#6-loop-machine-rounds-machine-rounds1)
7. [Module registry](#7-module-registry-app-registry1)
8. [Story Movie (DRAFT)](#8-story-movie-draft-story-draft1)
9. [Builder (format TBD)](#9-builder-format-tbd)
10. [How to add new content safely](#10-how-to-add-new-content-safely)
11. [Tools](#11-tools)

---

## 1. Files at a glance

| File | Format id (`"schema"`) | JSON Schema | Checked by | Loaded by |
|---|---|---|---|---|
| `data/app.json` | `app-registry/1` | `schemas/app-registry.schema.json` | `tools/validate.mjs` | `js/app.js` (home tiles, routes) |
| `data/robot/levels.json` | `robot-levels/1` | `schemas/robot-levels.schema.json` | `tools/validate-levels.mjs` | `js/modules/robot/levels.js` |
| `data/coloring/animals.json` | `coloring-parts/1` (`kind: animal`) | `schemas/coloring-parts.schema.json` | `tools/validate-art.mjs` | `js/modules/coloring/parts.js` |
| `data/coloring/accessories.json` | `coloring-parts/1` (`kind: accessory`) | same | same | same |
| `data/coloring/backgrounds.json` | `coloring-parts/1` (`kind: background`) | same | same | same |
| `data/machine/rounds.json` | `machine-rounds/1` | `schemas/machine-rounds.schema.json` | `tools/validate-machine.mjs` | `js/modules/machine/machine.js` |
| `data/stories/stories.json` (future) | `story-draft/1` | `schemas/story.schema.json` (DRAFT) | `tools/validate.mjs` | nothing yet |

`node tools/validate.mjs` runs everything: JSON parsing of every `data/**/*.json`, the registry
checks, the level, Loop Machine and art validators, story cross-references, schema conformance
of every file, a check that the offline cache list is current, and the spoken-text rules of
section 2 across every file.

**The folder decides the format.** Every JSON file in `data/robot/` is checked as
`robot-levels/1`, in `data/coloring/` as `coloring-parts/1`, in `data/machine/` as
`machine-rounds/1`, in `data/stories/` as `story-draft/1`, and `data/app.json` as
`app-registry/1`, whatever its `"schema"` field says; a different or missing value there is an
**error** (so a typo such as `"robot-level/1"` cannot switch the checks off). A file elsewhere in
`data/` is checked by the schema whose format its `"schema"` field names. The app loads only the
files in the table; any other file in those folders (except `data/stories/`, which nothing
loads yet) gets a warning ("checked but not used").

**Errors vs warnings.** An `ERROR` means the content is rejected; fix it. A `WARNING` means it
works but deserves a look (style, size, layout). `tools/validate.mjs` reports every schema
violation as an error; the dedicated validators reject the same things and check more (geometry,
game rules, cross-references) than a schema can express.

## 2. Rules for every file

- UTF-8 JSON without a byte-order mark, 2-space indentation preferred. No comments in JSON.
- Every file starts with `"schema"`: the format id and version from the table above. An optional
  `"$schema"` key (before it) may point at the schema file for editor autocompletion (ignored by
  the app), e.g. `"$schema": "../../schemas/coloring-parts.schema.json"`.
- **Strict keys.** Only the fields documented here are allowed; unknown keys are errors (they
  usually mean a typo, e.g. `"widht"`).
- **Numbers are JSON numbers**, never strings (`12`, not `"12"`). Round coordinates to 1-2 decimals.
- **Ids** are lowercase letters, digits and dashes (`party-hat`, `r07`). Ids are save keys:
  progress and saved pictures refer to them, so **never rename, reuse or delete a published id**.
  New content gets new ids.
- **Spoken text** (`say`, `hint`, `explain`, `lockedSay`, story lines) is read aloud by
  text-to-speech because the players cannot read: one short, warm sentence, no symbols, emoji or
  markup (`< > { }`). **110 characters is a hard limit** (error: longer utterances get cut off);
  **15 simple words** is the guideline (the validators warn above it). Never scold: no "wrong",
  "fail" or "bad" aimed at the child.
- **Language.** All spoken and on-screen text (`say`, `hint`, `explain`, `lockedSay`, titles,
  part names, story lines, word-puzzle words) is **US English**: color, center, gray, favorite,
  mom, math. In word puzzles the spelling is the answer, so it must be US spelling.
- **Who checks the text rules.** `node tools/validate.mjs` enforces them for all content (its
  "Spoken text" section, plus each module's own checks): an **error** for `< > { }` or an emoji in
  a spoken line, a **warning** above 15 words, for scold words (only a warning, because "wrong"
  or "bad" can be real content, e.g. in an opposites puzzle) and for British spellings in spoken
  lines and Loop Machine words. The single-module `validate:*` scripts do not apply all of these
  (`validate-levels` checks none of them), so always run `validate.mjs` before shipping.
- **Paths** to app files are relative to `index.html` (`art/tiles/robot.svg`), never starting
  with `/`, never containing `..` or a URL: the app is served from a GitHub Pages sub-path and
  works offline, so it can only load its own files.
- **Original content only.** No copyrighted or trademarked characters, logos, brand names or
  text in pictures.

## 3. Coordinate systems

All art uses SVG conventions: origin at the **top-left**, x grows to the right, **y grows down**.

```
   THE SCENE: 600 x 600 units (backgrounds draw here directly)

   x: 0           120                                    480         600
 y:0  +----------------------------------------------------------------+
      |  sky, sun, clouds, far-away things                             |
      |                  room for hats and balloons                    |
      |                  (up to ~210 units above the box)              |
  210 |            +======================================+            |
      |            |(0,0)  ANIMAL BOX 300 x 300 units     |            |
      |            |       drawn at scale 1.2 = 360 x 360 |            |
      |            |                                      |            |
      |            |       head  *  (150, 56)             |            |
      |            |       eyes  *  (150,110)             |            |
      |            |       neck  *  (150,184)   hand *    | (250,166)  |
      |            |                                      |            |
      |            |     feet near y 285..295             |            |
  570 |            +======================================+ (300,300)  |
      |   ground                                                       |
  600 +----------------------------------------------------------------+

   STAGE BOX = where the animal box lands in the scene, set by "placement" in animals.json.
   The shipped animals.json uses { "x": 120, "y": 210, "scale": 1.2 }  ->  scene x 120..480,
   y 210..570 (360 units tall, about 210 units of headroom above it). If "placement" is
   omitted the renderer uses { "x": 150, "y": 270, "scale": 1 }  ->  x 150..450, y 270..570.
   scene point = (placement.x + boxX * scale, placement.y + boxY * scale)
```

| Space | Size / origin | Used by |
|---|---|---|
| **Scene** | 600 x 600, (0,0) top-left | backgrounds; story positions |
| **Animal box** | 300 x 300, (0,0) top-left of the box | animals and their anchors |
| **Accessory space** | around (0,0) = the attach point, about -110..110 | accessories |

**How an accessory is placed.** Each animal has four anchors `{ x, y, scale, rotate }` in
animal-box coordinates. An accessory names one anchor; the renderer puts the accessory's (0,0)
on that anchor, rotates it by `rotate` degrees (clockwise, around the anchor) and scales it by
`scale`. In SVG terms: `translate(placement) scale(placement.scale) translate(anchor.x anchor.y)
rotate(anchor.rotate) scale(anchor.scale)`. So accessories are drawn once, at a **reference
size**, and each animal's anchor scale adapts them.

```
   ACCESSORY ATTACH POINT CONVENTIONS   (accessory space, scale 1, y grows down, + marks (0,0))

   HEAD: hats            EYES: glasses                    NECK: bow ties           HAND: held things
                                                                                     .--.
        /\    y=-90                                                                 (    )  y=-170
       /  \                                                                          '--'
      /    \              .------.     .------.  y=-17    |\         /|  y=-20        |
     /______\  y=0       |   o    |---|    o   | y=0      | >--[+]--< |  y=0          |
         +                '------'  +  '------'  y=+17    |/         \|  y=+20        +  y=0
   bottom-center on +      x=-24  (0,0)  x=+24            centered on +            + = grip point
   ~90 wide              o = lens center, ~42x34          ~70 wide x 40 tall       (string end, cone)
```

| Anchor | Animal anchor goes at | Accessory (0,0) is | Reference size (scale 1) | Typical anchor scale |
|---|---|---|---|---|
| `head` | top of the head, centered, between the ears | bottom-center of the item | ~90 wide, rising to y ~ -90 (bobbles to ~ -110) | 0.85 - 0.95 |
| `eyes` | midpoint between the two eye centers | midpoint between the lenses | lens centers at x = -24 and +24 on y = 0, lenses ~42 x 34 | **(distance between eye centers) / 48** |
| `neck` | under the chin, where head meets body | center of the item | ~70 wide x 40 tall, centered | ~1.15 |
| `hand` | grip point of the raised paw on the picture's right (~x 250, y 166) | where the paw holds it | extends mostly upward, up to ~170 tall, about +-50 wide | ~1.1 |

Example: the cat's eyes are at x 122 and 178 (56 apart), so its `eyes` anchor is
`{ "x": 150, "y": 110, "scale": 1.167 }` (56 / 48), and every pair of glasses lands exactly on
its eyes.

## 4. Coloring parts (`coloring-parts/1`)

A child makes a picture in three taps (an **animal**, an **accessory** it wears or holds, a
**background** place), then taps closed areas to fill them from a 12-color palette, or a grown-up
prints the clean outline. Exactly three files exist, one per kind; to add art, **append items to
them** (the app loads only these three). Rendering is done only by
`js/modules/coloring/scene.js`; at runtime any part failing `validatePart()` is skipped with a
console warning.

### 4.1 File structure

```json
{
  "schema": "coloring-parts/1",
  "kind": "animal",
  "placement": { "x": 120, "y": 210, "scale": 1.2 },
  "items": [ ... ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Exactly `"coloring-parts/1"`. |
| `kind` | yes | `"animal"` in animals.json, `"accessory"` in accessories.json, `"background"` in backgrounds.json. Must match the file. |
| `placement` | animals only (optional) | Where the 300 x 300 animal box goes in the scene, for every animal: top-left `x`, `y` and `scale` (> 0). The shipped value is `{120, 210, 1.2}` (stage box x 120..480, y 210..570); if omitted the renderer uses `{150, 270, 1}`. Forbidden in the other two files. |
| `items` | yes | 1-24 parts in picker order. The picker is designed for **6** per file (warning otherwise). Ids unique within the file. |

### 4.2 Items

| Field | Animal | Accessory | Background | Meaning |
|---|---|---|---|---|
| `id` | yes | yes | yes | Stable id, `^[a-z0-9][a-z0-9-]*$`, max 40. |
| `name` | yes | yes | yes | Short human name (tile label for screen readers), max 40, e.g. `"Party hat"`. |
| `say` | recommended | recommended | recommended | Spoken when its tile is tapped: a short cheerful phrase, e.g. `"A cute kitty cat!"`. Missing: the app says `"<name>!"` (warning), and `npm run voice` records exactly that line. |
| `anchors` | **yes** | - | - | All four: `head`, `eyes`, `neck`, `hand`, each `{ x, y, scale?, rotate? }` in animal-box coordinates (0..300). `scale` > 0 (default 1), `rotate` -180..180 degrees (default 0). |
| `anchor` | - | **yes** | - | Which animal anchor it attaches to: `head`, `eyes`, `neck` or `hand`. |
| `viewBox` | - | optional | - | `[minX, minY, width, height]` framing the accessory when drawn alone (default `[-110, -110, 220, 220]`). Rarely needed: the picker shows accessories on the chosen animal. |
| `shapes` | yes | yes | yes | The drawing (below). 1-200 shapes, at least one `region`. |

### 4.3 Shapes

Each shape is one SVG primitive: `type` chooses the geometry fields, `kind` chooses how it is
painted. Only the listed fields are allowed; all geometry fields are required (except `rx` on a
rect). Sizes must be greater than 0.

| `type` | Fields | Use for |
|---|---|---|
| `circle` | `cx cy r` | eyes, buttons, balls, sun, wheels |
| `ellipse` | `cx cy rx ry` | bodies, heads, bellies, feet, clouds |
| `rect` | `x y width height` + optional `rx` (corner radius >= 0) | houses, windows, hat brims, signs (round the corners) |
| `polygon` | `points` (>= 3 pairs, closed automatically) | mountains, roofs, stars, crystals |
| `polyline` | `points` (>= 2 pairs, open) | zig-zags, simple strings; never fillable |
| `line` | `x1 y1 x2 y2` | whiskers, rays, simple marks; never fillable |
| `path` | `d` (SVG path data) | organic outlines: tails, ears, arms, waves, hills |

- **`points`**: numbers separated by spaces/commas, e.g. `"330,450 465,295 600,450"`.
- **`d`**: only the path commands `M L H V C S Q T A Z` (upper case absolute, lower case
  relative), numbers, spaces and commas. Must start with `M`. **Close every region outline with
  `Z`** (an open outline leaves a gap; warning). Max 8000 characters.

Common optional fields on every shape:

| Field | Meaning |
|---|---|
| `id` | Region name, unique within the part (`"belly"`, `"ear-left"`, `"sky"`). **Give every region an id.** Saved colors are stored under `"<layer>:<partId>:<id>"` (layer `bg`, `animal` or `acc`, e.g. `animal:cat:belly`); without an id the array index is used and reordering shapes would scramble saved pictures (warning). |
| `w` | Outline width multiplier, > 0 and <= 3 (1 = standard). 0.6-0.8 for fine details (whiskers, fur marks, strings), 1.2-1.5 for emphasis. |

Outlines are drawn by the renderer at one constant thickness (5 scene units) on every layer and
at every scale. Never draw an outline as a filled shape.

#### Kinds

| `kind` | Looks like | Child can fill it? | Use for | Allowed on |
|---|---|---|---|---|
| `region` | white area with a dark outline | **yes** (tap to fill) | everything a child would want to color: body, belly, ears, hat, sky, hill, house | circle, ellipse, rect, polygon, path |
| `line` | outline/stroke only, no fill | no (taps pass through to the region below) | whiskers, smiles, eyebrows, fur marks, balloon strings, waves, grass blades | all types |
| `ink` | solid dark fill (`#2B2D42`, pure black in print) | no | pupils, noses, small buttons | all types |
| `white` | solid white, no outline | no | eye shine, highlights (put it after the ink it sits on) | circle, ellipse, rect, polygon, path |

A `line` or `polyline` has no inside, so it can only be `line` or `ink`.

#### Draw order

Shapes are painted in array order; later shapes cover earlier ones. Recommended order:
back regions first (tail, ears that tuck behind the head, body), then front regions (belly,
arms, feet, head, muzzle, eyes), then `line` details, then `ink`, then `white` highlights. A region drawn on top of
another hides that part of it: the hidden part can no longer be tapped, which is fine and
expected (the belly sits on the body).

### 4.4 Animals

Draw a friendly animal **facing the viewer**, inside its 300 x 300 box: centered on x 150, feet
resting near y 285-295, about 230-270 units tall, with the **right-hand paw (picture right,
near x 250, y 165) raised** to hold things. Hats and balloons may rise above the box (the scene
has ~210 units of headroom above the stage box at the shipped placement). Keep the animal
itself inside the box (warning otherwise). Provide all four anchors (see the table in
section 3); anchors outside the box are errors.

Current animals: `cat`, `dog`, `bunny`, `bear`, `penguin`, `dinosaur`.

### 4.5 Accessories

Draw around the attach point (0,0) at the reference size of its anchor (section 3), within about
110 units of (0,0) (warning if the drawing is more than 30 units away from (0,0)). Every
accessory must look right on **every** animal: the validator places each accessory on each
animal (placement + anchor transform) and warns if the accessory then reaches outside the
600 x 600 scene. Its summary line names the combination with the least room left, e.g.
`least room: bow-tie on bunny, 113.1 units from the bottom edge`. (The animals themselves are
checked once, against their own box and the scene.)

Current accessories: `party-hat`, `crown` (head), `sunglasses` (eyes), `bow-tie` (neck),
`balloon`, `ice-cream` (hand).

### 4.6 Backgrounds

Draw directly in the 600 x 600 scene. Recommended structure:

1. a full-size backdrop region first: `{ "type": "rect", "kind": "region", "id": "sky", "x": 0, "y": 0, "width": 600, "height": 600 }`,
2. big ground / water / floor shapes (the animal's feet are at y ~ 550-565 with the shipped placement),
3. a few chunky details near the edges and the top (sun, clouds, trees, a house, shells),
4. line details last.

The animal covers the **stage box** (x 120..480, y 210..570 with the shipped placement). Keep
that area simple (open ground): background regions hidden behind the animal cannot be tapped,
and slivers peeking out between the animal's legs are frustrating to color. Shapes may extend past the scene edge (they
are clipped; warning) but details and small regions should stay inside; a shape completely
outside the scene is an error.

Current backgrounds: `meadow`, `beach`, `space`, `underwater`, `snowy`, `farm`.

### 4.7 Art style guide (ages 4-7)

- **Chunky and simple.** Big closed regions: aim for at least **~22 units** across in scene
  units (the validator warns below **16**: too small for a finger). A picture should have about
  10-25 regions per part, and well under 100 shapes in total (warning above 100).
- **Closed outlines.** Every region is a closed shape; paths end with `Z`. No hairline gaps.
- **Readable silhouettes.** Front-facing, mostly symmetrical, friendly faces: big round eyes with a
  white shine, a small smile; no teeth, no frowns, nothing scary.
- **Few lines.** Use `line` details sparingly (fur marks, whiskers) and thinner (`w` 0.6-0.8).
- **No text, letters or numbers** in the art, no logos, no copyrighted or trademarked characters,
  no real brands. Everything original.
- **Print-friendly.** In print every region is white with black outlines, so the drawing must
  read well as a pure outline.
- **Consistency.** Match the existing parts: same outline weight (never draw your own outline),
  similar proportions, accessories that fit every animal.
- `say` lines are cheerful and short: `"A sleepy owl!"`, `"A rainy day!"`.

### 4.8 What the art validator checks

`node tools/validate-art.mjs` (also part of `tools/validate.mjs`) runs the renderer's own
`validatePart()` and then:

- **errors:** wrong `schema`/`kind`, unknown keys, malformed structure (e.g. `shapes` that is
  not an array, or a shape that is not an object), duplicate item ids, bad ids, numbers given as
  strings, missing geometry fields, sizes <= 0, path data with other characters / not starting
  with `M` / wrong number of values, polygons with too few points or odd numbers, `line` /
  `polyline` used as a region (or `white`), duplicate region keys, a part without regions,
  anchors outside the animal box, unknown accessory anchors, a shape completely outside its box,
  over-long `say`/`name`, more than 200 shapes or 24 items;
- **warnings:** not 6 items, missing `say`, regions without `id`, open region outlines, regions
  narrower than 16 scene units (at the real placement / anchor scale), animals reaching outside
  their box, background shapes past the scene edge, **any accessory that, worn by any animal,
  reaches outside the scene**, unusual anchor scales, accessories drawn far from (0,0), more
  than 100 shapes, `say` over 15 words.

Bounding boxes are geometric (outline thickness excluded) and exact for every shape type,
including path curves and arcs (relative commands are resolved, curve extremes and SVG arc
centers are computed; cross-checked against the browser's `getBBox()`). Two approximations
remain: a rotated anchor transforms the accessory's box corners (errs on the large side), and the
narrow-region check looks at a region's bounding box, so a thin diagonal sliver is not detected.

### 4.9 Minimal examples

A complete, valid set (one item per file; the validator will only warn that 6 are expected).

<!-- example: coloring animals -->
```json
{
  "$schema": "../../schemas/coloring-parts.schema.json",
  "schema": "coloring-parts/1",
  "kind": "animal",
  "placement": { "x": 120, "y": 210, "scale": 1.2 },
  "items": [
    {
      "id": "frog",
      "name": "Frog",
      "say": "A happy frog!",
      "anchors": {
        "head": { "x": 150, "y": 70, "scale": 0.9 },
        "eyes": { "x": 150, "y": 92, "scale": 1.25 },
        "neck": { "x": 150, "y": 182, "scale": 1.1 },
        "hand": { "x": 252, "y": 168, "scale": 1.1 }
      },
      "shapes": [
        { "type": "ellipse", "kind": "region", "id": "body", "cx": 150, "cy": 226, "rx": 82, "ry": 62 },
        { "type": "ellipse", "kind": "region", "id": "belly", "cx": 150, "cy": 240, "rx": 48, "ry": 38 },
        { "type": "path", "kind": "region", "id": "arm-right", "d": "M196 214 L240 176 A16 16 0 1 1 262 200 L216 236 Z" },
        { "type": "ellipse", "kind": "region", "id": "foot-left", "cx": 108, "cy": 284, "rx": 34, "ry": 12 },
        { "type": "ellipse", "kind": "region", "id": "foot-right", "cx": 192, "cy": 284, "rx": 34, "ry": 12 },
        { "type": "ellipse", "kind": "region", "id": "head", "cx": 150, "cy": 128, "rx": 86, "ry": 54 },
        { "type": "circle", "kind": "region", "id": "eye-left", "cx": 120, "cy": 92, "r": 25 },
        { "type": "circle", "kind": "region", "id": "eye-right", "cx": 180, "cy": 92, "r": 25 },
        { "type": "circle", "kind": "ink", "cx": 120, "cy": 94, "r": 10 },
        { "type": "circle", "kind": "ink", "cx": 180, "cy": 94, "r": 10 },
        { "type": "circle", "kind": "white", "cx": 124, "cy": 90, "r": 3.5 },
        { "type": "circle", "kind": "white", "cx": 184, "cy": 90, "r": 3.5 },
        { "type": "path", "kind": "line", "d": "M112 146 Q150 172 188 146" }
      ]
    }
  ]
}
```

The frog's eyes are 60 apart, so `eyes.scale` is 60 / 48 = 1.25.

<!-- example: coloring accessories -->
```json
{
  "$schema": "../../schemas/coloring-parts.schema.json",
  "schema": "coloring-parts/1",
  "kind": "accessory",
  "items": [
    {
      "id": "top-hat",
      "name": "Top hat",
      "say": "A tall top hat!",
      "anchor": "head",
      "shapes": [
        { "type": "rect", "kind": "region", "id": "crown", "x": -30, "y": -86, "width": 60, "height": 76, "rx": 6 },
        { "type": "rect", "kind": "region", "id": "band", "x": -30, "y": -36, "width": 60, "height": 20 },
        { "type": "rect", "kind": "region", "id": "brim", "x": -48, "y": -14, "width": 96, "height": 20, "rx": 9 }
      ]
    }
  ]
}
```

<!-- example: coloring backgrounds -->
```json
{
  "$schema": "../../schemas/coloring-parts.schema.json",
  "schema": "coloring-parts/1",
  "kind": "background",
  "items": [
    {
      "id": "park",
      "name": "Park",
      "say": "A sunny park!",
      "shapes": [
        { "type": "rect", "kind": "region", "id": "sky", "x": 0, "y": 0, "width": 600, "height": 600 },
        { "type": "polygon", "kind": "region", "id": "hill", "points": "330,450 465,295 600,450" },
        { "type": "path", "kind": "region", "id": "grass", "d": "M0 440 Q300 390 600 440 L600 600 L0 600 Z" },
        { "type": "circle", "kind": "region", "id": "sun", "cx": 515, "cy": 85, "r": 45 },
        { "type": "line", "kind": "line", "x1": 450, "y1": 85, "x2": 425, "y2": 85 },
        { "type": "line", "kind": "line", "x1": 469, "y1": 39, "x2": 451, "y2": 21 },
        { "type": "line", "kind": "line", "x1": 515, "y1": 20, "x2": 515, "y2": 0 },
        { "type": "path", "kind": "region", "id": "cloud", "d": "M70 160 A28 28 0 0 1 84 110 A40 40 0 0 1 160 100 A30 30 0 0 1 206 140 A20 20 0 0 1 196 160 Z" },
        { "type": "rect", "kind": "region", "id": "tree-trunk", "x": 52, "y": 330, "width": 36, "height": 120, "rx": 8 },
        { "type": "circle", "kind": "region", "id": "tree-top", "cx": 70, "cy": 300, "r": 58 }
      ]
    }
  ]
}
```

## 5. Robot levels (`robot-levels/1`)

Robot Puzzles teaches **sequencing** (levels 1-9) and **loops** (levels 10-15). A robot stands on
a 4 x 4 board; the child drags arrow cards (and later repeat cards) into a command strip and
presses Play; the robot runs the cards in order, one cell per arrow. The rules live only in
`js/modules/robot/logic.js` (pure functions shared by the game and the validator).

```
   THE BOARD (cells are [col, row]; [0,0] is the TOP-LEFT cell)

             col 0   col 1   col 2   col 3
   row 0      .       .       .       *        *  goal (star)
   row 1      .       #       .       .        #  obstacle (rock / bush / puddle)
   row 2      .       .       .       .        S  start
   row 3      S       .       .       .
   "up" moves toward row 0, "down" toward row 3, "left" toward col 0, "right" toward col 3.
   Arrows are absolute screen directions: the robot never turns.
```

### 5.1 File and level fields

```json
{ "schema": "robot-levels/1", "grid": { "cols": 4, "rows": 4 }, "levels": [ ... ] }
```

`grid` must be `{ "cols": 4, "rows": 4 }` (the board is designed for 4 x 4). `levels` holds
1-99 levels in play order (level N unlocks when N-1 is solved).

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique, stable save key (`^[a-z][a-z0-9-]{1,23}$`). Curriculum: `r01`..`r15`; generated packs use their own prefix (`g01`...). |
| `start` | yes | Robot start cell `[col, row]`. |
| `goal` | yes | Star cell `[col, row]`; entering it solves the level instantly. |
| `obstacles` | yes | `[]` or up to 8 `{ "at": [col,row], "kind": "rock" \| "bush" \| "puddle" }` (all block; the kind is only the picture). Never on start/goal, never two on one cell. |
| `cards` | yes | Palette, 1-6 unique card ids from `up down left right repeat2 repeat3` (each unlimited), at least one arrow, listed in that canonical order (warning otherwise). |
| `maxCards` | yes | Top-level slots in the strip, 1-8. A repeat block uses ONE slot whatever is inside it. Use the optimal card count or optimal + 1 (warning above optimal + 2). |
| `repeatCapacity` | no | Arrow slots inside each repeat block, 1-3 (default 2). Use 1 when repeat is introduced. |
| `repeatOptional` | no | `true` only if a level has a repeat card but is deliberately solvable without it. |
| `say` | yes | Spoken intro (the only instruction): one short sentence, <= 15 words, <= 110 chars. |
| `hint` | no | Spoken after 2 misses while sparkly dots show the reference path. |
| `solution` | yes | Reference program (below); its path is the hint, so make it the most natural one. |

### 5.2 Program format

The same format is used for `solution` and for what the child builds in the strip:

```
Program = Step[]                                  (1-8 top-level steps)
Step    = "up" | "down" | "left" | "right"         one move of one cell
        | { "repeat": 2 | 3, "do": Arrow[] }       a loop: 1..repeatCapacity arrows, run 2 or 3 times
```

`{ "repeat": 2 }` needs the `repeat2` card in the palette, `{ "repeat": 3 }` needs `repeat3`.
Repeat blocks cannot be nested. Example: `["up", { "repeat": 3, "do": ["right"] }, "down"]` =
up, right, right, right, down; `[{ "repeat": 3, "do": ["right", "up"] }]` is a staircase.

### 5.3 Rules (`simulate()` in logic.js)

1. Moves run in order; a repeat runs its body `repeat` times.
2. The run **succeeds the moment the robot enters the goal** (remaining cards are ignored).
3. A move off the board or into an obstacle is **blocked**: the robot stays put and the run stops
   on that card (outcome `edge` / `obstacle`) so the child can debug it.
4. If the cards run out first the robot is **short** of the goal.

### 5.4 Curriculum constraints (`data/robot/levels.json`)

- Exactly **15** levels with ids `r01`..`r15`, difficulty rising gently.
- **Levels 1-9 (sequencing):** no obstacles, no repeat cards. Start with one arrow and one
  direction, then two directions, then mixed.
- **Levels 10-15 (loops):** at least one obstacle and at least one repeat card each. Level 10
  introduces the repeat card (spoken intro), `repeatCapacity` 1 at first, 2 for two-arrow loops.
- **Required-loop rule:** when the palette has a repeat card, the level must be **impossible with
  arrows alone within `maxCards`** (so `maxCards` is smaller than the shortest arrow-only
  program), unless `repeatOptional` is `true`.
- Keep distractor cards to one or two; never drop the number of moves sharply from one level to
  the next.

### 5.5 What the level validator checks

`node tools/validate-levels.mjs [file] [--maps] [--no-curriculum] [--json]`:

- **errors:** schema-level structure (exact keys, types, ranges), start/goal/obstacles distinct
  and inside the grid, solution uses only palette cards, fits `maxCards` and `repeatCapacity`,
  reaches the goal with its **last** move (no wasted trailing moves), the level is solvable
  (`solve()`), the required-loop rule, and (by default) the curriculum rules above;
- **warnings:** non-canonical palette order, loose `maxCards`, sharp difficulty drops, too many
  unused palette cards, spoken lines over 15 words, `repeatOptional` / `repeatCapacity` on a
  level without a repeat card ("has no effect"), and, for loop levels, a command strip that is
  too wide for phones. Strip width is counted in card widths (arrow = 1, repeat block = 1.4 +
  `repeatCapacity`, whatever is inside it; limits `stripRefMax` / `stripWorstMax` in
  `LIMITS`, currently 7):
  - the **reference solution** wider than 7 scrolls on phones and hides part of the hint
    program: use fewer repeat blocks (e.g. two-arrow bodies) or fewer slots;
  - a **full strip** (`maxCards` slots, each a full repeat block) wider than 7 can scroll inside
    its box on small phones (360 px wide, or landscape once system bars take some height): use
    at most 2 slots, or accept it only when the level truly needs more. The shipped r12 (7.2)
    triggers this one knowingly.

`--maps` prints an ASCII map and the reference path of every level (the table's `strip` column
shows the reference / fullest strip widths); use `--no-curriculum` for packs other than the
main 15-level curriculum.

### 5.6 Minimal example

<!-- example: robot levels -->
```json
{
  "$schema": "../../schemas/robot-levels.schema.json",
  "schema": "robot-levels/1",
  "grid": { "cols": 4, "rows": 4 },
  "levels": [
    {
      "id": "g01",
      "start": [0, 3],
      "goal": [2, 3],
      "obstacles": [],
      "cards": ["right"],
      "maxCards": 2,
      "say": "Help the robot reach the star!",
      "solution": ["right", "right"]
    },
    {
      "id": "g02",
      "start": [0, 3],
      "goal": [3, 2],
      "obstacles": [{ "at": [1, 2], "kind": "rock" }],
      "cards": ["up", "right", "repeat3"],
      "maxCards": 2,
      "repeatCapacity": 1,
      "say": "The repeat card does the arrow inside it again and again!",
      "hint": "Put the right arrow inside the repeat card.",
      "solution": [{ "repeat": 3, "do": ["right"] }, "up"]
    }
  ]
}
```

`g02` needs 4 arrow moves but has only 2 slots, so the repeat card is required (and the rock
stops an "up first" program). Both examples pass the validator with no warnings.

> The app loads only `data/robot/levels.json`, whose curriculum is fixed at 15 levels. Extra
> generated packs can be validated with `--no-curriculum` today, but playing them needs a small
> app change (e.g. a list of packs) first.

## 6. Loop Machine rounds (`machine-rounds/1`)

Loop Machine is a puzzle module for ages **4-12**: a machine runs a "loop" (a repeating picture
pattern, a number rule or a word puzzle) along a conveyor belt with one mystery box `?`, and the
child taps one of 2-4 answer buttons. This section is a summary. The full spec (screens, hints,
tiers) is in `docs/ARCHITECTURE.md` ("Module spec: Loop Machine"). Every field is described for
a generator in `schemas/machine-rounds.schema.json`, and `tools/validate-machine.mjs` checks the
puzzle logic. The schema also requires US English for every word (color, favorite, mom).

```json
{ "schema": "machine-rounds/1", "sessionLength": 10, "tiers": [ ... ], "rounds": [ ... ] }
```

| Field | Meaning |
|---|---|
| `sessionLength` | Rounds per session, 3-20 (10 is the tested value). |
| `tiers` | Exactly three, in this order: `little` (1 star, ages 4-6), `big` (2 stars, 7-9), `super` (3 stars, 10-12), each `{ id, name, ages, stars, say }`. Only `name` and `say` are free text. |
| `rounds` | All puzzles of all tiers, in any order. Aim for 40+ rounds per tier (at least 3 x `sessionLength`) so sessions can avoid recently played rounds. |

| Round field | Meaning |
|---|---|
| `id` | Unique, never reused, `^[a-z0-9-]+$`, max 32. Convention `<l\|b\|s>-<pat\|cnt\|seq\|wrd\|set\|ord>-NN`, e.g. `l-pat-01`. |
| `tier`, `level` | The tier id, and difficulty 1-3 inside it (sessions ramp from 1 to 3). |
| `type` | `pattern` (picture loop with one `?`), `count` (how many `target` pictures), `sequence` (number rule with one `?`), `word` (word / letter puzzle with one `?`), `set` (pick the group that fits; each choice is a group), `order` (put word cards into a sentence). |
| `say` | The spoken question (required). For `little` it must explain the whole task, because the child cannot read. |
| `hint`, `explain` | Spoken with the hint, which comes after 2 misses or as soon as only two answers are left (a strategy, never the answer; the hint never removes an answer) / right after the correct answer (teaches the rule). |
| `show` | The belt, left to right: up to 9 tokens (12 is the hard maximum). |
| `choices`, `answer` | 2-4 different choices; `answer` equals one of them exactly (same type: `7`, not `"7"`). |
| `target` | `count` (and optionally `set`): which picture to count. |
| `rule`, `ruleLabel` | `sequence`: a machine-checked rule (`"+2"`, `"*2"`, `"squares"`, `"fibonacci"`, `"alt:+3,-1"`, ...) and a short visual label shown with the hint (`"+2"`). |
| `skill` | Short label of the skill practiced, e.g. `rhyme`, `compound`, `more`, `verbs`. |
| `words` | `order`: the sentence's word cards in the correct order (the game shuffles them). |

**Tokens** on the belt and the buttons are numbers, picture ids (`circle-red` ... `diamond-orange`
for 6 shapes x 6 colors; `apple fish flower balloon cupcake moon cloud ladybug`), the symbols
`→ + = ?`, and words or letters. The `little` tier uses **no words** (ages 4-6 cannot read yet):
only pictures, numbers and symbols.

`node tools/validate-machine.mjs [file] [--list] [--json]` (also run by `tools/validate.mjs`)
checks the structure and what a schema cannot: picture patterns really loop and no wrong choice
also completes one; count answers equal the number of `target` pictures; sequences obey their
`rule` and no wrong choice fits another simple rule; more / fewer groups have a strict winner;
compound words add up; spoken lines are short and free of symbols.

<!-- example: machine rounds -->
```json
{
  "$schema": "../../schemas/machine-rounds.schema.json",
  "schema": "machine-rounds/1",
  "sessionLength": 10,
  "tiers": [
    { "id": "little", "name": "Little", "ages": "4-6", "stars": 1, "say": "Little machine! Picture puzzles for you." },
    { "id": "big", "name": "Big", "ages": "7-9", "stars": 2, "say": "Big machine! Words and numbers." },
    { "id": "super", "name": "Super", "ages": "10-12", "stars": 3, "say": "Super machine! Tricky puzzles." }
  ],
  "rounds": [
    { "id": "l-pat-01", "tier": "little", "level": 1, "type": "pattern",
      "say": "What comes next in the loop?",
      "show": ["circle-red", "square-blue", "circle-red", "square-blue", "circle-red", "?"],
      "choices": ["square-blue", "circle-red", "star-yellow"], "answer": "square-blue",
      "hint": "Red circle, blue square, again and again!", "explain": "Red, blue, red, blue!" },
    { "id": "l-cnt-01", "tier": "little", "level": 2, "type": "count", "target": "fish",
      "say": "How many fish? Only count the fish!",
      "show": ["fish", "apple", "fish", "fish", "apple"],
      "choices": [2, 3, 5], "answer": 3,
      "hint": "Point to each fish. Skip the apples.", "explain": "Three fish!" }
  ]
}
```

A real bank needs many more rounds per tier (the validator warns below 30 per tier).

## 7. Module registry (`app-registry/1`)

`data/app.json` lists the home-screen tiles in display order. The home screen (`js/app.js`
`showHome`) shows each **ready** module as a big picture tile (2 per row in portrait, an odd last
tile spanning the row; all in one row in landscape) and each **locked** module as a smaller
"coming soon" tile in one row underneath; each group keeps the order of the list. It is designed
for **up to 4 ready and up to 4 locked** modules (warning above that: tiles get small on phones);
at most 8 in total, and at least one must be ready (errors).

<!-- example: registry -->
```json
{
  "schema": "app-registry/1",
  "modules": [
    { "id": "robot", "title": "Robot Puzzles", "status": "ready",
      "entry": "js/modules/robot/robot.js", "css": "js/modules/robot/robot.css",
      "tile": { "art": "art/tiles/robot.svg", "color": "#4CC9F0" } },
    { "id": "story", "title": "Story Movie", "status": "locked",
      "lockedSay": "Story Movie is coming soon!",
      "tile": { "art": "art/tiles/story.svg", "color": "#FFD166" } }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Route (`#/<id>`), CSS class `mod-<id>`, storage scope `<id>.*`, folder `js/modules/<id>/`. Lowercase, max 24, unique; `settings` is reserved. Never rename. |
| `title` | yes | Name under the tile and its accessible label (max 30). |
| `status` | yes | `"ready"` (tile opens the module) or `"locked"` (grayed tile with a lock; tapping it speaks `lockedSay`). |
| `entry` | if ready | ES module whose default export implements the module contract (`docs/ARCHITECTURE.md`). `.js`. |
| `css` | no | Stylesheet loaded with the entry. `.css`. |
| `lockedSay` | no | Spoken when a locked tile is tapped (default `"<title> is coming soon!"`). |
| `tile.art` | yes | Square tile picture (`.svg` preferred, `.png`/`.webp` allowed), original art, no text. |
| `tile.color` | yes | Tile color `#RRGGBB`. |

`tools/validate.mjs` also checks that every referenced file exists, that the entry has an
`export default`, that paths are relative and inside the cached folders (`css/ js/ data/ art/
icons/`), and warns when an entry is not under `js/modules/<id>/`.

To ship a new module: create `js/modules/<id>/<id>.js` (+ `.css`), put its content in
`data/<id>/...json` with a schema in `schemas/`, set the registry entry to `"ready"` with
`entry`/`css`, then run `node tools/validate.mjs` and `node tools/precache.mjs`. If its content
has rules a schema cannot express, add a `tools/validate-<id>.mjs` and register it (and its
`data/<id>/` folder) in `RULE_VALIDATORS` and `CONTENT_PLACES` at the top of the runner in
`tools/validate.mjs` (section 9 has the pattern).

## 8. Story Movie (DRAFT, `story-draft/1`)

> **DRAFT.** The Story Movie module does not exist yet and nothing in the app reads this format.
> It is a proposal so content tools can be designed early; expect changes. When the module ships,
> the format id becomes `story/1`. Schema: `schemas/story.schema.json`.

A story is a short animated movie (ideally 3-5 scenes, 30-90 seconds) for children who cannot
read: a simple beginning, a small problem or surprise, a happy ending. It reuses the Coloring
art: each scene shows one Coloring **background** with up to three **characters**, each a Coloring
**animal** optionally wearing an **accessory** (all referenced by id). When a scene opens, its
`narration` lines are spoken, then the `timeline` actions play one after another; when the
timeline ends the movie moves to the next scene.

Proposed file: `data/stories/stories.json` (one file holding all stories, because a static web
host cannot list a folder).

**Coordinates.** Scene 600 x 600, y down (as for backgrounds). A character's `x, y` is where its
**feet** touch the ground: the bottom-center of its 300 x 300 animal box. `size` scales the box
(1 = 300 units tall; the Coloring picture uses 1.2 = 360 units; 0.5-0.7 suits two or three
characters). The Coloring picture's placement equals `{ "x": 300, "y": 570, "size": 1.2 }`.
Keep feet at y ~480-580 so characters stand on the ground, and the whole box inside the scene.

| Object | Fields |
|---|---|
| file | `schema` = `"story-draft/1"`, `stories` (1-24) |
| story | `id`, `title` (grown-up label), `say` (spoken when its tile is tapped), `scenes` (1-8) |
| scene | `id?`, `background` (Coloring background id), `characters` (0-3), `narration` (1-3 spoken lines), `timeline` (0-12 actions) |
| character | `id` (handle used by `who`, unique in the scene), `animal` (id), `accessory?` (id), `x`, `y` (feet, 0..600), `size?` (0.3-1.2, default 0.6), `facing?` (`"right"` = as drawn, default; `"left"` = mirrored) |

| Action | Fields | Meaning |
|---|---|---|
| `enter` | `who`, `from?` (`left`/`right`, default nearer side), `duration?` (s, default 1.5) | walk in from off-stage to the character's `x, y`. A character with an `enter` starts off-stage; it must be its first action, at most once per scene. |
| `move-to` | `who`, `x`, `y?` (default: same ground line), `duration?` (default 1.5) | walk to a new spot, turning toward it |
| `jump` | `who`, `times?` (1-3, default 1) | happy hop(s) in place |
| `wave` | `who`, `times?` (1-3, default 2) | wave the raised paw (hand anchor) |
| `say` | `who`, `text` (spoken line) | the character speaks (text-to-speech, little bounce, speech-bubble icon); continues when speech ends or after a time-out |
| `wait` | `seconds` (0.2-5) | pause |

`node tools/validate.mjs` checks story files against the schema and cross-references: the
background, animal and accessory ids exist in the Coloring files, `who` names a character in the
same scene, `enter` comes first and only once, characters stay inside the scene, spoken lines
have at most 15 words (warning). Every JSON file in `data/stories/` is checked as a story file,
so its `"schema"` must be exactly `"story-draft/1"` (anything else is an error).

<!-- example: story -->
```json
{
  "$schema": "../../schemas/story.schema.json",
  "schema": "story-draft/1",
  "stories": [
    {
      "id": "picnic",
      "title": "The Picnic",
      "say": "A story about a picnic!",
      "scenes": [
        {
          "background": "meadow",
          "narration": ["One sunny day, Kit the cat went to the meadow."],
          "characters": [
            { "id": "kit", "animal": "cat", "accessory": "party-hat", "x": 200, "y": 560, "size": 0.6 },
            { "id": "bo", "animal": "bear", "x": 420, "y": 560, "size": 0.6, "facing": "left" }
          ],
          "timeline": [
            { "action": "enter", "who": "bo", "from": "right" },
            { "action": "wave", "who": "kit" },
            { "action": "say", "who": "kit", "text": "Hi, Bo! Do you want to play?" },
            { "action": "jump", "who": "bo", "times": 2 },
            { "action": "move-to", "who": "kit", "x": 320 },
            { "action": "wait", "seconds": 1 }
          ]
        }
      ]
    }
  ]
}
```

Open questions for the real module: play/pause/replay controls and scene skipping; whether
actions can run at the same time (e.g. a `"with": "previous"` flag); dressing the cast in the
child's own saved Coloring colors; scene transitions; optional captions for grown-ups; a
narrator voice distinct from character voices; picker tiles (first scene as thumbnail).

## 9. Builder (format TBD)

The Builder module and its content format are **to be decided**; nothing exists yet besides its
locked home tile. When it is designed, follow the same pattern: a `data/builder/...json` file
whose first key is `"schema": "builder/1"`, a JSON Schema in `schemas/builder.schema.json` whose
`properties.schema.const` is that id (`tools/validate.mjs` then checks conformance
automatically), a `tools/validate-builder.mjs` for rules a schema cannot express (exporting a
`validateBuilder(doc)` that returns `{ errors, warnings, rows }`), wired into `tools/validate.mjs`
by adding one entry to `RULE_VALIDATORS` and `data/builder/` to `CONTENT_PLACES` (so every file
there must declare `builder/1`), and a section in this document.

## 10. How to add new content safely

1. **Generate or edit.** Start from the schema (`schemas/*.schema.json`: every field has a
   description) and this document. Append new items with **new ids**; never rename, reuse or
   delete published ids (they are save keys). Keep the counts the screens are designed for
   (6 parts per coloring file, 15 curriculum levels, up to 4 ready + 4 locked home tiles).
2. **Validate.** `node tools/validate.mjs` (everything) or the specific validator. Fix every
   `ERROR`; read every `WARNING`. For a generator loop use `--json` and feed the messages back.
   Validate a folder of generated content without touching the app:
   `node tools/validate.mjs --root path/to/copy-of-app`,
   `node tools/validate-art.mjs path/to/folder`,
   `node tools/validate-levels.mjs pack.json --no-curriculum`,
   `node tools/validate-machine.mjs bank.json`.
3. **Look at it.** Art: `node tools/render-coloring.mjs --sheet combos` (writes
   `coloring-combos.png` to your temp folder and prints the path; never put previews in the app folder)
   (also `animals` with anchor markers, `accessories`, `backgrounds` with the stage box, `scene`,
   `print`). It always renders the `data/coloring/` of the app copy it belongs to and has no
   folder option, so to look at generated parts, put them into `data/coloring/` of a working
   copy of the app and run **that copy's** script:
   `node path/to/copy-of-app/tools/render-coloring.mjs --sheet combos`.
   Levels: `node tools/validate-levels.mjs --maps`. Loop Machine: `node tools/validate-machine.mjs
   --list` (one line per round, for proofreading). Check that it is friendly, readable, original
   and suitable for the ages it targets.
4. **Record the new lines.** Everything the app says is pre-recorded (`audio/emma/`, see the
   README "Voice" section). New or changed `say` / `hint` / `explain` / word / choice text needs
   `npm run voice`, which records only what is new. Until then those lines are spoken by the
   device's own voice, so generated content works right away, just in a different voice.
   `node tools/validate.mjs` (section "Recorded voice") and `npm run voice:check` list them.
5. **Refresh the offline cache.** `node tools/precache.mjs` rewrites the service worker's file
   list and version so installed apps pick up the change (`--check` exits 1 if it is stale; run
   it before every deploy). Run it before testing locally too: the service worker also serves
   the cached copy on `localhost`, so without it a reload still shows the old content.
6. **Test.** Run the automated smoke test if the repo has one (`npm test` runs
   `tools/smoke-test.mjs`), then play it: phone and tablet, portrait and landscape, with sound
   on (every new spoken line), and print a coloring page.
7. **Deploy.** Commit and push; GitHub Pages serves the new files. Installed apps update the
   next time they start.

**Generator checklist** (put this in the prompt):

- Output only JSON matching the schema; first key `"schema"`; no comments, no extra keys.
- Coordinates in the right space (section 3); y grows down; numbers, not strings.
- Coloring: every fillable area is a closed `region` with an `id`; chunky shapes (>= ~22 units);
  `line` for details; `ink` pupils + `white` shine; no text; original designs; accessories at the
  reference size around (0,0); animals inside 0..300 with all four anchors.
- Levels: 4 x 4, `solution` reaches the goal on its last move, only palette cards, `maxCards`
  = optimal (+1), loop levels impossible without the repeat card.
- Loop Machine: exactly one defensible answer among the choices, plausible distractors, no
  words in the `little` tier, ids never reused.
- Spoken lines: one short, warm sentence, <= 15 simple words, never over 110 characters; no
  symbols, emoji or markup; never scold.
- US English spelling and words everywhere (color, gray, center, favorite, mom).
- Then run the validators; regenerate with the `ERROR` lines until there are none.

## 11. Tools

| Command | What it does |
|---|---|
| `node tools/validate.mjs [--root DIR] [--quiet] [--json]` | All checks (sections 1-9 of its output: data files, registry, robot levels, Loop Machine rounds, coloring art, stories, schemas, offline cache, spoken text). Each section runs on its own, so one crash cannot hide the rest. Exit 1 on any error. |
| `node tools/validate-art.mjs [folder] [--animals f] [--accessories f] [--backgrounds f] [--json] [--quiet]` | Coloring art (section 4.8). Prints a per-part summary: shapes, regions, lines, inks, whites and bounding box. |
| `node tools/validate-levels.mjs [file] [--maps] [--no-curriculum] [--json]` | Robot levels (section 5.5). |
| `node tools/validate-machine.mjs [file] [--list] [--json]` | Loop Machine rounds (section 6). |
| `node tools/render-coloring.mjs --sheet <animals\|accessories\|combos\|backgrounds\|scene\|print> [--out f.png]` | Renders this app copy's `data/coloring` with the real renderer for visual review (no folder option; see section 10 step 3). Without `--out` it writes `coloring-<sheet>.png` to the temp folder and prints the path; an `--out` path is relative to where you run it, so keep it outside the app folder (everything there gets uploaded). |
| `node tools/precache.mjs [--check\|--list]` | Updates / checks the service worker's precache list. |

Reusable from other Node scripts (all pure, no side effects on import):

```js
import { validateArt } from './tools/validate-art.mjs';       // ({ animals, accessories, backgrounds }) -> { errors, warnings, rows, combos }
import { validateLevels } from './tools/validate-levels.mjs'; // (doc, { curriculum }) -> { errors, warnings, rows }
import { validateMachine } from './tools/validate-machine.mjs'; // (doc) -> { errors, warnings, rows, counts }
import { runAll, checkSchema } from './tools/validate.mjs';    // runAll({ root }) -> { ok, errors, warnings, sections }
```
