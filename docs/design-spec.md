# UofT Course Map: production design specification

Status: final, v1.0, 2026-10-08. This document binds the production frontend (React shell plus the
canvas renderer). `docs/architecture.md` still governs product rules, data and module boundaries.
Where this spec needs an architecture change, the change is listed in section 19 as an owner
decision. Until the owner answers, use the fallback given there.

Sources: the three judged prototypes (A "Faithful refinement" 22.5, B "Cartographic atlas" 21.5,
C "Precision instrument" 20.3), the three judges' reports, `docs/reference/dependency-graph.png`,
`src/graph/*`, `src/app/*`, `public/data/utm/graph.json` and `data/utm/subjects.json` (70 subjects
in 5 divisions). A developer can implement everything here without opening the prototypes.

Conventions:

- "MUST" is a requirement, "SHOULD" is a strong default, and "MAY" is optional.
- All sizes are CSS px. "World px" means CSS px at zoom 1 inside the graph. Screen size = world size × zoom.
- `--name` is a CSS custom property defined in `src/ui/tokens.css`. The canvas reads the same
  properties through `getComputedStyle(document.documentElement)` whenever the resolved theme
  changes, so canvas code never hard-codes colours.
- Graph constants live in `DEFAULT_GEOMETRY_OPTIONS` (`src/graph/geometry.ts`) and in
  `RENDER` (`src/graph/renderer.ts`). The values in this document are the only place they are tuned.

---

## 1. Decisions at a glance

**Base: Prototype A.** Kept from A:

- The reference structure: a white header, one rounded panel, a chip row, the zoom group, a sticky
  lane column, sticky band headers and alternate band washes.
- Green default dots and thin left-to-right S-curves with horizontal tangents.
- Measured title truncation that trims trailing punctuation.
- Label knockouts.
- Faint edges stroked once per path so overlaps never darken.
- Click-to-select keeps the clicked node under the cursor. Hash or search selection frames the
  whole chain.
- No unrelated edges are drawn during a selection.
- Plain vertical cell lists.

**Grafted from C:**

- The inverted label plate on the selected course, with the full, untruncated title.
- A faint row and column wash, plus ▸/▾ markers on the sticky rulers.
- Per-lane and per-band "needed / unlocked" counts.
- The plain-language readout ("Needs 1 directly · 1 in total").
- A complete docked legend.
- Slim rows for lanes with nothing on the path.
- Search results that show code + title.
- Adaptive framing that keeps every direct neighbour on screen at 1536 px.

**Grafted from B:**

- A docked course details surface with the official requirement text.
- A band-header scale bar with one segment per sub-column.
- Lane bars and subject-code bullets coloured by division tone, never blue or violet.
- Division labels.
- "Grey dots / Hide" semantics.
- Relation words in tooltips ("Needed directly").
- Real subject names.
- A locator, rebuilt as an overview ruler inside the vertical scrollbar so it never covers the graph.
- The full-campus stress fixture, which is now simply the default dataset.

**Rejected:**

- B: the beige paper, the serif display face, the slashed zero, the floating card and the
  double neatline.
- C: monospace codes, the staggered "brick" wrap, edge-free courses laid out in horizontal rows,
  dashes on every alternative, glow on edges, and the "0 links inside a column" self-check in the
  student UI (it moves to tests).

**New in this spec** (each one resolves a must-fix; the full mapping is in section 18):

- **Transitive chain nodes may drop their titles** ("chain titles: auto", section 8.2) so the
  chain fits horizontally at a readable zoom.
- **The auto-frame zoom floor is 0.92**, and type never renders below 12 px for codes or 11.5 px
  for titles at that zoom. Below the floor, an edge-of-view indicator ("19 later unlocks →")
  replaces any further shrinking.
- **Mini-only sub-columns collapse to 22 px** during a selection. Lanes whose visible nodes are
  all mini become 30 px slim rows.
- **Corridor routing** (section 8.8) guarantees that no highlighted curve crosses a label or dot.
  High-degree fans are bundled into trunks.
- **Overview long-edge stubs** (section 8.10). An edge that spans 3 or more lanes is drawn as two
  short port stubs until the user hovers, selects or turns on "Show all connections". This tames
  the grey MAT/STA calculus fan.
- **"One of several"** is shown only for parsed `any` groups, as a fork junction in front of the
  selected course, never as a dash. Dashes mean corequisite only.
- **Shape encodes the student record; colour encodes the relation.** Program highlighting uses
  amber, which is reserved for it.

---

## 2. Design principles

1. **The chain is the product.** With a course selected, only its chain carries colour.
   Everything else becomes grey dots, and no unrelated curve is drawn.
2. **Readable or absent.** Text never renders below its floor. When space runs out, the map
   hides a label (semantic zoom) or points off-screen (edge indicators). It never shrinks text.
3. **Every meaning has two channels.** Direction is shown by hue and by side. A prerequisite is
   always strictly left of the selection and an unlock strictly right; this is guaranteed by the
   column invariant. Distance is shown by fill and by size. Record state is shown by shape. The
   map survives greyscale and colour-vision deficiency.
4. **Never cover the graph.** Details, legend and locator live in docked chrome. Only transient
   tooltips and popovers may overlap the canvas.
5. **The calendar is the authority.** The map shows official text verbatim, never claims more
   structure than the parser understood, and always links to the official page.

---

## 3. Design tokens

### 3.1 CSS custom properties

Theme resolution:

- `startThemeSync` sets `<html data-theme="light|dark">`.
- `:root` carries the light values.
- `:root[data-theme="dark"]` carries the dark values.
- A `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` block repeats
  the dark values so the first paint is right before JS runs.

```css
:root {
  /* surfaces */
  --page: #f2f3f5;          /* app background behind cards */
  --surface: #ffffff;       /* header, cards, graph background, even bands */
  --surface-2: #f7f8fa;     /* official-text blocks, legend strip, tab bar */
  --band: #f5f6f8;          /* odd level bands (200, 400) wash */
  --field: #ffffff;         /* inputs, segmented-control tracks */
  --hover: #f0f2f4;         /* hover fill for chips, rows, buttons */
  --line: #e1e4e8;          /* borders, lane separators, header rules */
  --line-soft: #eceef1;     /* inner dividers, progress track */
  --rule-strong: #c9ced5;   /* division separators (1.5 px) */

  /* ink */
  --ink: #16191d;           /* primary text, pressed chips, selected ring */
  --ink-2: #4a525b;         /* titles, secondary text */
  --ink-3: #646c75;         /* meta text (≥ 4.5:1 on every surface) */
  --ink-inverse: #ffffff;   /* text on --ink fills */
  --focus-ring: #1d4fc9;
  --danger: #b42318;
  --live: #2f8a62;          /* status-pill dot */

  /* base hues */
  --dot: #2f8a62;           /* reference green: "a course" */
  --mini: #bcc2c9;
  --pre: #1d4fc9;           /* prerequisites (blue): dots, direct edges */
  --pre-ink: #1d4fc9;       /* blue text */
  --pre-soft: #6187da;      /* transitive prerequisite edges */
  --unl: #9250e0;           /* unlocks (violet): dots, direct edges; lighter than --pre on purpose */
  --unl-ink: #6e2fc4;       /* violet text */
  --unl-soft: #ad88ea;      /* transitive unlock edges */
  --prog: #b45309;          /* program text and program edges (amber, reserved) */
  --prog-ring: #d97706;     /* program dot fill and rings */
  --prog-wash: rgba(217, 119, 6, 0.10);
  --rec: #3b4450;           /* record glyphs when the node has no relation colour */
  --ready: #2f8a62;         /* "available now" ring */

  /* selection */
  --sel: #16191d;           /* selected ring and centre */
  --sel-plate: #16191d;     /* inverted label plate */
  --sel-plate-ink: #ffffff;
  --sel-wash: rgba(22, 25, 29, 0.035);  /* row and column wash */
  --sel-glow: transparent;  /* dark mode only */

  /* edges (all opaque; widths in section 7.4) */
  --edge-faint: #bfc5cc;    /* overview links, stubs, "show all connections" */
  --edge-hover: #8a929b;    /* hover preview of one node's links */

  /* lanes: two alternating tones per division (section 7.7) */
  --lane-sciences-1: #0b7c86;       --lane-sciences-2: #2a96a0;
  --lane-social-sciences-1: #c0283e; --lane-social-sciences-2: #d9566a;
  --lane-humanities-1: #a3367a;     --lane-humanities-2: #c6659f;
  --lane-professional-1: #7b5a2e;   --lane-professional-2: #a27f4c;
  --lane-interdisciplinary-1: #5f6b7a; --lane-interdisciplinary-2: #7f8a98;
  --lane-bullet-ink-1: #ffffff;     /* text on tone 1 */
  --lane-bullet-ink-2: #16191d;     /* text on tone 2 */

  /* semantic node tokens (what the renderer reads) */
  --node-default: var(--dot);
  --node-mini: var(--mini);
  --node-selected-ring: var(--sel);
  --node-prereq-direct: var(--pre);
  --node-prereq-transitive: var(--pre);     /* stroke of the hollow dot */
  --node-unlock-direct: var(--unl);
  --node-unlock-transitive: var(--unl);
  --node-program: var(--prog-ring);
  --node-completed: var(--rec);             /* used when the node has no relation colour */
  --node-in-progress: var(--rec);
  --node-planned: var(--rec);
  --node-available: var(--ready);

  /* semantic edge tokens */
  --edge-prereq-direct: var(--pre);
  --edge-prereq-transitive: var(--pre-soft);
  --edge-unlock-direct: var(--unl);
  --edge-unlock-transitive: var(--unl-soft);
  --edge-program: var(--prog);
  --edge-unrelated: var(--edge-faint);

  /* elevation */
  --shadow-card: 0 1px 2px rgba(20, 24, 28, 0.05), 0 1px 1px rgba(20, 24, 28, 0.03);
  --shadow-pop: 0 8px 28px rgba(20, 24, 28, 0.14), 0 1px 3px rgba(20, 24, 28, 0.08);
  --shadow-pill: 0 2px 8px rgba(20, 24, 28, 0.10);
  color-scheme: light;
}

:root[data-theme="dark"] {
  --page: #0f1216;
  --surface: #151a20;
  --surface-2: #181e25;
  --band: #1a2028;
  --field: #11151a;
  --hover: #1f262e;
  --line: #2a313a;
  --line-soft: #222830;
  --rule-strong: #3a434e;

  --ink: #e8ecf1;
  --ink-2: #b4bcc6;
  --ink-3: #8e98a4;
  --ink-inverse: #0f1216;
  --focus-ring: #8fb5ff;
  --danger: #ff8f80;
  --live: #4cb487;

  --dot: #4cb487;
  --mini: #424b57;
  --pre: #5e8ef5;
  --pre-ink: #8fb5ff;
  --pre-soft: #4a72b8;
  --unl: #c3a0ff;
  --unl-ink: #c9a9ff;
  --unl-soft: #9479d0;
  --prog: #f0a43a;
  --prog-ring: #e0952c;
  --prog-wash: rgba(240, 164, 58, 0.12);
  --rec: #c3cbd5;
  --ready: #4cb487;

  --sel: #f2f5f8;
  --sel-plate: #e8ecf1;
  --sel-plate-ink: #0f1216;
  --sel-wash: rgba(232, 236, 241, 0.05);
  --sel-glow: rgba(242, 245, 248, 0.30);

  --edge-faint: #404a56;
  --edge-hover: #7b8592;

  --lane-sciences-1: #3fb7c2;       --lane-sciences-2: #2a8e98;
  --lane-social-sciences-1: #f07285; --lane-social-sciences-2: #d45d6c;
  --lane-humanities-1: #df7fb6;     --lane-humanities-2: #c0649b;
  --lane-professional-1: #c9a06a;   --lane-professional-2: #a07c4a;
  --lane-interdisciplinary-1: #9aa5b3; --lane-interdisciplinary-2: #77828f;
  --lane-bullet-ink-1: #0f1216;
  --lane-bullet-ink-2: #0f1216;

  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-pop: 0 10px 30px rgba(0, 0, 0, 0.50), 0 1px 3px rgba(0, 0, 0, 0.40);
  --shadow-pill: 0 2px 10px rgba(0, 0, 0, 0.45);
  color-scheme: dark;
}
```

`body` MUST set `background: var(--page); color: var(--ink)`.

The semantic `--node-*` and `--edge-*` aliases are the only names the renderer may read. Base hues
may be retuned without touching renderer code.

### 3.2 Contrast notes (WCAG 2.1, computed on the values above)

| Pair | Light | Dark | Rule |
|---|---|---|---|
| `--ink` on `--surface` / `--band` | 17.6 / 16.3 | 14.7 / 13.8 | text ≥ 4.5 |
| `--ink-2` on `--surface` / `--band` | 7.9 / 7.3 | 9.1 / 8.5 | text ≥ 4.5 |
| `--ink-3` on `--surface` / `--band` / `--page` / `--hover` | 5.3 / 4.9 / 4.8 / 4.7 | 6.0 / 5.6 / 6.4 / 5.2 | text ≥ 4.5 (fixes A's 2.95 and B's 3.17) |
| `--pre-ink` on `--surface` / `--band` | 7.0 / 6.4 | 8.5 / 8.0 | text ≥ 4.5 |
| `--unl-ink` on `--surface` / `--band` | 7.3 / 6.8 | 8.8 / 8.3 | text ≥ 4.5 |
| `--prog` on `--surface` / `--band` | 5.0 / 4.6 | 8.4 / 7.9 | text ≥ 4.5 |
| `--sel-plate-ink` on `--sel-plate` | 17.6 | 15.8 | text ≥ 4.5 |
| `--ink-inverse` on `--ink` (pressed chips) | 17.6 | 15.8 | text ≥ 4.5 |
| `--danger` on `--surface` | 6.6 | 7.9 | text ≥ 4.5 |
| `--dot` on `--surface` / `--band` | 4.3 / 3.9 | 6.8 / 6.4 | graphic ≥ 3 |
| `--pre` / `--unl` on `--surface` | 7.0 / 4.7 | 5.6 / 8.2 | graphic ≥ 3 |
| `--pre-soft` / `--unl-soft` on `--surface` | 3.5 / 2.8 | 3.7 / 4.9 | secondary graphic. Dark ≥ 3 is a must-fix; light ≥ 2.5 |
| `--prog-ring`, `--ready` on `--surface` | 3.2, 4.3 | 7.1, 6.8 | graphic ≥ 3 |
| `--edge-faint` on `--surface` / `--band` | 1.74 / 1.61 | 1.94 / 1.82 | hairline ≥ 1.6 (judge target) |
| `--mini` on `--surface` / `--band` | 1.80 / 1.66 | 1.98 / 1.85 | de-emphasised by design, ≥ 1.6 |
| lane tone 1 / tone 2 on `--surface` | ≥ 4.9 / ≥ 3.5 | ≥ 6.2 / ≥ 4.4 | graphic ≥ 3 |
| bullet text on tone 1 / tone 2 | white ≥ 4.95 / ink ≥ 4.61 | dark ink ≥ 6.6 / ≥ 4.8 | text ≥ 4.5 |

Greyscale separation of the two path hues (relative-luminance ratio):

- Direct: `--unl` vs `--pre` is 1.48 in light and 1.47 in dark. Violet is the lighter of the two
  in both themes.
- Transitive: 1.25 in light and 1.35 in dark.

A's pair had a ratio of 1.05, so the hues were nearly indistinguishable in greyscale.

### 3.3 Canvas-only constants (`RENDER` in `renderer.ts`)

| Constant | Value |
|---|---|
| Faint edge width (overview) | 1.0 screen px |
| Hover-preview edge width | 1.25 |
| Transitive chain edge width | 1.15 |
| Direct chain edge width | 1.9 |
| Bundle trunk width | 2.6 |
| Bundle branch width | 1.4 |
| Program edge width | 1.4 |
| Unrelated edge width (Show all connections) | 1.0 |
| Corequisite dash | `[4, 3]` screen px, butt caps |
| Label knockout alpha | 0.9 (band colour) |
| Dark-mode glow | focus ring only: `shadowBlur 10`, `shadowColor var(--sel-glow)`; never on edges or bundles |

Edge widths are screen px and do not scale with zoom. Each width is at least 1 device pixel.

Every edge group is collected into one `Path2D` and stroked once with an opaque colour. Edges are
never stroked one by one with alpha. Overlapping curves of the same group therefore never darken
into ropes, and no offscreen compositing layer is needed.

---

## 4. Typography

### 4.1 Families

```css
--font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
--font-display: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
--font-zh: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
```

- Segoe UI Variable comes first because Windows is the target. Its zero is plain, so official codes
  look exactly as printed (CSC108H5), unlike B's slashed zero.
- No web font is loaded (owner decision 19.6); other platforms fall back to `system-ui`.
- When `lang = zh`, append `--font-zh` to `--font-ui` and `--font-display` through
  `:root[lang="zh-CN"]`.
- Course codes, titles and requirement text are always the English originals, set in the UI face.
- The canvas builds font strings from the computed `--font-ui`. It re-measures every cached label
  width on `document.fonts.ready` and on `document.fonts` `loadingdone`, then re-runs geometry.

### 4.2 Scale

DOM text uses CSS px. Canvas text uses world px and is scaled by zoom (section 8.12).

| Role | Size / weight / line height | Colour | Notes |
|---|---|---|---|
| Wordmark "UofT" + "Course Map" | 20 / 700 + 20 / 400, display | ink + ink-2 | letter-spacing −0.01em |
| Card title "Prerequisite map" | 18 / 600 / 1.2, display | ink | |
| Panel course title | 18 / 600 / 1.3, display | ink | wraps, never truncates |
| Body / controls | 13 / 400 / 1.4 | ink | chips, buttons, menus |
| Meta / secondary | 12 / 400 / 1.4 | ink-3 or ink-2 | counts, dates |
| Micro (badges, chip counts) | 11.5 / 500–600 | ink-3 | minimum DOM size, except `kbd` at 11 |
| Official requirement text | 12.5 / 400 / 1.55 | ink-2 | in a `--surface-2` block |
| Canvas compact code | 13 / 600 | ink | `CSC148H5` |
| Canvas full code | 13 / 600 | ink, `--pre-ink` (direct prerequisite), `--unl-ink` (direct unlock) | |
| Canvas full title | 12.5 / 400 | ink-2 | second line |
| Canvas focus code (plate) | 14 / 700 | `--sel-plate-ink` | |
| Canvas focus credit (plate) | 11.5 / 500, 75 % opacity | `--sel-plate-ink` | "0.5 cr" |
| Canvas focus title (plate) | 12.5 / 500, line height 16 | `--sel-plate-ink` | wraps to at most 3 lines |
| Lane name (sticky, DOM) | 13 / 600 / 1.25 | ink | single line, ellipsis |
| Lane meta (sticky, DOM) | 12 / 400 | ink-2 | tabular numerals |
| Lane bullet | 11.5 / 700, height 17, padding 0 5, radius 4 | `--lane-bullet-ink-*` | |
| Division label | 11.5 / 600 | ink-3 | sentence case, not uppercase |
| Band title (sticky, DOM) | 13 / 600 | ink | "100 level" |
| Band meta (sticky, DOM) | 12 / 400 | ink-3 | |

`font-variant-numeric: tabular-nums` MUST apply to every count, the zoom percentage, chip counts,
readout numbers, grades and credits. Canvas codes are proportional; that is acceptable because
codes are never compared in columns of digits.

---

## 5. Spacing, radii, borders, elevation

- **Spacing scale:** 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32. Use nothing else in chrome.
- **Radii:**
  - 4: `kbd`, lane bullet
  - 5: code chips
  - 6: segmented thumb, focus plate
  - 7: zoom buttons, small buttons
  - 9: search box, segmented track, tooltip
  - 10: popovers, group cards
  - 12: graph card, right panel
  - 999: chips, pills
- **Borders:** 1 px `--line` everywhere. Division separators are 1.5 px `--rule-strong`.
  Focus rings are 2 px `--focus-ring` with a 2 px offset (−2 px inside the graph area).
- **Elevation:**
  - `--shadow-card`: graph card, right panel
  - `--shadow-pop`: search results, menus, tooltips
  - `--shadow-pill`: edge-of-view pills
  - Nothing else casts a shadow.
- **DOM stacking (z-index):**
  - 0: canvas
  - 1: sticky header overlays (lane column, band bar, corner)
  - 2: scrollbars and rulers
  - 3: edge-of-view pills
  - 5: tooltip
  - 20: popovers and menus
  - 30: toasts (import/export results)

---

## 6. Layout and app chrome

### 6.1 Breakpoints and measured frames

The target is desktop Windows. The three supported frames correspond to a 1080p panel at 100 %,
125 % and 150 % display scaling.

| Class | Viewport (CSS) | Header h | Page gutter | Panel w (open / rail) | Gap card↔panel | Footer h |
|---|---|---|---|---|---|---|
| wide | ≥ 1700 (1920 × 1080 @ DPR 1) | 60 | 24 | 360 / 48 | 16 | 32 |
| standard | 1440–1699 (1536 × 864 @ DPR 1.25) | 52 | 16 | 320 / 48 | 12 | 28 |
| compact | 1280–1439 (1280 × 720 @ DPR 1.5) | 52 | 12 | 300 / 48 | 10 | 28 |
| below 1280 | unsupported but functional | 52 | 12 | panel overlays the right of the graph and framing treats it as an obstacle | — | 28 |

Below 1280, a dismissible 32 px notice under the header reads "Best on a desktop window at least
1280 px wide."

Page structure (column flex, `overflow: hidden`, `height: 100vh`):

```
header (full width)
main  = padding [top: 16 | 12 | 10] [x: gutter] [bottom: 12 | 10 | 8]
        row: [graph card: flex 1, min-width 0] [gap] [right panel or rail]
footer disclaimer (full width)
```

Graph card internals, from top to bottom:

```
head row     padding 14 16 0 (standard/compact: 12 14 0), min-height 32 (28)
toolbar      margin 10 0 (8 0), padding 0 16 (0 14), height 32 (30)
graph area   flush left/right with the card, 1 px top border --line, flex 1
legend strip height 32 (30), 1 px top border --line, background --surface-2, padding 0 16
```

Resulting canvas sizes, with the panel open:

| Frame | Canvas (w × h) | Plot area after lane header 176 and band header 60 |
|---|---|---|
| 1920 × 1080 | 1494 × 826 | 1318 × 766 |
| 1536 × 864 | 1170 × 642 | 994 × 582 |
| 1280 × 720 | 944 × 502 | 768 × 442 |

With the panel collapsed to its rail, add 312 / 272 / 252 px of width respectively.

```
1920 × 1080 (wide, panel open)
┌──────────────────────────────────────────────────────────────────────────────────────────────┐ 0
│ [mark] UofT Course Map  [UTM|St. George·Soon] (● 2026–2027 Calendar) Data fetched Oct 8, 2026 │
│                [Search courses or programs   /] [Programs] [My courses 3] [EN|中文] [Sys|Light|Dark] │ 60
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ graph card 1496 ────────────────────────────────────────────┐ ┌ panel 360 ──────────────┐ │ 76
│ │ Prerequisite map  70 subjects · all 2,491 courses  <hint or context strip>  │ │ Course | Program | My… »│ │
│ │ Level [All][100 144][200 506][300 1,105][400 736] | [Subjects ▾] | [Hide unrelated]  │ │ CSC148H5 0.5 credit…    │ │
│ │   [Direct only][Show all connections][Hide completed][Titles]   [−][100%][+][Fit width] │ │ Introduction to …      │ │
│ ├──────────┬───────────────────────────────────────────────────┤ │ [Not taken|Planned|…]  │ │
│ │ Subject  │ 100 level        │ 200 level   │ 300 level  │ 400 │ │ Needs … / Unlocks …    │ │
│ │ 70 lanes │ First year · …   │ …           │ …          │     │ │ Prerequisites          │ │
│ │──────────┼──────── scale bar ─────────────────────────────── │ │ ┌official text┐        │ │
│ │ ▌Sciences│                                                    │ │ │ …           │        │ │
│ │ ▌Astron… │   canvas plot 1318 × 766                           ┃ │ │ parsed tree …          │ │
│ │ ▌Biology │                                                    ┃ │ │ Corequisites …         │ │
│ │  …       │                                                    ┃ │ │ Exclusions …           │ │
│ ├──────────┴───────────────────────────────────────────────────┤ │ Description …          │ │
│ │ ◉ Selected ● Needed directly ○ Needed earlier ● Unlocks directly ○ Unlocks later …   │ │                         │ │
│ └──────────────────────────────────────────────────────────────┘ └─────────────────────────┘ │ 1036
│ Unofficial planning tool. Requirements change — always confirm in the official UTM Academic…  │ 1080
└──────────────────────────────────────────────────────────────────────────────────────────────┘

1536 × 864 (standard, panel open)
┌────────────────────────────────────────────────────────────────────────────────┐ 0
│ [mark] UofT Course Map [UTM|St. George·Soon] (● 2026–2027 Calendar)            │
│                    [Search… /] [Programs] [My courses] [EN|中文] [Sys|Light|Dark] │ 52
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌ graph card 1172 ───────────────────────────────────────┐ ┌ panel 320 ──────┐ │ 64
│ │ Prerequisite map  <context strip>                       │ │ tabs           »│ │
│ │ Level [All][100][200][300][400] | [Subjects ▾] | [View ▾ •2]  [−][92%][+][Fit] │ │ … │ │
│ │ lane 176 │ plot 994 × 582                                │ │                 │ │
│ │ legend strip 30                                          │ │                 │ │
│ └──────────────────────────────────────────────────────────┘ └─────────────────┘ │ 826
│ footer disclaimer 28                                                            │ 864
└────────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Header

- Height 60 (wide) or 52. Background `--surface`, bottom border 1 px `--line`.
- Horizontal padding equals the page gutter. Children are vertically centred, with a gap of
  14 (wide) or 10.
- Left to right:
  1. **Brand.**
     - A 26 × 26 mark: a rounded square, radius 7, filled `--ink`.
     - Inside the mark, an S-curve from a `--pre-soft` dot at the lower left to an `--unl-soft`
       dot at the upper right, stroke 1.6 in `--surface`.
     - Wordmark "UofT" at 700 + "Course Map" at 400 in ink-2, 20 px display.
     - The whole brand links to `#/utm` and clears the selection.
  2. **Campus switcher.** A segmented control with two segments: `UTM` (pressed) and
     `St. George` + a "Soon" micro badge (11.5 / 600, 16 px pill on `--hover`).
     - The second segment is `aria-disabled="true"`, has no hover, uses `cursor: not-allowed` and
       ink-3 text.
     - Its tooltip reads "St. George — coming soon".
     - The segments come from `public/data/campuses.json`. Planned campuses render disabled with
       the "Soon" badge.
  3. **Status pill.**
     - Height 30, radius 999, background `--hover`, border 1 px `--line-soft`, 13 / 600.
     - A 7 px `--live` dot with a 3 px halo at 18 % opacity.
     - Text: "2026–2027 Calendar". In the compact class: "2026–27".
     - Tooltip: "Official UTM Academic Calendar 2026–2027 · fetched Oct 8, 2026 · 2,491 courses,
       168 programs".
  4. **Fetch date** (wide class only): "Data fetched Oct 8, 2026", 12.5 px ink-3.
  5. Flexible spacer.
  6. **Search** (section 6.9.1).
     - Width 340 (wide), 280 (standard) or 240 (compact); height 36; radius 9; border `--line`.
     - Background `--field`, a 15 px magnifier in ink-3, and a `kbd` "/" at the right.
     - Focus: the border mixes 55 % `--focus-ring` into `--line`, with a 3 px ring of
       `--focus-ring` at 14 %.
  7. **Programs button.** Height 32, radius 7, border `--line`, icon + "Programs".
     - When a program is active, the label becomes the program's short title (ellipsis at 160 px)
       followed by an inline 16 px clear button.
     - Clicking opens the Program tab.
  8. **My courses button.** Same style as Programs, with a count badge (11.5 / 600, tnum,
     18 px pill on `--ink` with `--ink-inverse` text) when the record has entries. Opens the
     My courses tab.
  9. **Language** segmented control: `EN` | `中文`.
  10. **Theme** segmented control: `System` | `Light` | `Dark`. In the compact class the segments
      are icon-only (monitor, sun, moon) and keep their `aria-label`s.

Segmented control:

- Track: padding 3, gap 2, border 1 px `--line`, radius 9, background `--field`.
- Segments: height 28 (26 in the campus control), padding 0 12, radius 6, 13 px ink-2.
- Hover: ink text.
- Checked: background `--ink`, text `--ink-inverse` at 600.
- Uses `role="radiogroup"` and `role="radio"` with `aria-checked`.

### 6.3 Graph card head row

`display: flex; align-items: baseline; gap: 12px; white-space: nowrap`.

1. **Title.** `h2` "Prerequisite map", 18 / 600 display.
2. **Meta**, 13 px ink-2.
   - With no filter: "70 subjects · all 2,491 courses".
   - When filters hide courses: "1,203 of 2,491 courses shown".
   - In the wide class the meta stays visible during a selection. In standard and compact it
     hides while a course is selected.
3. **Hint**, the default state. 13 px ink-3, ellipsis. "Lanes are subjects; columns run from first
   to fourth year. Click a course to see what it needs (blue) and what it unlocks (violet). Drag to
   pan · Ctrl + wheel to zoom."
4. **Start strip**, shown instead of the hint on a first visit only (no stored prefs and no hash).
   - Text: "Start here: search a course (/), pick a program, or jump to a subject:"
   - Then up to 6 subject chips (height 26: bullet + code) from the campus registry field
     `startSubjects`. For UTM: CSC, MAT, STA, ECO, PSY, BIO.
   - Then an "All subjects…" link that opens the subject picker.
   - Clicking a chip scrolls its lane to the top of the plot and stores `prefs.home`.
   - After the first selection, jump or program pick, the strip is replaced by the hint for good
     (`prefs.onboarded = true`).
5. **Context strip**, which replaces the hint while a course is selected:
   - A code plate: 13 / 700 on `--sel-plate`, radius 5, padding 2 7.
   - The title: 13 px ink-2, max-width 320, ellipsis with a `title` attribute. The full title
     lives on the graph plate and in the panel.
   - The needs and unlocks readouts (6 px coloured dot + text, numbers 600 ink, tnum):

     | Case | Needs readout | Unlocks readout |
     |---|---|---|
     | Parsed rule, no alternatives | "● Needs 2 directly · 5 in total" | "● Unlocks 9 directly · 45 in total" |
     | One top-level `any` group | "● Needs 1 of 4 directly · 9 related in total" | (same as above) |
     | Several alternative groups | "● 4 direct prerequisites, some are alternatives · 9 related in total" | (same as above) |
     | `unknown` top-level rule | "● 4 direct prerequisites · see official text · 9 related in total" | (same as above) |
     | None | "No prerequisites listed" | "Unlocks nothing in this calendar" |

   - When filters hide chain courses: "· 3 hidden by filters" in ink-3.
   - `Details` button, shown only when the panel is collapsed. Height 24, radius 7.
   - `Clear` button, height 24, radius 7, border `--line`, 12 px ink-2, `title="Clear selection
     (Esc)"`.

### 6.4 Toolbar

`display: flex; align-items: center; gap: 6px`. Groups are separated by a 1 × 18 px `--line`
divider with 8 px margins.

1. **Level.**
   - The label "Level" in 13 px ink-2, then chips `All` · `100` · `200` · `300` · `400`.
   - Each level chip carries a count (11.5 px ink-3, tnum) of the courses visible at that level
     under the current subject filter.
   - Click solos a level. Ctrl or Shift + click adds or removes a level (multi-select, stored as
     `levels`). `All` resets.
   - Pressed chips: background `--ink`, text `--ink-inverse` at 600, count at 65 % of
     `--ink-inverse`.
2. **Subjects ▾.** A chip-styled button reading "Subjects: All" or "Subjects: 12 of 70",
   which opens the subject picker (section 6.9.2).
3. **Toggles.** Chips with `aria-pressed`. They are inline in the wide class and live in a
   `View ▾` menu button in standard and compact. The menu button shows a badge with the number of
   active toggles, and the menu lists the same items as checkboxes.

   | Toggle | Store key | Behaviour |
   |---|---|---|
   | Hide unrelated | `hideUnrelated` | Tooltip: "Courses outside the chain: hide instead of grey dots". Disabled when nothing is selected and no program is active. |
   | Direct only | `depth = 'direct'` | Chain = selection + direct prerequisites + direct unlocks. |
   | Show all connections | `showAllEdges` | Overview: draws long edges in full instead of stubs. Selection or program: also draws unrelated links in `--edge-unrelated`. |
   | Hide completed | `hideCompleted` | Disabled with the tooltip "Mark courses in My courses first" while the record is empty. |
   | Titles | `titles` (new pref) | Overview: every visible course shows its title (full class). Selection: transitive chain courses show titles even when "chain titles: auto" would drop them. |

   Toggle chip states:
   - Off: `--surface` background, 1 px `--line` border, ink text, and a leading 10 px circle
     outline (1.25 px ink-3). Off chips look clickable; there are no dashed outlines.
   - On: pressed style plus a leading check glyph in `--ink-inverse`.
4. Flexible spacer.
5. **Zoom.** `−` · value · `+` · `Fit width`.
   - Buttons: height 30, min-width 32, padding 0 10, radius 7, border `--line`, 13 px.
   - The value is a 56 px button showing "92%" in tnum. Clicking it resets zoom to 100 %
     (`title="Reset to 100% (1)"`).

Chip base: height 30, padding 0 13, radius 999, border 1 px `--line`, background `--surface`,
13 px ink. Hover background `--hover`.

The legend does not fit in the toolbar at 1536 px together with the required controls. The
complete legend therefore lives in the legend strip directly under the graph (section 6.6), which
is part of the same card.

### 6.5 Graph area

- `position: relative; overflow: hidden; background: var(--surface)`.
- Cursor: `grab`; `grabbing` while dragging; `pointer` over a node.
- Uses `tabindex="0"` and the accessibility attributes in section 12.
- Children:
  - The canvas, absolutely filling the area.
  - DOM overlays for the corner cell, the sticky band bar, the sticky lane column, the scrollbars
    with rulers, the edge-of-view pills and the tooltip.
- Header text is DOM, not canvas, so that it gets tabular numerals, ellipsis, Chinese fonts and
  accessibility. The renderer positions the overlays every frame using transforms only.

### 6.6 Legend strip

- Height 32 (30), background `--surface-2`.
- Items: 12 px ink-2, gap 16. Each item is an inline 22 × 12 SVG glyph drawn with the same tokens
  as the canvas, followed by its label.
- The strip never scrolls. When items overflow, the lowest-priority items (listed last below) move
  into a `+3 more` popover.

| Mode | Items, in priority order |
|---|---|
| Overview | ● Course · thin line: "Prerequisite link (earlier → later)" · stub glyph: "Link to a distant subject (hover to trace)" · dashed: "Corequisite" |
| Course selected | ◉ Selected · ● Needed directly · ○ Needed earlier · ● Unlocks directly · ○ Unlocks later · • Not in this chain · fork glyph: "Any one of these" · dashed: "Corequisite (take together)" |
| Program active | ● Program course · amber line: "Link inside the program" · • Not in program |
| Record non-empty (appended in every mode) | check square: Completed · half disc: In progress · dashed ring: Planned · ringed dot: Available now |

The right end of the strip holds a 12 px ink-3 hint: "Drag to pan · Ctrl + wheel to zoom · ?
shortcuts".

### 6.7 Right panel host

The host contains the course details, the program picker and panel, and "My courses".

- Width: 360 (wide), 320 (standard) or 300 (compact). Full height of `main`.
- Background `--surface`, border 1 px `--line`, radius 12, `--shadow-card`.
- Layout: a column with a sticky tab bar and a scrolling body.
- **Tab bar**:
  - Height 44, background `--surface-2`, bottom border `--line`.
  - Tabs `Course` · `Program` · `My courses (n)`, each 13 / 600, padding 0 12.
  - The active tab has a 2 px `--ink` underline. Uses `role="tablist"`.
  - At the right, a 28 × 28 collapse button (») with `title="Collapse panel"`.
- **Rail** (collapsed state):
  - A 48 px wide card with three stacked 40 × 40 icon buttons (course, program, my courses).
    Each has a tooltip and a 6 px dot indicator when its content is active.
  - Clicking a rail button expands the panel to that tab.
  - The collapsed state is stored in `prefs.panelCollapsed`.
- **Opening rules**:
  - Selecting a course opens the Course tab unless the user collapsed the panel; in that case the
    rail's course dot lights.
  - Clearing the selection keeps the panel on its current tab and shows the empty state.
  - The canvas resizes through `ResizeObserver`, and framing always uses the current plot size.

#### 6.7.1 Course tab (`CoursePanel`)

**Empty state:** "Pick a course on the map, or search (/) to see its official requirements."
Below it, "Recently viewed" chips (session only, at most 6).

**Header** (padding 16, bottom border `--line-soft`):

1. A code plate (13 / 700, `--sel-plate` / `--sel-plate-ink`, radius 5, padding 2 7), then meta in
   12 px ink-3: "0.5 credit · 100 level · Sciences". Add "· Delivered at Sheridan" when
   `deliveryCampus` is set.
2. The title, 18 / 600 display, full text, wrapping.
3. Record control: a segmented control at full width, height 30, with
   `Not taken | Planned | In progress | Completed`. When `Completed` is selected, a row appears
   below it: "Grade (optional)" followed by a 64 px number input (0–100, tnum) and "%".
4. Links: "Official calendar page ↗" (opens `coursePageTemplate` with `{slug}` = lower-case code,
   `target="_blank" rel="noopener"`) and "Center on map" (calls `onCenter`).

**Summary** (padding 12 16):

- Two rows reuse the readout copy from section 6.3, each led by a coloured dot.
- Each row has a disclosure that reveals its list. The lists are open by default; they double as
  the screen-reader chain list (section 12).
  - Needs: "Needed directly" chips, then "Needed earlier" chips.
  - Unlocks: "Unlocks directly", then "Unlocks later". Show the first 24, then
    "Show all 45".
- Code chips: height 24, padding 0 7, radius 5, border `--line`, 12.5 / 600, with a leading 6 px
  dot in the relation colour (hollow for transitive). Clicking a chip selects that course.

**Sections** (padding 14 16; heading 13 / 600 ink; 10 px gap):

1. **Prerequisites.**
   - The official text in a block: background `--surface-2`, 3 px left border `--line`,
     padding 8 10, 12.5 / 1.55 ink-2.
   - Then the parsed tree from the engine's `EvalNode`.
     - `all` and `any` render as nested lists headed "All of" / "One of".
     - Leaves are code chips with a status icon when a record exists: met (check, `--ready`),
       unmet (cross, ink-3) or unknown (question mark, ink-3).
     - `credits` leaves read "4.0 credits (2.0 earned)".
     - `minGrade` leaves read "CSC148H5 with ≥ 60 %".
   - For an `unknown` top-level rule, show an info row instead of the tree: "We could not read the
     structure of this requirement. Read the official text above."
   - "Also mentioned, not drawn": references that are excluded from the layout (cycle or
     backward), with the reason "higher-level alternative" or "breaks a loop".
2. **Corequisites.** Text + chips.
3. **Recommended corequisites and preparation.** Shown only when the data has them. Marked
   "(not required)".
4. **Exclusions.** Text + chips. When a completed or in-progress course triggers an exclusion, add
   a row in `--danger`: "You have CSC108H5 on your record, which excludes this course."
5. **Restrictions and notes.**
6. **Not in this calendar.** Unresolved references (section 15) as chips with a dashed border, in
   ink-3. Tooltip: "MAT137Y5 is referenced but is not offered in the 2026–2027 UTM calendar."
7. **Description.** Lazy-loaded from `details.json`, with three skeleton lines of 10 px bars on
   `--line-soft` while loading.

**Footer**: "Source: UTM Academic Calendar 2026–2027 ↗", 12 px ink-3.

#### 6.7.2 Program tab (`ProgramPanel`)

**No program selected: picker.**

- A search input (height 34): "Search 168 programs".
- Type filter chips with counts: `All` · `Specialist` · `Major` · `Minor` · `Certificate` ·
  `Other`.
- List rows (min-height 52, padding 8 12, hover `--hover`):
  - Title: 13 / 600, at most 2 lines.
  - Meta: "Major · ERMAJ1688", 12 px ink-3.
- Clicking a row calls `actions.selectProgram`.

**Program selected.**

- Header:
  - A type chip plus the code (12 px ink-3).
  - The title (18 / 600 display).
  - "Official program page ↗" and "Clear program".
- Progress: "Completed 3 of 12 listed courses", with a 6 px bar (`--prog-ring` on `--line-soft`,
  radius 3).
- "Take next" (at most 5, from `engine.nextCourses`).
  - Each row: code chip, title (ellipsis) and a reason line in 12 px ink-3.
  - Reasons: "Ready: prerequisites met" / "Needs MAT135H5" / "Check the official requirements".
- Requirement groups as cards (border `--line`, radius 10, padding 12, gap 10). Each card shows:
  - The label (13 / 600), a category chip (Admission / Completion) and a status chip
    (met / unmet / unknown).
  - The official text, clamped to 4 lines with a "Show more" link.
  - Course chips, styled by record state.

#### 6.7.3 My courses tab (`RecordPanel`)

- Note, 12 px ink-3: "Saved only in this browser. Nothing is uploaded."
- Three stat tiles (each 1/3 width, padding 10, radius 10, border `--line`):
  - Completed n (n.n credits)
  - In progress n
  - Planned n
- "Add a course…": a search field. Picking a course adds it with a status menu that defaults to
  `Completed`.
- Rows are grouped by status, with height 36 per row.
  - Each row: record glyph, code 13 / 600, title 12.5 px ink-2 (ellipsis), grade (tnum), a status
    menu and a 28 × 28 remove button.
- Footer actions:
  - `Import JSON`
  - `Export JSON` (downloads `uoft-course-map-record.json`)
  - `Clear all`, which turns into an inline confirmation: "Clear all 12 courses? [Cancel] [Clear]",
    with Clear in `--danger`.
- Import errors from `parseRecord` show inline in `--danger`.

### 6.8 Footer disclaimer

- Full width, height 32 (28), padding 0 gutter, 12 px ink-3, centred vertically.
- Background `--page`, no border.
- Text: "Unofficial planning tool. Requirements can change: always confirm with the official UTM
  Academic Calendar ↗. Data: 2026–2027 calendar, fetched Oct 8, 2026."
- The link goes to `calendarUrl` from the campus registry.

### 6.9 Popovers and overlays

All popovers: `--surface`, border `--line`, radius 10, `--shadow-pop`, padding 4. Open with a
120 ms fade (section 17). Close on Esc or an outside click.

#### 6.9.1 Search results

- Anchored 6 px below the search box, with the same width.
- At most 8 course rows, then a "Programs" group label (11.5 / 600 ink-3) and at most 3 program
  rows.
- Course rows: a grid of `84px 1fr auto`, padding 7 9, radius 7.
  - Code 13 / 600 tnum, then the title in 12.5 px ink-2 with ellipsis, then the subject bullet.
  - The matched substring is set at 600 weight.
- The active row (arrow keys) and hovered row use `--hover`.
- Ranking:
  1. Code prefix match (spaces ignored; case-insensitive; "csc 148" matches CSC148H5).
  2. Code contains the query.
  3. Title starts with the query.
  4. Title contains the query.
  5. All query words appear in the title.
  6. Program title or code.
  7. Ties sorted by code.
- Empty state: "No course or program matches “xyz”."
- Picking a course selects it and frames the chain. Picking a program selects the program.

#### 6.9.2 Subject picker

- 360 × min(560, viewport − 160).
- A search field at the top, then the quick actions `All` · `None` · `Only pinned`.
- A scrolling list grouped by division. Each group header shows the division label (11.5 / 600
  ink-3) with a 3 px division-tone bar.
- Rows (height 32):
  - A visibility checkbox, the bullet, the name (ellipsis), a course count (tnum, ink-3), a pin
    button and a "Jump" button that appears on hover.
  - Clicking a row's name jumps: the lane scrolls to the top of the plot and `prefs.home` is set.
- The list scales to all 70 UTM subjects and to any later campus.
- Pinning (owner decision 19.2): pinned subjects render first, in pin order, above a 1.5 px
  `--rule-strong` separator labelled "Pinned". The rest follow in the architecture order. Pins are
  stored in `prefs.pins`, never in the URL.

#### 6.9.3 Other popovers

- **View menu** (standard and compact): the five toggles as checkbox rows of height 32.
- **Shortcuts help** (`?`): a two-column table of the keys in section 11.3.
- **Lane menu**: a 24 × 24 kebab button that appears on lane-header hover. Items: "Pin to top",
  "Show only this subject", "Hide this subject".

#### 6.9.4 Graph tooltip

- Appears 350 ms after hover rests on a node. Hides immediately on move-out, drag or wheel.
- Placed 16 px right and 14 px below the cursor, flipped to stay inside the graph area.
- max-width 340, padding 9 11 10, radius 9, 12 / 1.4.
- Content:
  1. Code (13 / 700) and record status.
  2. Full title (12.5 / 500 ink).
  3. Relation, in words and in the relation colour: "Needed directly" · "Needed earlier" ·
     "Unlocks directly" · "Unlocks later" · "Not in this chain" · "In program".
  4. "Prerequisites: <official text>", clamped to 3 lines.
  5. "Corequisites: …" when present.

---

## 7. Graph visual language

### 7.1 Node states

Radii are world px and scale with zoom. The minimum screen radius is 2 for labelled nodes and 1.3
for minis. Every dot except minis first gets a knockout disc in its band's background colour at
r + 1.25, so crossing curves visibly pass behind it.

| State | Glyph | Radius | Fill / stroke | Code text | Title |
|---|---|---|---|---|---|
| Default, compact (overview) | filled disc | 3.75 | `--node-default` | 13 / 600 ink | — |
| Default, full (Titles on, or program courses) | filled disc | 4.25 | `--node-default` | 13 / 600 ink | 12.5 / 400 ink-2 |
| Mini (not in chain / not in program) | filled disc, no label | 2.25 | `--node-mini` | — | — |
| Selected (focus) | ring + centre | ring r 8.5 (2 px stroke), centre r 4 | `--node-selected-ring` on a knockout disc of r 10.5. Dark mode adds the glow (3.3). | plate (7.5) | plate, full title |
| Prerequisite, direct | filled disc | 5 | `--node-prereq-direct` | 13 / 600 `--pre-ink` | ink-2 |
| Prerequisite, transitive | hollow disc | 4.25 | `--surface` fill, 1.6 px `--node-prereq-transitive` stroke | 13 / 600 ink | ink-2, or none when chain titles are "direct" |
| Unlock, direct | filled disc | 5 | `--node-unlock-direct` | 13 / 600 `--unl-ink` | ink-2 |
| Unlock, transitive | hollow disc | 4.25 | `--surface` fill, 1.6 px `--node-unlock-transitive` stroke | 13 / 600 ink | ink-2, or none |
| Program course (program mode) | filled disc + ring | 4.25, ring r + 3.5 at 1.5 px | `--node-program` fill and ring | 13 / 600 ink | ink-2 |
| Program member inside a course chain | chain glyph + outer ring | ring r + 3.5, 2 px | `--node-program` ring | (chain style) | (chain style) |
| Program course outside the chain, during a selection | compact amber disc | 3.75 | `--node-program` | 13 / 600 ink | — |
| Hover | adds a ring | r + 4, 1.25 px | `--ink-3` | — | — |
| Keyboard cursor | adds a dashed ring and a label outline | r + 6, 1.5 px, dash `[3, 2]` | `--focus-ring`; label box outlined 1.5 px, radius 4, padding 3 | — | — |

### 7.2 Student record glyphs

Shape encodes the record and colour encodes the relation. A node with no relation uses `--rec`.
A node in the chain uses its relation colour.

| Record | Glyph (radius r of the state above) |
|---|---|
| Not taken | the state's disc (filled = direct/default, hollow = transitive) |
| Completed | rounded square, side 2r + 1, radius 2, filled in the colour, with a 1.5 px check in `--surface` |
| In progress | circle r with a 1.5 px stroke in the colour; the left half is filled |
| Planned | circle r with a dashed stroke `[2, 1.5]` (1.5 px) in the colour, plus a centre dot of r 1.5 |
| Available now (record non-empty, not taken, eligibility `met`) | the state's disc plus an outer ring at r + 3.5, 1.5 px `--node-available`. When the node also has a program ring, the program ring sits at r + 3.5 and the available ring at r + 6.5. |

Green means "a course" (the reference default dot), and a green ring means "you can take it now".
Neither is confused with the record states, which are told apart by shape.

### 7.3 Program highlight

- **Program mode** (a program is active and no course is selected):
  - Every course referenced by the program becomes full with the program glyph.
  - Every other course becomes mini.
  - Lanes whose visible nodes are all mini become slim.
  - Links between two program courses are drawn in `--edge-program` at 1.4 px (corequisites
    dashed).
  - A faint `--prog-wash` fills each program course's label box.
- **Course selected while a program is active:**
  - Chain colours win.
  - Chain members of the program get the 2 px amber outer ring.
  - Program courses outside the chain render compact amber (presentation must emit `compact` for
    role `program` when a focus exists; this is a change to `presentation.ts`).

### 7.4 Edges

Direction is always left to right: a prerequisite's out-port connects to the dependent's entry.

| Edge role (`EdgeRole`) | Colour token | Width | Dash | Layer |
|---|---|---|---|---|
| `faint` (overview, short) | `--edge-faint` | 1.0 | coreq `[4, 3]` | 2 |
| `faint` (overview, long → stubs, section 8.10) | `--edge-faint` | 1.0 | — | 2 |
| hover preview (the hovered node's links, overview only) | `--edge-hover` | 1.25 | coreq `[4, 3]` | 5b |
| `prereq` (transitive) | `--edge-prereq-transitive` | 1.15 | coreq `[4, 3]` | 4 |
| `unlock` (transitive) | `--edge-unlock-transitive` | 1.15 | coreq `[4, 3]` | 4 |
| `prereq-direct` | `--edge-prereq-direct` | 1.9 | coreq `[4, 3]` | 5 |
| `unlock-direct` | `--edge-unlock-direct` | 1.9; trunk 2.6, branches 1.4 (section 8.9) | coreq `[4, 3]` | 5 |
| `program` | `--edge-program` | 1.4 | coreq `[4, 3]` | 4 |
| unrelated during a selection (Show all connections only) | `--edge-unrelated` | 1.0 | — | 2 |

Dashes mean corequisite only. Corequisite edges come only from real corequisites; recommended
corequisites never become edges (section 15).

**"Any one of these" fork.**

- Applies when the selected course's prerequisite rule is parsed and contains an `any` node with 2
  or more course or `minGrade` leaves. The direct prerequisite edges of that group converge on a
  junction instead of arriving separately.
- Junction position: `x = focus entry x − 28`, `y = focus cy`. When there are several `any`
  groups, their junctions stack at cy ± 10 k.
- Junction glyph: circle r 3.5, `--surface` fill, 1.5 px `--pre` stroke. One 1.9 px segment runs
  from the junction to the focus entry.
- Hovering the junction shows a tooltip: "Any one of: MAT134H5, MAT136H5, MAT137Y5, MAT139H5".
- Transitive alternatives are not forked.
- An `unknown` rule gets no fork. Its edges are ordinary solid lines; the legend defines solid as
  "listed in the requirement text", not "required". The panel and readout carry the
  "see official text" state.

### 7.5 Selection devices

1. **Focus glyph and plate.**
   - Ring, centre and knockout as in 7.1.
   - The plate is a rounded rectangle (radius 6) at `x = col.x + 18`, vertically centred on the
     focus row, padding 6 8, filled `--sel-plate`.
   - Line 1: the code (14 / 700), then 8 px of space, then the credit "0.5 cr".
   - Lines 2–4: the title, wrapped at 260 px, at most 3 lines. If it is still longer, the third
     line ends in "…". Only titles over about 100 characters reach that point, for example
     CHM110-series titles; the full text stays in the tooltip and the panel.
   - The plate is never truncated to one line, and is drawn above everything in the plot.
2. **Row and column wash**, `--sel-wash`, drawn under every edge:
   - Row: the full plot width, from `cy − rowH/2` to `cy + rowH/2`.
   - Column: `col.x − 6` to `col.x + trackW + 6`, full content height.
3. **Ruler markers.**
   - ▸: a 6 × 8 triangle in `--sel` at the lane column's right edge, at the focus row (clamped
     inside the lane).
   - ▾: an 8 × 6 triangle at the bottom of the band header, at the focus dot's x (clamped inside
     the band).
4. **Header counts** (section 9). Lanes: "1 needed · 40 unlocked". Bands: "First year · 1 needed ·
   0 unlocked". Each number is led by a 6 px dot in `--pre` or `--unl`.

### 7.6 Faint overview texture

- Edges are opaque `--edge-faint`, 1.0 px, stroked once per path, so crossings never darken.
- Long edges become stubs (8.10). Together with the stubs, the 100 → 200 gaps carry only
  same-lane and near-lane curves, which removes the A/C "ropes".
- In dark mode the faint edges are 1.94:1 against the surface: visible but not glowing.

### 7.7 Lane colours

- Each division owns a two-tone family (tokens in 3.1).
- Lanes alternate tone 1 and tone 2 inside their division, in display order, so adjacent lanes
  always differ. The division is recognisable by hue.
- No lane colour is blue, violet, the default green or the program amber.
- Lane colour appears only in two places: the 3 px lane bar in the sticky lane column and the
  subject bullet. It never tints nodes or edges, because the graph's colour budget belongs to the
  chain.
- Division ids come from `subjects.json`: sciences, social-sciences, humanities, professional,
  interdisciplinary. A subject without a division uses the interdisciplinary tones.

---

## 8. Graph geometry

### 8.1 Constants

Replace `DEFAULT_GEOMETRY_OPTIONS` with the values below and extend `GeometryOptions` with the
marked fields. All values are world px.

```ts
export const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  laneHeaderWidth: 176,          // sticky lane column (DOM overlay width matches)
  bandHeaderHeight: 60,          // title line + meta line + scale bar
  lanePaddingY: 12,              // top and bottom padding inside a labelled lane
  laneMinHeight: 64,             // lane label block: name line + meta line with bullet + padding (9.1)
  laneSlimHeight: 30,            // NEW: lane whose visible nodes are all `mini`
  laneCollapsedHeight: 0,        // lane whose nodes are all `hidden` ("Hide unrelated", filters)
  bandPadLeft: 14,               // NEW
  bandPadRight: 10,              // NEW: replaces the last column's trailing gap
  columnGap: 28,                 // label end → next column's left edge (8 label pad + 20)
  miniColumnGap: 6,              // NEW: after a mini-only column
  colWidth: { full: 212, compact: 104, mini: 22 },   // maxima of one track; measured widths shrink them
  rowHeight: { full: 40, compact: 22, mini: 8 },
  focusRowHeight: 44,            // NEW: plus 16 per extra wrapped title line (max 3 lines → 76)
  miniPitch: 8,                  // horizontal and vertical pitch of packed mini dots
  miniGapAbove: 6,               // NEW: gap between the last labelled row and the mini grid
  miniPerRowMax: 10,             // NEW
  cellMaxHeight: { full: 720, compact: 440 },        // CHANGED to per class: wrap threshold
  trackGap: 8,                   // between wrapped tracks of one column (vs columnGap 28)
  dotInset: 8,                   // dot centre from the column's left edge
  labelX: 20,                    // NEW: label start from the column's left edge
  fullLabelMax: 184,             // NEW: max measured title or code width in a full label
}
```

A division label adds 17 px to that lane's minimum height (78).

`computeGeometry` gains a `labelWidth(index, cls) => number` argument that returns measured label
widths in world px:

- Compact: the code width at 13 / 600.
- Full: `max(code width, truncated title width)`, where the title is at 12.5 / 400 and capped at
  `fullLabelMax`.
- Focus: `max(code + credit width, wrapped title width) + 6`, where the code is at 14 / 700.

Geometry stays pure because the widths are passed in.

If a fit test in 16.2 (the 10.2 table) fails, tune in this order until it passes, and nowhere
else:

1. `columnGap` 28 → 24
2. `bandPadLeft` / `bandPadRight` 14 / 10 → 10 / 8
3. `fullLabelMax` 184 → 172

If a target still fails after step 3, that frame falls back to the next priority window (10.2,
step 4) plus edge-of-view pills. Record the outcome in the test as a known limit. Never lower the
0.92 floor or the type sizes to make a fit pass.

### 8.2 Display classes per state

| App state | Chain / program nodes | Everything else |
|---|---|---|
| Overview, Titles off | — | `compact` |
| Overview, Titles on | — | `full` |
| Course selected | focus `full` (plate). Direct prerequisites and unlocks `full`. Transitive: `full` when chain titles resolve to "all", `compact` when they resolve to "direct". | `mini`, or `hidden` with Hide unrelated |
| Program active, no course | program courses `full` | `mini` / `hidden` |
| Filters (level, subject, Hide completed) | the focus is never filtered out | `hidden` |

**Chain titles: auto.**

1. When a course is selected, and whenever the plot size changes, compute geometry with transitive
   nodes `full`.
2. If the chain's bounding box (8.12) fits the plot at zoom 0.92 with the framing margins of
   10.2, use it ("all").
3. Otherwise recompute with transitive nodes `compact` ("direct").
4. The Titles toggle forces "all".

This requires one new `PresentationInput` field: `chainTitles: 'all' | 'direct'`. Two geometry
passes are cheap (budget in 16.1).

### 8.3 Columns and bands

For each global column c, over all lanes:

- **Labelled column** (at least one visible `full` or `compact` node):
  - `trackW = labelX + maxLabelW + 8`, where `maxLabelW` is the largest `labelWidth` of the
    column's visible labelled nodes.
  - `trackW` is capped at `colWidth.full` when any node in the column is full, otherwise at
    `colWidth.compact`. The focus column may exceed the cap by its plate width.
  - `w = T·trackW + (T − 1)·trackGap`, where T is the maximum track count of the column's cells
    over all lanes (8.4).
  - The gap after the column is `columnGap − 8`.
- **Mini-only column** (visible nodes are all mini): `w = colWidth.mini` (22: two dots per row);
  gap after = `miniColumnGap`.
- **Empty column**: `w = 0`, no gap.

Bands:

- `x = previous band end`.
- The first visible column starts at `x + bandPadLeft`.
- The last visible column's trailing gap is replaced by `bandPadRight`.
- A band with no visible column has width 0 and its header is hidden (level filter).

Bands tile without seams. Odd bands (200, 400) get the `--band` wash across the full content
height and under the band header.

### 8.4 Cells

**Order inside a cell (lane × column):**

1. Labelled nodes in static topology `order`.
2. Then mini nodes in static order.

Hidden nodes take no space. Labelled nodes are therefore never pushed down by minis, and the first
labelled row of every cell in a lane starts at `laneTop + lanePaddingY`. This keeps CSC108H5 and
CSC148H5 on the same row (fixes B's ragged rows).

**Wrapping (tracks):**

- When the labelled stack height of a cell exceeds `cellMaxHeight[class]` (use `full` when any
  labelled node in the cell is full), the cell wraps into `T = ceil(H / cellMaxHeight)` tracks.
- The fill is column-major: fill track 1 top to bottom until its height reaches H / T, then
  track 2, and so on. Tracks are balanced, top-aligned and share one row grid.
- Tracks are never staggered, and edge-free courses are never laid out as a horizontal row.
- The track gap (8) is less than a third of the column gap (28), and the band-header scale bar
  marks tracks as notches inside one segment (9.2). Readers can therefore tell "same column,
  wrapped" from "next column (one dependency step later)".
- Example: ENG's 90-course 300-level cell, compact at 22 px rows with a 440 cap, wraps into 5
  tracks.

**Mini grid (labelled lanes):**

- The grid starts `miniGapAbove` below the tallest track of the cell.
- `perRow = min(miniPerRowMax, floor((w − 16) / miniPitch))`. Mini-only columns use 2. The same
  `perRow` applies to every lane in that column, so clusters align.
- The first dot centre is at `col.x + dotInset`, aligned with the labelled dots above, so clusters
  are not ragged.
- Rows are `miniPitch` apart.

**Slim lane** (dimming active and every visible node in the lane is mini):

- Height `laneSlimHeight` (30).
- Each cell draws a single row of minis on the lane's centre line:
  `perRow = floor((w − 4) / miniPitch)`.
- Dots beyond `perRow` are not drawn and not hit-testable (`NodeBox.overflow = true`, a new field).
  When the column has 30 px or more free after the row, a "+n" label (11 px world, ink-3) follows.
- Slim lanes keep their header (9.1) in single-line form.

**Collapsed lane** (all nodes hidden): height 0. The card meta reports it, for example "Showing 3
of 70 subjects (67 have nothing on this path)".

### 8.5 Lane height

- Labelled lane: `max(laneMinHeight (+17 with a division label), 2·lanePaddingY + tallest cell)`.
  The tallest cell = max track height + mini grid height.
- Slim lane: 30. Collapsed lane: 0.
- Lane separators are 1 px `--line` across the plot and the lane column.
- At a division boundary the separator is 1.5 px `--rule-strong`.

### 8.6 Label layout and truncation

Full label, two lines, vertically centred on the dot (`cy`):

- Code baseline (middle) at `cy − 8`, x = `col.x + labelX` (+ track offset).
- Title baseline (middle) at `cy + 8.5`.
- Row height 40, so a label box spans `cy − 15.5 … cy + 15.5` with 4.5 px of air top and bottom.

Compact label: the code centred at `cy + 0.5`; row height 22; box `cy − 8 … cy + 8`.

The only third line in the graph is the focus plate's wrapped title. The "meta line" (credit,
level, relation) lives in the tooltip and the panel.

Truncation (all but the focus):

1. Measure the title at 12.5 / 400. If it fits `fullLabelMax`, keep it.
2. Otherwise binary-search the longest prefix p with `measure(p.trimEnd() + '…') ≤ fullLabelMax`.
3. Strip trailing whitespace and the characters `, : ; - – — ( / &`, then append "…".
4. Codes are never truncated.
5. Cache widths per font string. Clear the cache on font load or language change.

**Knockout:**

- Before the dots are drawn, each visible labelled node gets a rectangle from `labelX − 3` to
  `labelEnd + 3`, spanning the label box height.
- The rectangle is filled with its band's background (`--surface` for even bands, `--band` for odd
  bands) at alpha 0.9.
- Knockouts are batched in two passes, one per band parity.

### 8.7 Edge anchors and curves

- **Out-port** (source):
  - Labelled source: `x_out = col.x + trackIndexOffset + trackW − 8 + 6`, which is the right edge
    of its track's content, at `y = cy`.
  - A highlighted edge starts with a straight leader from `labelEnd + 4` to `x_out`. The leader
    is not drawn for faint edges.
  - Mini source: `x_out = cx + 3`.
- **Entry** (target):
  - Labelled target: `x_in = col.x + trackIndexOffset − 2`, followed by a straight run to
    `cx − r − 1`.
  - Mini target: `x_in = cx − 3`.
- **Curve:** a cubic Bézier from `(x_out, y1)` to `(x_in, y2)` with
  `c1 = (x_out + k, y1)`, `c2 = (x_in − k, y2)` and `k = clamp(0.45 · (x_in − x_out), 16, 240)`.
  Tangents are horizontal at both ends. B's long straight diagonals are not used.
- **Wrapped source track (not the last track):**
  1. Step half a row into the row gap on the side of the target: an S of 14 px horizontal run.
  2. Run along that gap to the column's out-port.
  3. Curve from there.
- **Wrapped target track (not the first):** arrive in the row gap and S-step 14 px into the row
  just before the dot.

### 8.8 Corridor routing

New pure module `src/graph/routes.ts`. It runs after geometry for highlighted edges: chain,
program and hover preview.

1. **Obstacles:** the label box and dot box (r + 2) of every visible labelled node except the
   edge's own endpoints. Mini dots are not obstacles; minis are drawn above edges with a knockout
   halo (8.11).
2. **Test:** sample 20 points along the candidate path, after a bounding-box prefilter against a
   64 px spatial grid of obstacles. Any sample inside an obstacle inflated by 2 px is a hit.
3. **Candidate A:** the plain curve of 8.7.
4. **Candidate B, row-gap corridor:**
   1. From the source row, S-step into the nearest free row gap toward the target:
      `y = cy ± rowH/2`, 20 px run.
   2. Curve to the free row gap next to the target row.
   3. S-step into the target row.
   A gap is free when no obstacle in the columns strictly between the endpoints intersects that
   y ± 3.
5. **Candidate C, lane-padding corridor:**
   1. S-step from the source row to the corridor at `laneTop + lanePaddingY / 2` (or
      `laneBottom − lanePaddingY / 2`) of the source lane.
   2. Run horizontally to the target column's left gutter.
   3. Curve into the target.
   Lane padding never holds labels.
6. **Per-edge offsets:** edges that share a corridor are offset by 3 px each, ordered by target y,
   so they read as parallel lines and not as one heavy rule. The corridor run takes the edge's own
   colour.
7. **Fallback:** candidate A drawn beneath the knockouts. It is counted in a debug counter
   (`routes.fallbacks`), which is asserted to be 0 for the regression cases in 16.2.

Same-row links that skip columns always go through B or C. B's "bypass arch" is not used.

### 8.9 Fan bundling

- Applies when the focus has 6 or more direct edges in one direction (ECO200Y5: 41 unlocks;
  PSY100Y5: 64; STA256H5: 52; SOC221H5 and SOC222H5: 110).
- Group the targets by target column. For each group of 3 or more targets:
  1. Draw a **trunk** from the focus out-port to a split point at `x = targetCol.x − 22`,
     `y = clamp(median target cy, min cy, max cy)` of the group. Width 2.6.
  2. From the split point, draw a 1.4 px **branch** to each target, with `k = 0.5 · dx`.
- Groups of 1–2 targets are drawn normally.
- Trunk start points are staggered by 3 px per group around the focus `cy`, sorted by group
  median y, with a maximum of ± 9 px. The fan therefore spreads before it bends.
- Trunks use corridor routing like any edge.
- The same rule applies to direct prerequisite fans of 6 or more (for example STA256H5's
  prerequisites), mirrored.
- No glow, ever.

### 8.10 Overview long-edge stubs and hover preview

- **Long edge:** in the overview (no focus, no program) with Show all connections off, an edge is
  long when its endpoints are 3 or more visible lanes apart in display order.
- **Stub drawing:**
  - At the source: a 14 px horizontal stub from the out-port, ending in a 1.5 px-radius terminal
    dot.
  - At the target: a 10 px horizontal stub into the entry, starting with the same terminal dot.
  - Both in `--edge-faint`.
- **Hover preview:** hovering a node draws all of that node's edges at full length in
  `--edge-hover`, 1.25 px. Long edges are routed without corridors, for speed. The hover ring and
  tooltip appear as well.
- With Show all connections on, every faint edge is drawn at full length.

### 8.11 Z-order (canvas, bottom → top)

1. `--surface` fill.
2. Odd-band washes.
3. `--prog-wash` on program label boxes.
4. Selection row and column wash.
5. Lane separators and division separators.
6. Faint edges, stubs, and unrelated edges (Show all connections).
7. Transitive chain edges, then program edges.
8. Direct chain edges, bundle trunks and branches, fork junctions.
9. Hover-preview edges.
10. Mini dots: a knockout halo of r + 1 in the band background, then the dot. Batched in two
    passes by band parity.
11. Label knockouts.
12. Labelled dots, record glyphs, program rings, available rings.
13. Labels: codes, then titles.
14. Hover ring.
15. Focus: knockout, glow (dark), ring, centre, plate, plate text.
16. Keyboard cursor ring and label outline.

The DOM overlays (section 5) sit above the canvas: sticky band bar and lane column, corner,
scrollbars and rulers, edge-of-view pills, tooltip.

### 8.12 Semantic zoom and framing box

- **Zoom range:** 0.35–2.0. Buttons and keys step by × 1.2. Ctrl + wheel zooms by
  `exp(−deltaY · 0.0016)` around the cursor.
- **Label thresholds (rendered sizes):**
  - Titles draw when `12.5 · z ≥ 11` (z ≥ 0.88).
  - Codes draw when `13 · z ≥ 9.5` (z ≥ 0.73).
  - Below 0.73, only dots are drawn (and no knockouts).
  - The focus plate always draws. Below z = 0.86 it is drawn in screen space at code 12 / title
    11.5, so the selected course stays readable at any zoom.
- **Auto-frame floor:** 0.92. Automatic framing never sets a lower zoom. At 0.92, codes render at
  11.96 ≈ 12 px and titles at 11.5 px, which meets the must-fix floor on every frame in 6.1.
  Manual zoom may go lower.
- **Chain box:** the union of the dot and label boxes (plate for the focus) of all chain nodes,
  plus 12 px.
- **Program box:** the same, over program courses.

### 8.13 DPR and crispness

- Canvas backing size: `round(cssW · dpr) × round(cssH · dpr)`, followed by
  `setTransform(dpr, 0, 0, dpr, 0, 0)`.
- Re-read `devicePixelRatio` on resize and on a `matchMedia('(resolution: …dppx)')` change.
- Snap 1 px rules to device pixels: `x = (Math.round(x · dpr) + 0.5) / dpr`.
- Strokes are at least `1 / dpr` CSS px.
- Test at DPR 1, 1.25 and 1.5 (16.2). The hairlines, knockouts and 2.25 px mini dots are the
  elements most at risk.

---

## 9. Sticky headers, scale bar, rulers

### 9.1 Lane column (DOM overlay, width 176)

- **Lane element:**
  - Spans the lane's screen-space top and height.
  - A 3 px bar (radius 2) at x = 14, from lane top + 10 to lane bottom − 10, coloured with the
    lane tone.
- **Label block** (x = 26, right padding 10):
  1. Division label (first lane of each division only): 11.5 / 600 ink-3, for example "Sciences",
     17 px.
  2. Name: 13 / 600 ink, single line with ellipsis. `title` = "Computer Science (CSC) ·
     Department of Mathematical and Computational Sciences".
  3. Meta line: bullet `CSC` + 12 px ink-2 text.
     - Overview: "68 courses". With filters: "12 of 68 courses".
     - Selection: "● 1 needed · ● 40 unlocked", or "none in this chain".
     - Program mode: "5 in program".
- **Sticky behaviour:** `top = clamp(laneTop + 12, plotTop + 8, laneBottom − blockH − 8)`.
  - When the visible part of the lane is shorter than `blockH + 8`, switch to the single-line
    form: bullet + name with ellipsis.
  - When the visible part is shorter than 22 px, hide the label. The bar remains.
- **Slim lanes:** single-line form, vertically centred, with ink-3 text.
- **Hover:** background `--hover` and the kebab menu button (6.9.3).
- **Focus row marker:** ▸ (7.5).

### 9.2 Band bar (DOM overlay, height 60)

- **Band element:** spans the band's screen x-range. Odd bands get the `--band` background.
- **Text block** at top 12:
  - Title "100 level" (13 / 600).
  - Meta line (12 px ink-3):
    - Overview: "First year · 144 courses · 4 columns".
    - Selection: "First year · ● 1 needed · ● 0 unlocked".
    - Program mode: "First year · 3 in program".
- **Sticky clamp:** `left = clamp(bandLeft + 14, plotLeft + 14, bandRight − blockW − 10)`.
  - When the visible band width is less than `blockW + 20`, show the short form: "400" plus the
    counts only.
  - The label is never hidden while 40 px or more of the band is visible. This fixes A's
    disappearing "400 level".
- **Scale bar** (from B, rebuilt):
  - At y = 51–54 (3 px), one segment per visible sub-column.
  - A segment spans `col.x − 4` to `col.x + w + 4` (screen).
  - Segments alternate filled `--ink` and hollow (1 px `--ink` outline over the band background).
  - Wrapped tracks show as 1 px notches, 5 px tall, rising from the bar at track boundaries inside
    their column's segment.
  - Mini-only columns get a hollow segment at 50 % opacity.
  - The bar answers "why are CSC108H5 and CSC148H5 in different columns?" without words; the meta
    "4 columns" names it.
- **Focus column marker:** ▾ (7.5). The bottom rule is 1 px `--line`.

### 9.3 Corner cell (176 × 60)

- "Subject" (13 / 600 ink-2), then "70 lanes" (12 px ink-3).
- During a selection: "3 with chain courses".

### 9.4 Scrollbars and overview ruler (replaces B's locator)

- **Vertical bar:**
  - Track 10 px wide at the plot's right edge, from below the band bar to 12 px above the bottom.
  - Thumb radius 5, `--ink` at 22 % (38 % on hover or drag), minimum length 40.
- **Ruler marks** on the vertical track (proportional to world y):
  - Division boundaries: full-width 2 px marks in the division's tone 1.
  - During a selection, one 3 px mark per lane that contains prerequisites (`--pre`), unlocks
    (`--unl`) or both (split left/right).
  - In program mode, program lanes get amber marks.
  - Clicking a mark scrolls that lane to plot top + 24.
- **Horizontal bar:** 10 px, at the plot bottom, with 2 px band-boundary marks.
- Both bars hide when the content fits.

---

## 10. Viewport, landing and framing

### 10.1 Landing

Checked in priority order:

1. **Hash course** (`#/utm?course=CSC148H5`): select the course and frame its chain (10.2).
2. **Hash program:** program mode, framed to the program box with the same rules.
3. **`prefs.home`** (localStorage):
   - A subject: scroll its lane to plot top + 8 at zoom 1.0.
   - A program: activate it, which also writes it to the hash.
4. **First visit:**
   - Zoom 1.0, horizontally at the left edge.
   - Vertically, scroll so the lane of the campus registry's `startSubjects[0]` (UTM: CSC) is at
     plot top + 8.
   - Show the start strip (6.3) and focus the search input. The caret is visible; the dropdown
     stays closed until the user types.
   - The map never opens on the alphabetically first science lanes (Astronomy, Biology). See owner
     decision 19.1 for lane order.

The overview default zoom is 1.0 in every frame. "Fit width" fits the full world width, lane
header included, with a minimum of 0.35.

### 10.2 Framing a chain (hash, search, double-click, `F`)

1. Resolve chain titles (8.2).
2. Let `vw` be the plot width minus 16 px margins left and right, and `vh` the plot height minus
   20 px margins top and bottom. `z = clamp(vw / chainBox.w, 0.92, 1.0)`.
3. **If `chainBox.w · z ≤ vw`:** centre the box horizontally. If `chainBox.h · z ≤ vh`, place it
   with min(20, slack/2) at the top. Otherwise align the box top, unless the focus row would fall
   below 70 % of the plot height; in that case put the focus row at 30 %.
4. **Else** fall back through these priority windows, at z = 0.92, using the first that fits:
   1. Focus + all prerequisites + direct unlocks. Align the window's left edge at its leftmost
      node − 24.
   2. Focus + direct prerequisites + direct unlocks.
   3. Focus centred.
5. Show edge-of-view indicators (10.3) for whatever remains outside.

Expected results (acceptance targets in 16.2):

| Case | Expected framing |
|---|---|
| 1920 × 1080, panel open, CSC148H5 | The full chain, 100 through 400 level, at ≥ 0.92. Transitive nodes are compact. |
| 1536 × 864, panel open, CSC148H5 | Focus, CSC108H5 and every direct unlock (STA246H5 included) at ≥ 0.92, with a right-edge pill for the later unlocks. |
| MAT232H5, both frames | Every prerequisite, including MAT102H5 and MAT157H5 at the far left, is visible. C cut these off. |

### 10.3 Edge-of-view indicators

- Pills: height 24, radius 12, padding 0 10, 12 / 600, background `--surface`, border 1 px
  `--line`, `--shadow-pill`. Text is in the relation ink.
- Placement: 10 px inside the plot edge, kept clear of the scrollbar (16 px from the right) and
  never over the sticky headers.
  - Left and right pills are vertically centred on the focus row (clamped).
  - Top and bottom pills are horizontally centred on the focus column.
- Counts: chain nodes whose dots are outside the plot, per side. At most one pill per side.
- Copy:
  - "← 2 earlier prerequisites"
  - "19 later unlocks →"
  - "↑ 3 unlocks above"
  - "↓ 4 prerequisites, 2 unlocks below"
- Clicking a pill pans by the smallest amount that reveals the nearest hidden group, without
  changing the zoom.
- Pills update on every pan or zoom (throttled to animation frames) and disappear at count 0.

### 10.4 Click selection and clearing

- **Click a node:**
  1. Select it and recompute geometry.
  2. Translate the view so the clicked node keeps its screen position (anchor).
  3. Nudge the chain box into view: shift the view by the minimum needed so the box lies inside
     the plot with 16 px margins, preferring to keep the focus visible.
  - Zoom does not change, unless it is below 0.73 (labels invisible); in that case zoom to 0.92
    around the node.
- **Click the current focus:** no-op.
- **Click empty plot** (pointer travel under 3 px): clear the selection, anchored on the old focus
  position.
- **Double-click a node:** select it and frame (10.2).
- **Esc:** see 11.3.

---

## 11. Interaction

### 11.1 Component states

| Component | Rest | Hover | Focus-visible | Pressed / selected | Disabled |
|---|---|---|---|---|---|
| Chip | `--surface`, 1 px `--line`, ink | `--hover` | 2 px `--focus-ring` ring, offset 2 | `--ink` fill, `--ink-inverse` 600 | ink-3 text at 60 %, `--line-soft` border, `cursor: not-allowed`, no hover, tooltip explains why |
| Toggle chip | rest + 10 px circle outline | `--hover` | ring | pressed + check glyph | as chip |
| Segmented | track `--field`, ink-2 text | ink text | ring on the segment | `--ink` thumb, `--ink-inverse` 600 | ink-3 + "Soon" badge (campus) |
| Button (zoom, Clear, panel actions) | `--surface`, 1 px `--line`, radius 7 | `--hover` | ring | `--hover` + inset 1 px `--line` | as chip |
| Search input | `--field`, 1 px `--line` | border `--ink-3` | blue-mixed border + 3 px 14 % ring | — | — |
| Result / list row | transparent | `--hover` | `--hover` + ring inside | `--hover` (active by arrows) | — |
| Graph node | per 7.1 | hover ring, tooltip after 350 ms, hover preview edges (overview) | keyboard cursor ring + label outline (7.1) | focus glyph + plate | filtered nodes are hidden, never shown disabled |
| Lane header | — | `--hover` + kebab | ring on the kebab | — | — |
| Edge-of-view pill | per 10.3 | `--hover` | ring | — | — |

Focus-visible only. Mouse clicks show no ring (`:focus:not(:focus-visible) { outline: none }`).

### 11.2 Pointer

- **Drag** on the plot pans (3 px slop), with `cursor: grabbing`. Dragging never selects.
- **Wheel** scrolls vertically. Shift + wheel scrolls horizontally. Ctrl or Meta + wheel (and
  trackpad pinch) zooms at the cursor.
- **Scrollbar thumbs and ruler marks** are draggable or clickable (9.4).
- **Hit-testing:** a 64 world-px spatial grid holds each labelled node's dot + label box and an
  8 × 8 box per mini. Ties go to the nearest dot (vertical distance, plus 0.1 × horizontal).
  Overflow minis are excluded.

### 11.3 Keyboard shortcuts

Global keys are ignored while focus is in an input, except Esc.

| Key | Action |
|---|---|
| `/` or `Ctrl+K` | Focus search and select its text |
| `Esc` | Ladder: (1) close the open popover, menu or tooltip → (2) in search: clear the text and blur → (3) clear the course selection → (4) clear the program, only when no course is selected. The record is never cleared. |
| `+` / `=` | Zoom in × 1.2 (plot centre) |
| `-` | Zoom out ÷ 1.2 |
| `0` | Fit width |
| `1` | Zoom 100 % |
| `F` | Frame the current selection (10.2) |
| `?` | Shortcuts help |

With the graph region focused:

| Key | Action |
|---|---|
| Arrow keys | Move the keyboard cursor. Overview: Up/Down = previous/next node in the same track, then the adjacent lane's nearest node. Left/Right = the nearest node (by y) in the previous/next non-empty column of the same lane, then of adjacent lanes. Selection: from the focus, Left/Right go to the nearest direct prerequisite or unlock; Up/Down move among chain nodes in the same column. The view auto-pans to keep the cursor 48 px inside the plot. |
| `Enter` / `Space` | Select the cursor node |
| Shift + arrows | Pan 80 px |
| `PageUp` / `PageDown` | Scroll one plot height |
| `Home` / `End` | First / last lane |
| `Tab` | Leaves the graph (the cursor position is remembered) |

---

## 12. Accessibility

- **Tab order:** a skip link "Skip to map" (visible on focus) → header controls → card head
  (Clear, Details) → toolbar → graph region → panel tabs and body → footer link.
- **Graph region:** `role="group"`, `aria-roledescription="course map"`,
  `aria-label="Prerequisite map, 2,491 courses. Arrow keys move between courses, Enter selects."`
- **Live region** (`aria-live="polite"`, visually hidden):
  - Cursor moves announce "CSC148H5, Introduction to Computer Science. Computer Science, 100
    level. Unlocks directly." The relation is included when a focus exists.
  - Selections announce "Selected CSC148H5. Needs 1 directly, 1 in total. Unlocks 9 directly,
    45 in total."
- **Chain list fallback:** the Course panel's summary lists (6.7.1) are real buttons, grouped and
  labelled. They are the screen-reader list of prerequisites and unlocks, and stay in the DOM while
  the panel is collapsed (`hidden` from view; reachable through the Details button). A
  map/list toggle with a sortable table view SHOULD follow after V1.
- **Contrast:** every text pair is 4.5:1 or better (3.2). Graphics are 3:1 or better, except the
  deliberately de-emphasised mini dots and faint edges.
- **Colour independence:**
  - Direction = hue + side.
  - Distance = fill + size + stroke weight.
  - Record = shape.
  - Alternatives = fork glyph.
  - Corequisite = dash.
  - Verify with CDP `Emulation.setEmulatedVisionDeficiency` (deuteranopia, protanopia, achromatopsia)
    screenshots in Playwright.
- **Forced colours** (Windows high contrast), SHOULD:
  - The DOM uses system colours.
  - The canvas switches to `CanvasText` (nodes, labels, edges), `Highlight` (focus, direct
    edges, transitive at 1 px) and `GrayText` (minis).
- **Reduced motion:** see 17.
- **Language:** `<html lang>` follows the UI language (`en` or `zh-CN`). Official English strings
  inside zh UI get `lang="en"`.
- **Axe:** zero serious or critical violations (`@axe-core/playwright`) on landing, a selection,
  the program panel and the record panel, in both themes.

---

## 13. Language

- `EN | 中文` switches UI strings only (`defineStrings` tables per feature).
- Codes, titles, requirement text, program titles and subject names stay English.
- Numbers use `formatNumber` (en-CA / zh-CN). Both keep "2,491".
- Layout MUST tolerate zh strings, which are usually narrower. No control width is fixed to its
  English label.

Key strings:

| Key | EN | 中文 |
|---|---|---|
| product | UofT Course Map | UofT Course Map |
| campus.planned | St. George — coming soon | 圣乔治校区 · 即将推出 |
| status.calendar | 2026–2027 Calendar | 2026–2027 学年课程目录 |
| search.placeholder | Search courses or programs | 搜索课程或专业 |
| header.programs / header.myCourses | Programs / My courses | 专业 / 我的课程 |
| theme | System / Light / Dark | 跟随系统 / 浅色 / 深色 |
| card.title | Prerequisite map | 先修关系图 |
| card.meta | 70 subjects · all 2,491 courses | 70 个学科 · 全部 2,491 门课程 |
| level / all | Level / All | 年级 / 全部 |
| band.title / band.year1 | 100 level / First year | 100 级 / 一年级 |
| toolbar.subjects | Subjects | 学科 |
| toggle.hideUnrelated | Hide unrelated | 隐藏无关课程 |
| toggle.directOnly | Direct only | 仅直接关系 |
| toggle.showAll | Show all connections | 显示全部连线 |
| toggle.hideCompleted | Hide completed | 隐藏已修课程 |
| toggle.titles | Titles | 课程名 |
| zoom.fit | Fit width | 适应宽度 |
| readout.needs | Needs {d} directly · {t} in total | 直接先修 {d} 门 · 共 {t} 门 |
| readout.needsOneOf | Needs 1 of {n} directly · {t} related in total | 直接先修 {n} 选 1 · 相关共 {t} 门 |
| readout.unknown | {d} direct prerequisites · see official text | 直接先修 {d} 门 · 请看官方原文 |
| readout.unlocks | Unlocks {d} directly · {t} in total | 直接解锁 {d} 门 · 共 {t} 门 |
| lane.counts | {p} needed · {u} unlocked | 需 {p} · 解锁 {u} |
| relation.* | Needed directly / Needed earlier / Unlocks directly / Unlocks later / Not in this chain / In program | 直接先修 / 更早的先修 / 直接解锁 / 后续解锁 / 不在此链上 / 属于所选专业 |
| legend.anyOf / legend.coreq | Any one of these / Corequisite (take together) | 多选一 / 同修课（需同时修读） |
| record.* | Not taken / Planned / In progress / Completed / Available now | 未修 / 计划 / 在修 / 已修 / 现在可选 |
| edge.later / edge.earlier | {n} later unlocks → / ← {n} earlier prerequisites | 后续 {n} 门 → / ← 更早先修 {n} 门 |
| panel.unparsed | We could not read the structure of this requirement. Read the official text above. | 未能解析此要求的结构，请阅读上方官方原文。 |
| clear / details | Clear / Details | 清除 / 详情 |
| footer.disclaimer | Unofficial planning tool. Requirements can change: always confirm with the official UTM Academic Calendar. | 非官方规划工具。课程要求可能变动，请以 UTM 官方 Academic Calendar 为准。 |

---

## 14. State, URL, storage

- **URL hash:** campus, course and program only: `#/utm?course=CSC148H5&program=ERMAJ1688`
  (`src/app/url.ts`). Theme, language, filters, pins and the record never go in the URL. The
  prototypes' `#theme=` and `#select=` are dropped. Screenshot tests set the theme through
  localStorage or `colorScheme` emulation.
- **Preferences:** `uoft-course-map:prefs:v1` (`src/app/persist.ts`).
  - Existing keys: theme, lang, depth, hideUnrelated, hideCompleted, showAllEdges.
  - New keys: `titles`, `pins: string[]`, `home: {kind: 'subject' | 'program', id}`, `onboarded`,
    `panelCollapsed`.
- **Student record:** `uoft-course-map:profile:v1`, as `docs/architecture.md` specifies.
  `persist.ts` currently writes `uoft-course-map:record:v1`. Rename it, and on load migrate
  `record:v1` to `profile:v1` once, then delete the old key. The record is never uploaded and never
  put in URLs.
- **Storage failures:** all storage access is wrapped in try/catch; the app works in memory when
  storage fails.

---

## 15. Data preconditions (pipeline, before visual QA)

The frontend relies on the following. Each item gets a test in `tests/`.

| # | Requirement | Test |
|---|---|---|
| D1 | The parser recovers course codes glued to words. In CSC236H5 the text is "60% or higher inCSC148H5". This is still missing from `public/data/utm/graph.json` as of 2026-10-08, where CSC236H5's prerequisite ids are only CSC111H5 and MAT102H5. | CSC148H5's direct unlocks include CSC236H5 |
| D2 | "Recommended Corequisite" text goes to `recommended` or `mentioned`, never to corequisite ids. Example: CHM110H5 → the MAT calculus pairs. | CHM110H5 has no coreq edges |
| D3 | Codes inside recommended text are still captured as `mentioned` (MAT137H5 and others in CHM110H5). | `mentioned` contains UTM:MAT137H5 |
| D4 | References to codes that are not in the catalog (MAT137Y5, MAT157Y5) are listed in a new `RequirementLite.unresolved?: string[]`. They are not edges and are not counted. | No edge points to a missing id; the panel shows the "Not in this calendar" chip |
| D5 | Self-references are dropped (MAT157H5 lists itself as a corequisite). | No self edge |
| D6 | The rule tree is kept per requirement. The UI uses `any` nodes for forks and counts. A top-level `unknown` (960 of 2,041 non-empty prerequisite rules today) triggers the neutral state. | Fork is shown for MAT232H5; no fork for any `unknown` |
| D7 | `subjects.json` provides official names, departments and divisions (present: 70 subjects, 5 divisions). | Lane names are never raw Program Area strings |
| D8 | `campuses.json` lists UTSG as `planned`, which the switcher reads. Add `startSubjects` per campus (UTM: CSC, MAT, STA, ECO, PSY, BIO). | Switcher shows the disabled "St. George" segment |

---

## 16. Performance and verification

### 16.1 Budgets

Measured on full UTM data: 2,491 nodes, about 5,000 references, 70 lanes. Playwright with
4 × CPU throttling stands in for mid-range hardware.

| Step | Budget (unthrottled / 4 × throttled) |
|---|---|
| Topology, once | ≤ 150 ms / ≤ 600 ms |
| Presentation + geometry per state change (× 2 with chain-title auto) | ≤ 40 ms / ≤ 160 ms |
| Routes for ≤ 400 highlighted edges | ≤ 30 ms / ≤ 120 ms |
| Select → first full frame | ≤ 100 ms / ≤ 400 ms |
| Pan or zoom frame, overview, 1920 × 1080 at DPR 1 / 1.5 | ≤ 8 / 12 ms CPU |
| First meaningful paint after `graph.json` arrives | ≤ 1.5 s |

Rendering requirements:

- Viewport culling for nodes and edges (by bounding box).
- Batched `Path2D` per edge group.
- One batched fill per dot class and parity.
- Labels drawn only inside the viewport.
- DOM header overlays updated with `transform` only.

### 16.2 Tests

**Vitest, geometry and routes:**

- No layout edge connects two nodes in the same column, and `col(p) < col(c)` holds.
- No overlapping node boxes; lanes never overlap.
- Wrapped tracks are top-aligned and column-major, with `trackGap < columnGap / 3`.
- Slim lanes are 30 px and collapsed lanes 0 px.
- At the framing zoom of every acceptance case, rendered code size ≥ 12 and title size ≥ 11.5.
- `routes.fallbacks === 0` and no highlighted curve intersects a label or dot box, for:
  - CSC148H5 → CSC338H5 / CSC310H5 (past the CSC211H5, CSC290H5, CSC236H5 and CSC263H5 labels)
  - The MAT232H5 fan (past the MAT236H5 code line)
  - MAT232H5 → MAT402H5 (past MAT354H5)
- Fan bundling activates for ECO200Y5, PSY100Y5, STA256H5 and SOC221H5.
- Chain titles auto resolves to "direct" for CSC148H5 at 1536 with the panel open. The Titles
  toggle forces "all".

**Playwright** (frames 1920 × 1080 @ DPR 1, 1536 × 864 @ DPR 1.25, 1280 × 720 @ DPR 1.5; light and
dark):

- Screenshots:
  - First-visit landing (CSC lane on top, start strip, search focused)
  - CSC148H5
  - MAT232H5
  - ECO200Y5
  - SOC221H5
  - Program mode
  - Record mode with all four glyphs
  - zh UI
  - Hide unrelated
  - Edge-of-view pills
  - Keyboard cursor
  - Vision-deficiency emulations
- Fit assertions per the 10.2 table.
- Axe scans (12).
- `perf.spec` for 16.1.

---

## 17. Motion (later phase; build features first)

`GraphCanvasProps.motion` gates all canvas motion. Rules:

- Never animate during drag or wheel.
- Any user input cancels a tween in flight and jumps it to its end state.
- With `prefers-reduced-motion: reduce`, tweens and animated pans become instant. Only opacity
  fades of 100 ms or less remain.

| What | Duration | Easing | Notes |
|---|---|---|---|
| Geometry change (select, clear, filter, Titles) | 260 ms | `cubic-bezier(0.2, 0, 0, 1)` | Interpolate node centres, dot radii and column/lane boxes. Labels fade out 100 ms, then fade in 160 ms after a 100 ms delay. Chain edges are hidden during the tween. |
| Chain edges appear | 160 ms fade | linear | Direct edges at 0 ms, transitive at +60 ms. Opacity only, no draw-on, since fans of 100+ edges would flicker. |
| Focus glyph | 180 ms | `cubic-bezier(0.2, 0, 0, 1)` | Ring scales 0.6 → 1; plate fades over 120 ms. |
| Framing pan or zoom | 320 ms | `cubic-bezier(0.4, 0, 0.2, 1)` | Hash, search, `F`, double-click |
| Click-anchor nudge | 220 ms | same | |
| Edge-of-view pill appear / click-pan | 160 ms fade / 320 ms pan | linear / standard | |
| Hover ring / tooltip | 80 ms / 120 ms fade, 350 ms delay | linear | |
| Panel expand / collapse | 200 ms width | `cubic-bezier(0.2, 0, 0, 1)` | Body content fades over 120 ms. The canvas resizes once at the end, not every frame. |
| Popovers | 120 ms | opacity + translateY 4 → 0 | |
| Theme change | instant on canvas; 150 ms `background-color` on DOM chrome | — | |

---

## 18. Must-fix traceability

The judges' must-fix lists, merged and de-duplicated.

| Must-fix | Resolution |
|---|---|
| CSC236H5 dropped from CSC148H5's unlocks (glued code) | D1 (pipeline) + test |
| Recommended corequisites drawn as edges; missed calculus codes; MAT137Y5/MAT157Y5 not in catalog; MAT157H5 self-coreq | D2–D5; panel "Not in this calendar" chips (6.7.1) |
| Readable type at framing zoom (codes ≥ 12, titles ≥ 11.5; no 80 % framing) | 4.2 sizes, auto-frame floor 0.92 (8.12), semantic zoom |
| Width wasted during selection (B's 650 px 100 band) | mini-only columns 22 px, measured column widths, chain titles auto (8.2, 8.3) |
| Chain does not fit: links trail off-screen | priority framing windows + edge-of-view pills (10.2, 10.3) |
| Selected title truncated | focus plate wraps, never truncates (7.5) |
| Default landing on Biology; lane-order question (ENG between ECO and MGT) | landing rules (10.1), start strip (6.3), pins (6.9.2), owner decision 19.1 |
| "One of several" only for parsed rules; honest counts | fork glyph (7.4), readout copy (6.3), D6 |
| No curve strikes through a label or runs through a dot or junction | corridor routing (8.8) + regression tests (16.2) |
| High-degree fans become ribbons, wedges or curtains | fan bundling (8.9), opaque single-stroke paths, no glow (3.3) |
| Lanes with nothing on the path keep 64 px | slim 30 px (Grey dots) / 0 px with a reported count (Hide) (8.4). Owner may override, see 19.4 |
| Unrelated edges drawn during selection | never, unless "Show all connections" (6.4, 7.4) |
| Wrap tracks look like sub-columns; brick stagger; horizontal rows | column-major, top-aligned tracks, trackGap 8 vs 28, notched scale segment (8.4, 9.2) |
| Incomplete legend | contextual complete legend strip (6.6) |
| Requirement text only on hover | docked Course panel with official text (6.7.1) |
| Default overview clutter (grey ropes, MAT/STA fan) | long-edge stubs + hover preview (8.10), opaque hairlines ≥ 1.6:1 (7.6) |
| Subject picker must scale to 70 lanes; header must say all courses are mapped | subject picker (6.9.2); card meta "all 2,491 courses" (6.3) |
| 125 % / 150 % scaling; DPR-aware canvas | frames (6.1), DPR rules (8.13), tests (16.2) |
| Keyboard and screen-reader access | 11.3, 12 |
| B's beige paper too heavy; ink-3 contrast failures (A 2.95, B 3.17) | white surfaces from A; `--ink-3` ≥ 4.5 everywhere (3.2) |
| Slashed zero | Segoe UI Variable / Inter, plain zero (4.1) |
| Details surface covering path courses; no minimise; count text wrapping | docked panel + rail, framing uses the remaining plot (6.7); counts are single-line readouts |
| Lanes coloured by department (CSC, MAT, STA identical) | division families with alternating tones + code bullets (7.7) |
| Sticky labels clipped or hidden | clamped lane and band labels with short forms (9.1, 9.2) |
| Off-state toggles look disabled | solid-border off state with a circle indicator (6.4, 11.1) |
| Prove scale (2,491 nodes, about 70 lanes, about 4.4k edges); spatial-grid hit test | full dataset is the default; budgets and perf test (16.1); 64 px grid (11.2) |
| Single conflict-free legend (colour = direction, fill = distance, dash = coreq only) | 7.1–7.4 |
| Reserve encodings for taken courses and program courses | record = shape (7.2); program = amber (7.3) |
| URL hash carries only campus, course and program; theme in localStorage | 14 |
| Dark-mode contrast of transitive and faint edges | `--pre-soft` 3.7, `--unl-soft` 4.9, `--edge-faint` 1.94 (3.2) |
| V1 features missing (zh, details, program, taken courses) | 6.7, 13, 14 |

---

## 19. Owner decisions (resolved 2026-10-08)

The owner delegated these choices; they are final for V1.

1. **Lane order:** divisions are ordered Sciences, Social Sciences, Management & Professional,
   Humanities, Interdisciplinary (already applied in `data/utm/subjects.json`), then subject code.
2. **Pins:** not in V1. The lane kebab offers "Jump" (scroll to lane) and "Make home"
   (`prefs.home`). The first visit scrolls to `startSubjects[0]` (CSC) from `data/campuses.json`.
3. **Record storage key:** `uoft-course-map:profile:v1`, migrating the development key
   `record:v1` once (implemented in `src/app/persist.ts`).
4. **Hide mode:** lanes with nothing on the path collapse to 0 px and the card meta reports the
   count; in Grey-dots mode they are 30 px slim rows.
5. **Default dots:** the reference green.
6. **Fonts:** no web fonts are loaded and nothing is self-hosted. The stack is
   `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` (Inter is dropped); Windows is
   the target and Segoe UI Variable has a plain zero.
