# Rule engine

`src/domain/` evaluates course and program requirements against a student's record. It is pure
TypeScript: no React, no DOM, no network, no LLM. Its only inputs are the frontend datasets
(`src/data/schema.ts`) and the record kept in the browser. The contract with the UI is
`src/domain/engine-types.ts`.

| File | Role |
|---|---|
| `engine-types.ts` | Contract (owned by the lead): `CourseEngine`, `EvalNode`, record types |
| `engine.ts` | `createEngine(dataset)`: indexes built once, the four API calls |
| `evaluate.ts` | Evaluator core: three-valued AND / OR, course, grade and credit leaves |
| `rules.ts` | Rule AST helpers: `ruleCourseIds`, `containsOpaque` |
| `record.ts` | `recordFromRows`: merges repeated rows into one entry per course |
| `types.ts` | Backend dataset contract (`data/<campus>/catalog.json`), shared with the pipeline |
| `planner.ts` | Compatibility re-export of `ruleCourseIds` for `scripts/build-frontend-data.ts` |

The engine never returns prose. Results are statuses, ids and numbers; the UI words them in the
active language. Official course codes, titles and requirement text pass through unchanged.

## Record semantics

The record is a `ReadonlyMap<courseId, { status, grade? }>` with status `completed`,
`inProgress` or `planned`. Students plan the coming term, so:

- An unmarked course is **not taken**. The record is treated as complete.
- `completed` satisfies everything. A grade below 50 is an F: the course counts as failed (not
  passed, no credit, never blocks an exclusion). A completed course without a grade is a declared
  pass. Source: [UTM Grades and Academic Record](https://utm.calendar.utoronto.ca/grades-and-academic-record).
- `inProgress` counts as passed for prerequisites and corequisites, so "available" means
  available once current courses are finished.
- `planned` satisfies corequisites only (taken together), never prerequisites.

Internally each rule is evaluated under one of three counting modes (`evaluate.ts`):

| Mode | Counts as taken | Used for |
|---|---|---|
| `completed` | passed courses | program progress |
| `current` | + in progress | prerequisites, exclusions |
| `planned` | + planned | corequisites, the plan behind "take next" |

Course identity is the full `CAMPUS:CODE` id (`UTM:CSC148H5`, `UTSG:CSC148H1`). Other campuses are
never mapped to equivalents.

## Three-valued logic

Every node is `met`, `unmet` or `unknown`. `all` is unmet if any child is unmet, met if all are
met, otherwise unknown. `any` is met if any child is met, unmet if all are unmet, otherwise
unknown. Unknown never silently becomes "no requirement".

| Leaf | Status |
|---|---|
| `true` | met |
| `course` | met when the course counts under the mode, else unmet |
| `minGrade` | unmet when the course does not count; unknown when it counts but has no final grade (in progress, planned, or completed without a grade); otherwise grade ≥ minimum |
| `credits` | see below |
| `permission`, `program`, `unknown` | unknown (the record has no permissions, admissions or parsed meaning) |
| `applicability` | met when its rule is met (the clause holds whether or not it applies); otherwise unknown, because the record has no cohort |

### Credits

A credits rule sums the credits of courses that count under the mode, each course once, filtered
by `courseIds`, `subject` and minimum `level` (`level` is "at or above", not a year of study).

- Two counted courses that exclude each other never both earn credit. Each exclusion-connected
  group contributes only its largest credit value to the confirmed total (a lower bound).
- A course outside the loaded dataset gets its credit value from its code (H = 0.5, Y = 1.0). It
  counts when the rule lists it or has no scope; under a subject or level scope it is uncertain.
- Status: met when the confirmed total reaches the minimum; unmet when even the upper bound
  (all counted and uncertain credits) stays below it; otherwise unknown.
- `EvalNode.earned` is the confirmed total.

## API (`createEngine(dataset)`)

`createEngine` indexes the dataset once: courses by id, dataset order, exclusion lists and
symmetric exclusion pairs, and a reverse prerequisite index. Program indexes are cached per
`ProgramLite` object.

### `eligibility(record)`

`Map<courseId, Eligibility>` for every course that is not completed or in progress (planned
courses included), in dataset order. The value equals `evaluateCourse(id, record).overall`. On
the full UTM catalog it takes about 1 ms (budget 50 ms, `tests/domain-engine.test.ts`).

### `evaluateCourse(courseId, record)`

Returns `CourseEvaluation`. Each part is `null` when the calendar lists none.

- `prerequisites`: `EvalNode` tree (mode `current`).
- `corequisites`: `EvalNode` tree (mode `planned`).
- `exclusions`: `{ status, blockedBy }`. `blockedBy` lists excluded courses (the field's `ids`
  plus rule references) that are passed or in progress. Status is `blocked` when that list is not
  empty, `unknown` when part of the wording is unparsed, otherwise `clear`.
- `restrictions`: a single `{ kind: 'unknown', status: 'unknown', text }` node with the official
  text. Restrictions are often negative ("not open to …") and are never evaluated as positive
  requirements.
- `overall`: `all` of the parts above (`clear` → met, `blocked` → unmet). A course with a
  restriction is therefore never better than unknown.

An id that is not in the dataset returns `overall: 'unknown'` with every part `null`.

`EvalNode` mirrors the Rule AST node for node: `all` / `any` children follow `items`,
`applicability` has its rule as the only child, leaves carry `courseId`, `minimum`, `earned` or
`text` (permission and unknown text, the cohort, the program id). The UI can walk the Rule and the
EvalNode together to read scope fields such as `subject` and `level`.

### `programProgress(program, record)`

- `groups[]`: per requirement group, in program order: `status` (mode `completed`, so in-progress
  courses do not complete a group), `courseIds` (referenced ids present in the dataset, in dataset
  order) and the `completed` / `inProgress` / `planned` subsets. A failed course is in none of the
  subsets.
- `completion`: `all` of the completion groups; `unknown` when the program has none. When every
  group is met but one course is what satisfies two groups (the first met option of an OR, every
  child of an AND, the counted courses of a credits rule), it is `unknown`: sharing rules between
  groups are not parsed. Most real programs keep unparsed clauses, so completion is usually
  unknown; the UI should present group progress.
- `courseIds`: union of the groups' ids, for graph highlighting.

### `nextCourses(program, record, limit = 12)`

An explainable "take next" list, best first.

1. Each group is evaluated in mode `planned`: courses in progress or planned already fill a
   requirement. Met groups are skipped.
2. The evaluated tree is followed only through children that are not met. An unmet `any` offers
   its options without expanding their prerequisites. A credits rule offers its listed courses.
3. A course that is not eligible has its prerequisite and corequisite trees expanded the same
   way. Passed and eligible courses are never expanded, so an OR already met by another course
   adds nothing.
4. Groups with unparsed parts are not trusted for expansion: their parsed leaves and the course
   ids cited only by their text are offered as options.
5. Courses on the record are never offered (a failed attempt may be retaken), ids absent from
   the dataset are skipped, and courses blocked by an exclusion are dropped.

Ranking: eligible courses first, then by `unlocks` (how many other program courses list the
course as a prerequisite), then by the order of the group that first led to it, then discovery
order. `groups` lists the groups that reference the course; a prerequisite bridge that no group
references lists the groups that led to it. `reason` follows eligibility: `ready` (met),
`needs-prerequisites` (unmet), `check-requirements` (unknown).

## Records with repeated rows

`recordFromRows(rows)` builds a record from rows that may repeat a course (an import, an old file):
passed > in progress > planned > failed, then the higher grade, whatever the row order.

## Known limits

- The record has no cohort, admission or permission. Cohort-specific program branches stay
  unknown unless met, and "take next" may offer courses from more than one cohort branch.
- Unparsed calendar wording stays unknown: about 1,160 of 2,041 non-empty prerequisites contain
  unparsed text, and 220 courses carry a restriction.
- Availability, timetables, enrolment controls and seat limits are out of scope.

## Validation and tests

- `npm run data:validate` (`scripts/validate-catalog.ts`): catalog identity, the Rule AST, every
  AST reference listed in `courseIds`, optional `mentionedIds` / `unresolvedIds` never used by the
  AST (unresolved ids are same-campus, absent from the catalog and never graph references), and the
  optional course fields. It also reports same-campus references that point at no course.
- `tests/domain.test.ts`: evaluator core, rule helpers, record merging, no CJK text in `src/domain`.
- `tests/domain-engine.test.ts`: the API on synthetic datasets, including the review regressions,
  and the whole-catalog performance budget.
- `tests/domain-official.test.ts`, `tests/catalog.test.ts`: real-catalog regressions.

Run: `npx vitest run tests/domain.test.ts tests/domain-engine.test.ts tests/domain-official.test.ts tests/catalog.test.ts`.
