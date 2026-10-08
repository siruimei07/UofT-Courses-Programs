# Architecture

UofT Course Map is a static GitHub Pages site (React 19, TypeScript, Vite) that draws every course
of a campus as a lane-and-curve prerequisite map on a canvas. V1 ships UTM (2026–2027 calendar,
2,491 courses, 168 programs, 70 subjects). UTSG plugs in later through the same campus registry,
data build and loader. Visual details are bound by `docs/design-spec.md`; this document covers
product rules, data, module boundaries and testing.

## Product rules (owner)

1. Visual language of `docs/reference/dependency-graph.png`: one horizontal **lane** per subject,
   columns grouped into level **bands**, small dots with labels, thin curves flowing left → right.
2. With a course selected, unrelated courses become **grey minimal dots** (or are hidden).
   Prerequisites are **blue**, unlocks **violet**, program courses **amber**.
3. **A prerequisite is always strictly left of its dependent, and no edge may connect, or appear to
   connect, two courses of the same column** (wrapped tracks included). Same-level chains
   (CSC108H5 → CSC148H5) become sub-columns inside the band. Tested on the real data.
4. Desktop browsers on Windows only (no phone or tablet layouts).
5. English UI by default with a Chinese toggle. Every UI string lives in a feature's
   `defineStrings({ en, zh })` table (`src/i18n`). Official codes, titles and requirement text stay
   English.
6. V1 features: map, course details, program highlight and progress, local student record.

Owner decisions 10–13 (design-spec 19), all implemented in the graph modules:

| # | Decision | Where |
|---|---|---|
| 10 | No wrapping while dimming: with a course or program selected, labelled cells never wrap into tracks. A tall chain cell makes a tall lane, so every highlighted edge enters its dot straight from the left | `geometry.ts` |
| 11 | Overview inner-track links are stubs: an overview edge leaving a track that is not the last of its wrapped cell, or entering a track that is not the first, is drawn only as a short stub with a terminal dot inside that track's own gap. Hover previews the full links. Integration pass (visual QA): a target stub arrives from the row gap next to its row (one per gap), and a source stub is drawn only where no course of the next track faces it, so no stub lies between two courses of one column on their row | `routes.ts` (`plainEdgeStubs`), `renderer.ts` |
| 12 | `columnGap` is 28. Chains wider than the plot use priority framing windows and edge-of-view pills | `DEFAULT_GEOMETRY_OPTIONS` (`geometry.ts`), `viewport.ts` |
| 13 | Motion is on by default (design-spec 17) and off under `prefers-reduced-motion: reduce` | `GraphCanvasProps.motion` (set by `App.tsx`), `GraphCanvas.tsx` |

## Data flow

```
official calendar ──pipeline/ (Python)──▶ data/<campus>/          backend, full fidelity, committed
                                            │ scripts/build-frontend-data.ts (npm run data:build)
                                            ▼
                                          public/data/             frontend, compact, committed
                                            │ src/data/load.ts (fetch under the Vite base path)
                                            ▼
GraphDataset ─▶ topology ─▶ presentation ─▶ geometry ─▶ routes ─▶ GraphCanvas (renderer + overlays)
   (once)        (once)     (app state)    (classes)   (highlighted edges)
```

- `data/campuses.json` is the campus registry (`available` / `planned`). `data/utm/` holds
  `catalog.json` (courses, programs, official text, Rule AST, provenance), `subjects.json`,
  `official-fields.json` (every official field of every page as text plus field HTML: the archive
  that replaces the raw HTML cache), `manifest.json`, `quality-report.json` and `data-quality.md`.
- `public/data/` holds `campuses.json` and `utm/graph.json` (loaded first),
  `utm/details.json` (descriptions, lazy) and `utm/programs.json` (lazy). The build is deterministic
  and `npm run data:build -- --check` fails when the committed output is stale. Contract:
  `src/data/schema.ts`.
- In the app, `Workspace` (`src/app/App.tsx`) builds the topology, the rule engine and the label
  measurer once per dataset. `useGraphModel` then recomputes, memoised stage by stage:
  record → `engine.eligibility` → `resolveChainTitles` (presentation + geometry, a second pass
  when "chain titles: auto" must drop transitive titles) → `computeRoutes` → `GraphCanvas`.

## Modules

**`src/graph/`** (graph-core and renderer). Contracts: `types.ts`, `canvas-types.ts`.

| File | Role |
|---|---|
| `topology.ts` | `buildTopology(dataset)`: layout edges, excluded edges, bands, columns, lanes, static cell order, `laneTone` |
| `presentation.ts` | `computePresentation(topology, input)`: display class (`full` / `compact` / `mini` / `hidden`), node and edge roles, record, eligibility, `dimming` |
| `geometry.ts` | `computeGeometry(...)`: node, column, lane and band boxes in world px; `DEFAULT_GEOMETRY_OPTIONS` |
| `routes.ts` | `computeRoutes(...)`: anchored curves, corridor routing around labels, dots and other courses' port zones, fan bundling, "any one of" forks; `plainEdgePaths` / `plainEdgeStubs` / `plainEdgeBlocked` / `routedEdgePaths` for faint edges, stubs and hover previews on the same anchors |
| `renderer.ts` | `buildScene` (once per state change) and `drawScene` (per frame): Canvas 2D, viewport culling, one `Path2D` per edge group, batched dot fills, semantic zoom, `interpolateGeometry` for tweens |
| `text.ts`, `tokens.ts` | Label measurement, truncation and the focus plate; colours read from CSS custom properties (forced colours supported) |
| `viewport.ts`, `hittest.ts` | Pan, zoom and framing maths, edge-of-view pill counts, easing; 64 px spatial-grid hit test and keyboard navigation |
| `GraphCanvas.tsx` | The map component: canvas, pointer, wheel and keyboard input, keyboard cursor, live region, motion; one `requestAnimationFrame` redraw per change. Exposes a read-only `globalThis.__courseMapLayout` getter (geometry and topology of the last drawn frame) in every build for the hard-rule e2e checks |
| `overlays/` | DOM overlays positioned per frame through a frame bus (`frame.ts`): `LaneColumn` (sticky lanes, kebab menu), `BandBar` (sticky bands, scale bar), `Corner`, `Scrollbars` (overview ruler), `EdgePills`, `Tooltip`, `counts.ts` |
| `strings.ts`, `graph.css` | Graph UI strings and styles |

**`src/domain/`** (rule engine, pure). Contract: `engine-types.ts`; details:
`docs/data/rule-engine.md`. `createEngine(dataset)` returns a `CourseEngine` with
`eligibility(record)`, `evaluateCourse(courseId, record)`, `programProgress(program, record)` and
`nextCourses(program, record, limit = NEXT_COURSES_LIMIT)`. Three-valued (`met` / `unmet` /
`unknown`): unparsed text, permissions and absent codes stay `unknown`, never `met`. Also exports
`recordFromRows`, `isPriorityOnly` and `PASS_GRADE`.

**`src/app/`** (shell). `store.ts` (external store via `useSyncExternalStore`), `persist.ts`,
`url.ts`, `theme.ts`, `lang.ts`, `landing.ts`, `search.ts` / `searchInput.ts`, `readout.ts`,
`chainTitles.ts` / `framing.ts`, `useCampusData.ts`, `usePrograms.ts`, `useGraphModel.ts`,
`useShortcuts.ts`, `App.tsx`.

**`src/ui/`** (chrome). Header, campus switcher, search, card head, start strip, toolbar, view menu,
subject picker, zoom, legend strip, shortcuts help, footer, `tokens.css` and `app.css`.
**`src/ui/panels/`** (contract `types.ts`): `RightPanel` hosts the Course, Program and My courses
tabs and collapses to a 48 px rail.

## Course identity

`CAMPUS:CODE`, for example `UTM:CSC148H5`. The H/Y suffix and the campus digit are never truncated.
Other-campus references (`UTSG:CSC148H1`) stay external ids. They are not graph nodes while that
campus is not loaded. Same-campus codes absent from the calendar (`unresolved`) are never edges.

## Layout model

- **Topology (static).** Layout edges are prerequisite and corequisite references between loaded
  courses. Self-loops are dropped. Cycle breakers (Tarjan SCC, keeping edges that agree with
  level-then-code order) and **backward** references (a higher-level course cited by a lower-level
  one, always an "or" alternative in the real data) go to `excludedEdges`. The Course panel lists
  them; they are never drawn. Band = the course's own level (000/100 → 0 … 400 → 3).
  `col(c) = max(bandStart, max col(p) + 1)`, so `col(p) < col(c)` for every layout edge. Lanes are
  ordered by division, then subject code. Cell order is barycentric and static, so nodes never
  reshuffle. Real data: 4,367 layout edges, 42 excluded, 13 columns.
- **Presentation.** Overview: `compact` (or `full` with Titles). Selection: the focus and direct
  neighbours are `full`, transitive chain nodes are `full` or `compact` (chain titles: auto), and
  everything else is `mini` (or `hidden` with Hide unrelated). Program mode: program courses are
  `full`. Filters hide nodes but never the focus.
- **Geometry.** Measured column widths, mini grids, slim (30 px) and collapsed (0 px) lanes,
  mini-only columns of 22 px. In the overview only, tall cells wrap into balanced, top-aligned,
  column-major tracks (`trackGap` 8 < `columnGap` 28 / 3). Deterministic.
- **Routes.** Chain and program edges are routed around labels and dots; a path that would pass
  the end of another course's leader or the start of its entry (a "port zone") is routed again
  around those zones where it can, so vertical runs do not bracket the courses of one column.
  Corequisites never merge into a prerequisite bundle. Faint overview edges, long-edge stubs,
  inner-track stubs and hover previews share the routed anchor maths. A faint edge whose plain
  curve passes a course it does not connect is drawn as stubs (routed with Show all connections),
  and hover previews are routed, so no line runs through another course.
- **Canvas.** React owns the shell. The canvas draws the map, and the DOM overlays move with
  `transform` only.

## State

- App store: selection, program, panel, filters, depth, Titles, theme, language, home subject,
  onboarding.
- Preferences: `localStorage` `uoft-course-map:prefs:v1`.
- Student record: `uoft-course-map:profile:v1` (course id → completed / in progress / planned, with
  an optional grade). It migrates the development key `record:v1` once, is never uploaded and is
  never put in URLs. JSON import and export run in the My courses tab.
- URL hash: campus, course and program only (`#/utm?course=CSC148H5&program=ERMAJ1688`).
- Every storage access is wrapped in try/catch. The app works in memory without storage.

## Testing

| Layer | Where | What |
|---|---|---|
| Vitest unit | `tests/*.test.ts` (`npm test`) | Graph modules, app and panel helpers, rule engine, frontend data build; synthetic datasets (`tests/helpers/`) for exact rules |
| Real-data invariants | same suites, on `public/data/utm/graph.json` (`tests/helpers/dataset.ts` falls back to a catalog projection) | `col(p) < col(c)` and no same-column edge; no overlapping boxes; `routes.fallbacks === 0` and no highlighted curve crossing a label or dot over every chain and program; no faint edge or hover preview through another course; port-zone clearance on the acceptance chains; performance budgets (16.1); real-catalog engine regressions (`catalog`, `domain-official`) |
| Data checks | `npm run data:validate`, `npm run data:build -- --check` | Catalog identity, Rule AST and references; frontend data freshness |
| Python pipeline | `tests/test_*.py` (`npm run test:py`, offline) | Parser semantics, requirement roles, cache and generation integrity, campus adapters; `PIPELINE_GOLDEN=1` re-parses the local cache byte for byte |
| Playwright e2e | `tests/e2e/*.spec.ts` (`npm run test:e2e`) | Production build served under `/UofT-Courses-Programs/` (`scripts/serve-e2e.mjs`, port 4173) at 1920 × 1080 @ 1 and 1536 × 864 @ 1.25 (projects `wide-1920`, `standard-1536`, both with reduced motion): landing and deep links, selection, filters, panels, programs, record, preferences, axe scans, the hard product rule node by node (`hard-rule-layout.spec.ts`, through `__courseMapLayout`) and on the band bar's scale, and a performance smoke test. The `motion` project (1920, motion on) runs `motion.spec.ts`: tweens animate, settle, jump to their end on input and keep the hover |

`npm run check` runs lint, type-check, Vitest, `data:validate` and the build. Pull requests run
everything in `ci.yml`. Pushes to `main` run it in `pages.yml` and then deploy to Pages.

## Multi-campus

`data/campuses.json` lists campuses with `status: available | planned`. Only available campuses are
built. The UI shows planned ones as "coming soon". To add UTSG: a pipeline adapter
(`pipeline/campuses/utsg.py`, currently a closed stub) writes `data/utsg/catalog.json` and
`subjects.json` in the same schema, then the registry status is flipped. See
`docs/data/multi-campus.md` and `docs/data/maintenance.md`.
