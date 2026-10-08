# Architecture

UofT Course Map is a static site (GitHub Pages) that draws every course of a campus as a
lane-and-curve dependency graph. V1 ships UTM only; UTSG plugs in later through the same
campus registry, data build and frontend loader.

## Product rules (from the owner)

1. Visual language follows `docs/reference/dependency-graph.png`: horizontal **lanes** (one per
   subject), columns grouped into **bands** (course level), small dots with labels, thin
   bezier curves flowing left → right.
2. With a course selected, unrelated courses become **grey minimal dots** (or can be hidden).
   Prerequisites (what it waits for) are drawn in a **blue** family, courses it unlocks in a
   **purple/violet** family.
3. **No edge may connect two nodes in the same column.** A prerequisite is always strictly to the
   left of its dependent. Same-level chains (CSC108H5 → CSC148H5, both 100-level) are split into
   sub-columns inside the band. This is a tested invariant.
4. Desktop browsers on Windows are the only target for now (no phone/tablet layouts).
5. UI language: English by default, Chinese toggle. Official course codes, titles and
   requirement text always stay in English.
6. V1 features: graph, course details, pick a program to highlight its courses, mark taken
   courses (stored only in localStorage). Motion/animation comes after all features work.

## Repository layout

```
pipeline/            Python collector + parser for the official calendar (backend)
data/                Backend datasets: full fidelity, canonical, committed
  campuses.json      Campus registry (UTM available, UTSG planned)
  utm/catalog.json   Courses + programs with rules, raw text, provenance
  utm/subjects.json  Subject code → name / department / division
  utm/official-fields.json  Every official field of every page (text + HTML) — the archive
                     that replaces the raw HTML cache
  utm/manifest.json, quality-report.json, data-quality.md   collection evidence
scripts/             Node scripts: build-frontend-data.ts, validate-catalog.ts
public/data/         Frontend datasets generated from data/ (committed, deterministic)
  campuses.json
  utm/graph.json     Compact courses + relations + rules (loaded first)
  utm/details.json   Descriptions (lazy)
  utm/programs.json  Programs + requirement groups (lazy)
src/                 React + TypeScript app (Vite)
tests/               Vitest unit tests, Python pipeline tests, Playwright e2e
```

The backend dataset is the backup and the basis for any future app/API. The frontend dataset
is a lossless-enough projection for the static site; regenerate it with `npm run data:build`.

## Course identity

`CAMPUS:CODE`, e.g. `UTM:CSC148H5`. Never truncate H/Y or the campus digit. References to other
campuses (`UTSG:CSC148H1`) are kept as external ids; they are not graph nodes while that campus
is not loaded.

## Graph layout model

Layout is split into a **static topology** (computed once per dataset) and a **dynamic
geometry** (recomputed whenever node display states change).

### Topology (`src/graph/topology.ts`, pure)

- Layout edges: prerequisite and corequisite references between loaded courses
  (`p → c`). Self-loops are dropped. Two kinds of references are kept out of the layout and
  listed in `excludedEdges` instead of being drawn: cycle breakers (Tarjan SCC, keep edges that
  agree with level-then-code order; e.g. LIN104H5 ↔ LIN105H5) and **backward** references from a
  higher-level course to a lower-level one. In the 2026–27 data all 36 backward references are
  "or" alternatives (FSL → FRE, "… or 77% in FSL406H5"), so every course stays in its own band.
- Band: 000/100 → band 0, 200 → 1, 300 → 2, 400 → 3, always the course's own level.
- Column: `col(c) = max(bandStart[band(c)], max(col(p) + 1))`; bands are contiguous, each band's
  width is its deepest internal chain + 1. Hence `col(p) < col(c)` for every layout edge.
- Lane: one per subject, ordered by division then subject code; lanes carry name/department.
- Cell order (lane × column): barycentre of predecessors (roots use their successors), ties by
  code. Static, so nodes never reshuffle when highlighting changes.

### Geometry (`src/graph/geometry.ts`, pure)

Each node has a display class: `full` (dot + code + title), `compact` (dot + code), `mini` (grey
dot only) or `hidden`. Runs of `mini` dots are packed into a grid inside their cell. A cell taller
than `cellMaxHeight` wraps into side-by-side tracks inside its column (nodes of one column never
share an edge, so this cannot create a same-column curve). Column widths follow the widest cell;
lane height is the tallest cell. Selecting a course
switches its chain to `full`, everything else to `mini`, so the chain "expands" into readable
columns while the rest shrinks. Geometry is deterministic and testable (no overlaps, strict
left-to-right edges, lanes never overlap).

### Rendering (`src/graph/renderer.ts`)

Canvas 2D (2,491 nodes / ~4.4k edges per campus) with viewport culling, batched edge paths,
semantic zoom for labels, spatial-grid hit testing, sticky lane headers and band headers, and
interpolation between geometries (enabled in the motion phase). React owns the UI shell only.

## State

- Selection, program, filters, viewport, theme, language: app store (`src/app/`).
- Student record: `localStorage` key `uoft-course-map:profile:v1` (course id → completed /
  in progress / planned, optional grade). Never uploaded, never put into URLs.
- Shareable URL hash: campus, selected course, selected program only.

## Multi-campus

`data/campuses.json` lists campuses with `status: available | planned`. The data build only
emits available campuses; the UI lists planned ones as "coming soon". Adding UTSG means: a
pipeline adapter that writes `data/utsg/catalog.json` + `subjects.json` in the same schema, then
flip the registry status. See `docs/data/multi-campus.md`.
