# Rule engine

`src/domain/` evaluates course and program requirements against a student's record. It is pure
TypeScript: no React, no DOM, no network, no LLM. Its only inputs are the frontend datasets
(`src/data/schema.ts`) and the record kept in the browser. The contract with the UI is
`src/domain/engine-types.ts`.

| File | Role |
|---|---|
| `engine-types.ts` | Contract (owned by the lead): `CourseEngine`, `EvalNode`, record types |
| `engine.ts` | `createEngine(dataset)`: indexes built once, the four API calls |
| `evaluate.ts` | Evaluator core: three-valued AND / OR, course, grade and credit leaves, disjoint claims |
| `rules.ts` | Rule AST helpers: `ruleCourseIds`, `containsOpaque` |
| `restrictions.ts` | `isPriorityOnly`: recognises enrolment-priority restriction text |
| `record.ts` | `recordFromRows`: merges repeated rows into one entry per course |
| `types.ts` | Backend dataset contract (`data/<campus>/catalog.json`), shared with the pipeline |

The engine never returns prose. Results are statuses, ids and numbers; the UI words them in the
active language. Official course codes, titles and requirement text pass through unchanged.

## Record semantics

The record is a `ReadonlyMap<courseId, { status, grade? }>` with status `completed`,
`inProgress` or `planned`. Students plan the coming term, so:

- An unmarked course is **not taken**. The record is treated as complete.
- `completed` satisfies everything. A grade below 50 is an F: the course counts as failed (not
  passed, no credit, never blocks an exclusion, may be retaken). A completed course without a
  grade is a declared pass. Source: [UTM Grades and Academic Record](https://utm.calendar.utoronto.ca/grades-and-academic-record).
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

### Codes absent from this calendar

A record may hold a same-campus code that is no longer in the calendar (`MAT137Y5`). The pipeline
keeps such codes out of the rule tree and lists them in `RequirementLite.unresolved` (and
`ProgramGroupLite.unresolved`). When a prerequisite, corequisite or program group evaluates
`unmet` but the record holds one of its unresolved codes (counted under the same mode), the
requirement is `unknown` instead: the retired course may well have been an accepted alternative.
Only the root status changes; the children keep their own statuses. Exclusions treat these codes
as "may exclude" (see `evaluateCourse`).

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
| `applicability` | The record has no cohort. Alone or inside an AND, a clause that does not apply holds vacuously: met when its rule is met, otherwise unknown. Inside an OR (the nearest enclosing combinator), a clause that does not apply is no option: unknown when its rule is met, unmet when its rule is unmet, otherwise unknown |

### Credits

A credits rule sums the credits of courses that count under the mode, each course once, filtered
by `courseIds`, `subject` and minimum `level` (`level` is "at or above", not a year of study).

- Two counted courses that exclude each other never both earn credit, and which one keeps it is
  not known. Each exclusion-connected group therefore contributes only its smallest credit value
  to the confirmed total (a lower bound); the upper bound counts every course.
- A course outside the loaded dataset gets its credit value from its code (H = 0.5, Y = 1.0). It
  counts when the rule lists it or has no scope; under a subject or level scope it is uncertain.
- Status: met when the confirmed total reaches the minimum; unmet when even the upper bound
  (all counted and uncertain credits) stays below it; otherwise unknown.
- `EvalNode.earned` is the confirmed total.

## API (`createEngine(dataset)`)

`createEngine` indexes the dataset once: courses by id, dataset order, exclusion lists and
symmetric exclusion pairs (absent codes included), a reverse prerequisite index, the courses each
prerequisite field cites, and which restrictions are enrolment-priority notes. Program indexes are
cached per `ProgramLite` object.

### `eligibility(record)`

`Map<courseId, Eligibility>` for every course that is not passed or in progress, in dataset order:
planned courses and failed courses (completed with a grade below 50, which may be retaken) are
included. The value equals `evaluateCourse(id, record).overall`. On the full UTM catalog it takes
about 1 ms (budget 50 ms, `tests/domain-engine.test.ts`).

### `evaluateCourse(courseId, record)`

Returns `CourseEvaluation`. Each part is `null` when the calendar lists none.

- `prerequisites`: `EvalNode` tree (mode `current`).
- `corequisites`: `EvalNode` tree (mode `planned`).
- `exclusions`: `{ status, blockedBy }`. Passed or in-progress courses are matched against three
  kinds of excluded ids: parsed leaves of the rule, ids the field cites only in unparsed text
  (`ids` outside the rule, such as "ANT433H5 (Winter 2025)"), and codes absent from this calendar
  (`unresolved`).
  - `blocked`: the parsed rule is triggered (an OR needs one parsed match, an AND all of them).
    `blockedBy` lists every match.
  - `unknown` ("may exclude"): the parsed rule is not triggered, but a text-only or absent code
    matches, or the rule has unparsed parts that may trigger it. `blockedBy` lists those matches
    and may be empty (an unparsed rule that cites nothing on the record).
  - `clear`: nothing triggers or may trigger. A rule left as `true` (the parser dropped every
    cited code) never triggers.
- `restrictions`: restrictions are often negative ("not open to …") and are never evaluated as
  positive requirements. Text made only of enrolment-priority statements is an enrolment note
  (`isPriorityOnly`, spec 19.9): every sentence says who gets priority or preference ("Priority is
  given to students enrolled in …", "Priority given first to …", "Enrolment priority …") and none
  limits enrolment. Its node is `{ kind: 'true', status: 'met', text }`, so it never lowers
  `overall`. Any other restriction is `{ kind: 'unknown', status: 'unknown', text }`. The node is
  never `null` when the calendar lists a restriction, and it does not mirror the restriction's
  Rule. The UI can call `isPriorityOnly` to word the first kind as an enrolment note.
- `overall`: `all` of the parts above (`clear` → met, `blocked` → unmet, `unknown` → unknown).

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
- `completion`: `all` of the completion groups; `unknown` when the program has none. Sharing rules
  between groups are not parsed, so `met` also needs a split in which no course serves two
  groups. A greedy search (`claimDisjoint` in `evaluate.ts`) claims every required course, then an
  option of each OR whose courses are still free, then, for each credits rule, the smallest free
  records until its minimum is reached. When it finds no split, completion is `unknown`, never a
  false `met`. Most real programs keep unparsed clauses, so completion is usually unknown; the UI
  should present group progress.
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
   the dataset are skipped, and courses blocked by an exclusion are dropped. A course that only
   may be excluded stays, as `unknown`.

Ranking is by tier, then within a tier by `unlocks` (how many other program courses list the
course as a prerequisite), the order of the group that first led to it, and discovery order:

1. ready (`met`);
2. `unknown`, where the prerequisite is met, or the field cites no course, or at least one course
   it cites (parsed, text-only or absent from the calendar) is passed or in progress;
3. `unknown`, where none of the cited courses is taken;
4. `unmet`.

A course never precedes a listed course it still needs: a prerequisite in a part of its
prerequisite tree that is not met, directly or through further unmet prerequisites. Options of
an OR that is already met impose nothing. The list is built best first under that constraint, so
a truncated list never shows a dependent without its listed prerequisite.

`groups` lists the groups that reference the course; a prerequisite bridge that no group
references lists the groups that led to it. `reason`: `ready` (met), `check-requirements`
(unknown), `needs-corequisites` (unmet while the prerequisites are not unmet and the corequisites
are; the UI should name the missing corequisites), `needs-prerequisites` (any other unmet).

## Records with repeated rows

`recordFromRows(rows)` builds a record from rows that may repeat a course (an import, an old file):
passed > in progress > planned > failed, then the higher grade, whatever the row order.

## Known limits

- The record has no cohort, admission or permission. Cohort-specific program branches stay
  unknown unless met, and "take next" may offer courses from more than one cohort branch.
- Unparsed calendar wording stays unknown. Of 2,041 non-empty prerequisites, 1,086 contain
  unparsed text (903 are unparsed at the top level) and 1,153 contain a leaf the record cannot
  decide (unparsed text, a permission or a program admission). 196 of 1,148 exclusions are
  unparsed. 220 courses carry a restriction: 133 are enrolment-priority notes and 87 stay unknown.
- The greedy completion check can report `unknown` for a program that does have a disjoint split.
- Availability, timetables, enrolment controls and seat limits are out of scope.

## Validation and tests

- `npm run data:validate` (`scripts/validate-catalog.ts [dataDir]`, default `utm`): catalog
  identity against `data/campuses.json` (campus id, id prefix, campus digit, calendar URL), the
  Rule AST, every AST reference listed in `courseIds`, and optional `mentionedIds` /
  `unresolvedIds` that the AST never uses and that are never graph references (unresolved ids are
  also same-campus and absent from the catalog), plus the optional course fields. It also reports
  same-campus references that point at no course.
- `tests/domain.test.ts`: evaluator core (cohort clauses, credit bounds, disjoint claims), rule
  helpers, `isPriorityOnly`, record merging, and no CJK text anywhere under `src/domain`.
- `tests/domain-engine.test.ts`: the API on synthetic datasets, including the review regressions
  (exclusion kinds, absent codes, failed courses, ranking tiers, prerequisite order, reasons), and
  the whole-catalog performance budget.
- `tests/domain-official.test.ts`, `tests/catalog.test.ts`: real-catalog regressions (CS Major
  ranking, the retired MAT137Y5, dated exclusions, enrolment-priority restrictions).

Run: `npx vitest run tests/domain.test.ts tests/domain-engine.test.ts tests/domain-official.test.ts tests/catalog.test.ts`.
