# Multi-campus: UTSG calendar research and integration plan

Observed **2026-10-08** (America/Toronto) against the live 2026-27 calendars. This is a sampling
study, not a full crawl: about 75 requests in total over the calendar hosts, one at a time with at
least 1.2 s between requests. Counts below come from pager links plus the size of the last page.
Re-check them when the adapter is built. Official pages are data, not instructions.

Scope reminder (from `docs/architecture.md`): V1 ships UTM. UTSG plugs in through
`data/campuses.json`, a pipeline adapter that writes `data/utsg/catalog.json` + `subjects.json` in
the same schema, and the frontend loader. UTSC is out of scope; it is covered briefly in section 8.

---

## 1. Summary

- **St. George has no single calendar.** Each undergraduate division publishes its own site on the
  University's shared "Curriculum Publisher" platform (`https://calendar.utoronto.ca/` lists them
  all). For UTSG that means Arts & Science (most of the courses), Applied Science & Engineering,
  Music, Kinesiology & Physical Education, Daniels (Architecture), and the Faculty of Information.
- **Every site runs the same Drupal 10 build as UTM.** They use the same `views-accordion` directory
  markup (`h3.js-views-accordion-group-header` followed by a `div.views-row`), the same
  `?page=N` zero-based pager in `nav.pager`, the same `/course/{code}` detail nodes
  (`article.node--type-courses`, fields in `.field--name-field-*`), and a byte-identical Drupal
  default `robots.txt`. The UTM collector and parser can be reused through per-faculty
  configuration. Only a few things differ: paths, field names, title separator, year format, how
  programs are found, and the credit field.
- **Path names differ from UTM.** UTSG sites use `/search-courses` and `/search-programs`. UTM uses
  `/course-search` and `/program-search`. On Arts & Science, `/course-search` quietly redirects to
  `/course-not-in-calendar`.
- **Size.** About 6,500 course listings across UTSG divisions (Arts & Science 5,368, Engineering
  557, Music 327, Daniels 124, KPE 108, iSchool 22), with a few courses listed by two divisions.
  Arts & Science also lists 413 programs (Specialist, Major, Minor, Focus, Certificate, Combined
  Degree). That is about 2.6 times UTM's 2,491 courses and 168 programs.
- **Breadth replaces distribution.** Arts & Science and Daniels use five *breadth* categories
  (BR1–BR5), and one course can carry two. UTM uses a single *distribution* value (Humanities,
  Social Science, Science). Arts & Science has no Distribution field. Engineering, Music, KPE and
  iSchool have neither, but carry other fields (AUs, program tags, course category, fixed credit).
- **The UTM data already points at UTSG.** The UTM catalog references 808 distinct UTSG ids, mostly
  in exclusions (685 UTM courses), plus 44 UTM prerequisites and 147 program-requirement mentions.
  A random sample of 20 found 17 in the current Arts & Science calendar. The other 3 are retired.
  Some, such as `ECE286H1` and `MIE286H1`, are Engineering courses that the UTM pages wrongly link
  to the Arts & Science host.

---

## 2. The calendar landscape (Curriculum Publisher hub)

`https://calendar.utoronto.ca/` ("Curriculum Publisher – Participating Divisions") links every
calendar. All hosts answer with `<meta name="Generator" content="Drupal 10">`.

| Host | Division | Campus / level | In UTSG undergrad scope? | Course directory | Last page (0-based) → courses | Program discovery |
| --- | --- | --- | --- | --- | --- | --- |
| `artsci.calendar.utoronto.ca` | Faculty of Arts & Science | St. George, undergrad | **yes (core)** | `/search-courses` | `?page=178`, last page has 28 rows → **5,368** | `/search-programs` (`?page=13`, last page has 23 rows → **413**), plus `/program/{code}` |
| `engineering.calendar.utoronto.ca` | Applied Science & Engineering | St. George, undergrad | **yes** | `/search-courses` | `?page=18`, 17 rows → **557** | `/programs` → `/section/{Dept}` → program nodes such as `/undergraduate-program-computer-engineering-aecpebasc` |
| `music.calendar.utoronto.ca` | Faculty of Music | St. George, undergrad and diplomas | **yes** | `/search-courses` | `?page=10`, 27 rows → **327** | `/section/Bachelor-of-Music`, `/section/Bachelor-of-Music-in-Performance`, `/section/Certificates`, … |
| `kpe.calendar.utoronto.ca` | Kinesiology & Physical Education | St. George, undergrad | **yes** | `/search-courses` | `?page=3`, 18 rows → **108** | `/section/BKin`, `/section/Combined-Degree-Program`, `/certificates`, `/section/Global-Leadership` |
| `daniels.calendar.utoronto.ca` | Daniels Faculty (Architecture, Landscape, Design) | St. George, undergrad | **yes** | `/search-courses` | `?page=4`, 4 rows → **124** | `/section/Architectural-Studies`, `/section/Visual-Studies` |
| `ischool.calendar.utoronto.ca` | Faculty of Information (Bachelor of Information) | St. George, undergrad (years 3–4 entry) | optional | `/search-courses` | no pager, 22 rows → **22** | `/Bachelor-of-Information` |
| `pharmacy.calendar.utoronto.ca` | Leslie Dan Faculty of Pharmacy (PharmD) | professional, second-entry | no | `/search-courses` | not counted | `/section/Doctor-of-Pharmacy-(4~year)`, … |
| `md.calendar.utoronto.ca` | MD Program | professional | no | `/search-courses` | not counted | — |
| `sgs.calendar.utoronto.ca` | School of Graduate Studies | graduate | no | `/search-courses`, `/search-programs`, `/search-cdps` | not counted | — |
| `oise.academic-guide.utoronto.ca` | OISE | graduate | no | (not checked) | — | — |
| `utm.calendar.utoronto.ca` | UTM | Mississauga | (V1) | `/course-search` | 84 pages → 2,491 | `/program-search` → `/program/{code}` |
| `utsc.calendar.utoronto.ca` | UTSC | Scarborough | out of scope | `/search-courses` | `?page=72` → about 2,190 (last page not fetched) | `/search-programs` (`?page=8`) |

All directory pages show 30 rows. Counts are `30 × last page + rows on the last page`.

Homepage year headings (`h1.page-title`) **do not share a format**:

| Host | `h1.page-title` |
| --- | --- |
| artsci | `2026-27 Academic Calendar` ← two-digit end year |
| engineering | `2026-2027 Academic Calendar` |
| music, daniels, ischool, pharmacy | `2026-2027 Calendar` |
| kpe | `2026 - 2027 Calendar` |
| sgs | `School of Graduate Studies Calendar 2026-27` |
| utsc | `2026-2027 University of Toronto Scarborough Academic Calendar` |

The current UTM collector regex `(20\d{2})\s*[-–]\s*(20\d{2})` **fails on `2026-27`**. Use
`(20\d{2})\s*[-–]\s*(?:20)?(\d{2})` and normalise to `2026-2027`. The "PDF version of 2025-2026
Calendar" link labels on the Music, KPE, Daniels, Engineering and Pharmacy pages are stale text.
Never use them to establish the year.

---

## 3. What all calendar sites share

These points were verified on Arts & Science, Engineering, Music, KPE, Daniels, iSchool, UTSC and
UTM:

- **Directory view**: Drupal View `search_courses` (UTM, Engineering, Music, KPE, Daniels,
  iSchool, UTSC) or `course_search` (Arts & Science), display `page_1`. Each entity is an
  `h3.js-views-accordion-group-header > div[aria-label="CODE - Title"]` followed by a sibling
  `div.views-row`. That row holds **the full course record** as
  `.views-field.views-field-field-*` plus `.views-label` labels.
- **Header text**: `CODE - Title` on every UTSG site. UTM shows `CODE • Title` in the text and
  `CODE - Title` in the `aria-label`. The current discovery regex must accept `-`. Split on the
  **first** separator only, because titles can contain ` - ` (for example
  `KPE261H1 - Theory of Motor Skill Acquisition - Motor Learning`).
- **Pager**: `nav.pager a[href]` with `?page=0 … ?page=N`. Page 0 has no query string. The current
  collector already follows the pager dynamically and checks that pages are contiguous and not
  repeated. Keep doing that.
- **Detail pages**: `/course/{code}`. Upper- and lower-case both work, and both appear in
  official links (`/course/CSC108H1`,
  `https://engineering.calendar.utoronto.ca/course/mie245h1`). The page has
  `body.page-node-type-courses`, `article.node--type-courses`, `h1.page-title`, and fields in
  `.node__content .field--name-field-<name> .field__item` with a `.field__label`.
- **Title separator in `h1`**: UTSG sites use `CSC148H1: Introduction to Computer Science`. UTM
  uses `CSC148H5 • Introduction to Computer Science`. `parse_course` strips `' •·-'` and must also
  strip `:`.
- **Missing pages do not return 404.** An unknown code redirects with HTTP 200 to a soft-404 page:
  - Arts & Science: `/course-not-in-calendar` ("…retired or the course is offered in another
    division").
  - Engineering: `/course-not-available`.

  The collector must compare `finalUrl` with the requested URL and require
  `article.node--type-courses`. The current `'page-title' in html` check accepts soft-404 pages.
- **robots.txt is the same file on every host checked** (Drupal default, identical hash on
  artsci, engineering, music, utsc and utm). The rules:
  - `User-agent: *`.
  - Disallows `/core/`, `/profiles/`, `/admin/`, `/comment/reply/`, `/filter/tips`, `/node/add/`,
    `/search/`, `/user/{register,password,login,logout}`, `/media/oembed`, the `/index.php/…`
    variants, and a few README files.
  - **No `Crawl-delay`.**
  - `/search-courses`, `/search-programs`, `/course/`, `/program/` and `/section/` are allowed.
    `Disallow: /search/` is a path prefix with a trailing slash, so it does not match
    `/search-courses`. Python's `RobotFileParser` agrees.

  Keep the existing per-host `robots.txt` check, bounded workers, and pauses. Keep the
  descriptive User-Agent.
- **sitemap.xml is not useful**. Arts & Science's Simple XML Sitemap lists 124 URLs, none of them
  `/course/` pages.
- **Cross-calendar links**: course references in requirement fields are `<a>` tags. Links to other
  calendars are absolute, for example `https://utm.calendar.utoronto.ca/course/CSC148H5` or
  `https://utsc.calendar.utoronto.ca/course/CSCA48H3`. Links within the same calendar are relative
  (`/course/CSC108H1`), **even when the course belongs to another UTSG division**. Examples:
  - Engineering's `MIE245H1` excludes `/course/CSC263H1`, which resolves to Engineering's
    `/course-not-available`.
  - Arts & Science's `MUS110H1` excludes `/course/HMU111H1`, a Music-faculty course.
  - Arts & Science does link some Engineering courses absolutely
    (`https://engineering.calendar.utoronto.ca/course/mie245h1` from `CSC263H1`).

  **Never infer ownership or campus from the href.** Resolve by course code against the union of
  all UTSG faculty catalogs.

---

## 4. Faculty of Arts & Science (artsci.calendar.utoronto.ca)

### 4.1 URLs

| Purpose | URL |
| --- | --- |
| Year evidence | `https://artsci.calendar.utoronto.ca/` (`h1.page-title` = `2026-27 Academic Calendar`) |
| Course directory | `https://artsci.calendar.utoronto.ca/search-courses` → `?page=1 … ?page=178` |
| Course detail | `https://artsci.calendar.utoronto.ca/course/{code}` (e.g. `/course/csc148h1`) |
| Program directory | `https://artsci.calendar.utoronto.ca/search-programs` → `?page=1 … ?page=13` |
| Program detail | `https://artsci.calendar.utoronto.ca/program/{code}` (e.g. `/program/asmaj1689`, verified) |
| Section (program area) | `https://artsci.calendar.utoronto.ca/section/{Slug}` (e.g. `/section/Computer-Science`) |
| Section index | `https://artsci.calendar.utoronto.ca/listing-program-subject-areas` |
| Symbol and field rules | `/understanding-courses`, `/how-use-calendar`, `/understanding-programs-and-certificates` |

### 4.2 Course search

Exposed filters (form `views-exposed-form-course-search-page-1`, GET `/search-courses`):

- `course_keyword` (text)
- `field_section_value` (select, 90 program areas such as "Computer Science", "Rotman Commerce",
  "Victoria College")
- `field_prerequisite_value` (text)
- `field_breadth_requirements_value` (select, 5 categories)

UTM's filters are `field_sections_value`, `field_department_value` and
`field_distribution_requirements_value`. **Arts & Science has no department filter.**

Directory row fields seen in a sample of 148 rows from pages 0, 40, 90, 140 and 178:

| Views field | Label | Rows |
| --- | --- | --- |
| `body` | (description, unlabelled) | 148 |
| `field-hours` | Hours | 138 |
| `field-breadth-requirements` | Breadth Requirements | 132 |
| `field-prerequisite` | Prerequisite | 112 |
| `field-exclusion` | Exclusion | 83 |
| `field-previous-course-number` | Previous Course Number | 40 |
| `field-recommended` | Recommended Preparation | 18 |
| `field-corequisite` | Corequisite | 11 |
| `field-course-experience` | Course Experience | 3 |

Code suffixes in the same sample: `H1` 124, `Y1` 19, `Y0` 3, `H0` 2.

The directory row matched the detail page field-for-field in the one case compared (`ACT398H0`).
A "directory-only" collection mode is therefore plausible: 179 requests instead of about 5,550.
Treat it as an optimisation to validate on a larger sample, not as the default. Detail pages
remain the provenance unit, as at UTM.

### 4.3 Course page fields (detail)

Field names come from `.field--name-field-*` inside `article.node--type-courses`.

| Concept | Arts & Science field | Label | UTM field (for comparison) |
| --- | --- | --- | --- |
| Description | `field--name-body` | (none) | `field-desc` ("Description") |
| Hours | `field-hours` | Hours (`36L/24P`) | `field-hours` ("Total Instructional Hours") |
| Prerequisite | `field-prerequisite` | Prerequisite | `field-prerequisite` ("Prerequisites") |
| Corequisite | `field-corequisite` | Corequisite | `field-corequisite` |
| Exclusion | `field-exclusion` | Exclusion | `field-exclusion` ("Exclusions") |
| Recommended preparation | **`field-recommended`** | Recommended Preparation | **`field-recommended-preparation`** |
| Breadth | `field-breadth-requirements` | Breadth Requirements | — |
| Distribution | — (**does not exist**) | — | `field-distribution-requirements` |
| Old code(s) | `field-previous-course-number` | Previous Course Number | — |
| Course experience | `field-course-experience` | Course Experience | `field-course-experience` |
| Enrolment limits / restrictions | not seen in sample | — | `field-enrolment-limits` |
| Program area | **not on the detail page** (only directory filter and section pages) | — | `field-sections` ("Program Area") |
| Other UTM-only | — | — | `field-mode-of-delivery`, `field-note`, `field-campus` ("Campus Sheridan" ×37), `field-international-component` |

The parser should log every `field--name-*` it does not map (a field inventory per faculty) so
that a field seen once is not silently dropped.

### 4.4 Requirement notation (official, `/how-use-calendar`)

- `,` and `;` separate list items. By default every item is required ("assume the list indicates
  that a student must take all options").
- `+` is a strong AND that pairs courses into one option.
- `/` means OR.
- `( )` and `[ ]` group options.
- Minimum grades appear inline: `ECO101H1 (63%)`, or `… with an average grade of 73%` in program
  requirements.

UTM mixes words (`or`, `and`) with the same symbols. The existing `parse_rule` already gives `/`
the tightest binding inside `,`/`;` groups and turns `CODE (63%)` into `minGrade`. Tested offline
on live Arts & Science strings:

| Official text (abridged) | Current parser result | Verdict |
| --- | --- | --- |
| `BIO120H1, BIO130H1, (CHM135H1/CHM139H1, CHM136H1/CHM138H1)/CHM151Y1` | `all(BIO120, BIO130, any(all(any(135,139), any(136,138)), CHM151Y1))` | correct |
| `(ECO101H1 (63%), ECO102H1 (63%))/ECO105Y1 (80%)/ECO100Y5 (67%)/…; MAT133Y1/(MAT130H1/MAT135H1, MAT136H1)` | nested `any`/`all` with `minGrade` leaves; campuses resolved to `UTSG`/`UTM`/`UTSC` | correct |
| `CSC236H1/CSC240H1/…; STA237H1/… Prerequisite for Faculty of Applied Science and Engineering students: APS105H1/APS106H1/ESC180H1; ECE302H1` | Engineering clause merged into the main AND; `ECE302H1` becomes **mandatory for everyone** | **wrong.** Split `Prerequisite for <cohort> students:` into an `applicability` rule *before* parsing. |
| `CSC108H1 / (equivalent programming experience)` | `unknown` | acceptable (prose) |
| `ACT398H0 / CSC148H1` | `unknown`; `ACT398H0` is not recognised as a code | **wrong.** `COURSE_PATTERN` must accept campus digit `0`. |

### 4.5 Breadth requirements (replaces UTM distribution)

There are five categories (official label → normalised code):

1. `Creative and Cultural Representations (1)` → `BR1`
2. `Thought, Belief and Behaviour (2)` → `BR2`
3. `Society and its Institutions (3)` → `BR3`
4. `Living Things and Their Environment (4)` → `BR4`
5. `The Physical and Mathematical Universes (5)` → `BR5`

A half-credit course counts in one category. A full-credit course counts 0.5 in each of two
categories or 1.0 in one. Real values include
`Creative and Cultural Representations (1), Society and its Institutions (3)`, so **breadth is a
list**. Some courses have no breadth (for example `CSC299H1`). Daniels
uses the same five Arts & Science categories. UTSC uses five *different* categories (section 8).

### 4.6 Course code format

`ENG150Y1`, `STA313H1`: 8 characters, as defined on `/understanding-courses`.

- 3-letter designator. `J**` means joint, for example `JSC`, `JCC` or `JMB`, offered by two units.
  College designators include `VIC`, `TRN`, `INI`, `NEW`, `UNI`, `WDW`, `SMC`.
- 3-digit number: 100–400 level. The first digit is the level (used for bands).
- Weight: `H` = 0.5, `Y` = 1.0 at Arts & Science. Other faculties differ (section 5.2).
- Campus indicator: `1` = St. George, **`0` = taught off-campus** (for example `ACT398H0`
  Research Excursions, summer abroad), `3` = UTSC, `5` = UTM.

So UTSG ids are `UTSG:CSC148H1` and also `UTSG:ACT398H0`. The current
`COURSE_PATTERN = [A-Z]{3}(?:\d{3}|[A-Z]\d{2})[HY][135]` and
`course_id()` (`{'5':'UTM','1':'UTSG','3':'UTSC'}`, anything else becomes `external`) must add
`0 → UTSG`. No UTM requirement text references an `H0`/`Y0` code today, so UTM output is
unaffected.

### 4.7 Programs

- **Directory**: `/search-programs`, 14 pages, 413 entries. Filters:
  - `combine` (text)
  - `type`: `1` Combined Degree Program, `2` Specialist, `3` Major, `4` Minor, `5` Focus,
    `6` Certificate – Category 1, `7` Certificate – Category 2
  - `field_subject_area_prog_search_value` (98 areas)
- **Header**: `Computer Science Major (Science Program) - ASMAJ1689`. The code is the suffix
  after the last ` - `. Pattern: `AS(SPE|MAJ|MIN|FOC|CER|…)\d{4}[A-Z]?`, for example `ASFOC1689B`.
  UTM codes look like `ERMAJ…`/`ERSPE…`.
- **The directory row has no `/program/` link.** It only has `field-section-link` →
  `/section/Computer-Science`. The UTM discovery (`a[href*="/program/"]` in the header's parent)
  would raise "Unrecognized program entity". For Arts & Science, build the URL as
  `/program/{code.lower()}`.
- **Detail page** (`article.node--type-programs`, `h1` =
  `Computer Science Major (Science Program) - ASMAJ1689`):
  - `field-enrolment-requirements` (same name as UTM)
  - **`field-completion-requirements`** (UTM and Engineering use `field-completion-req`)
  - `field-section-link` ("Program Area Section": `Computer Science, Data Science`)
  - **There is no `field-post-code`.** Take the code from the `h1`.
  - Rows may also carry `body` (description).
- **Program type** comes from the title (Specialist, Major, Minor, Focus, Certificate, Combined
  Degree). "(Arts Program)", "(Science Program)" and "(BCom)" are a second dimension (degree type
  / program kind). Keep them as `programKind`.
- **Enrolment text** uses cohort language ("For students admitted … in the Year 1 Computer
  Science (CMP1) admission category") and grade averages ("with an average grade of 73%").
  `program_groups` already sends this kind of text to `unknown`/`applicability`.

### 4.8 Sections (program areas)

`/section/{Slug}` is the Arts & Science unit page. It contains three Views: `section_view` (intro
text), `programs_view` (every program of the area, with codes) and `courses_view` (every course
of the area as accordion rows). For example, `/section/Computer-Science` holds 27 programs and
86 courses (`CSC` 82, `JSC` 3, `JCC` 1). The course-search section filter lists 90 areas.

Sections are the only Arts & Science source for **subject → program area** (department-like)
mapping. Use them to build `data/utsg/subjects.json` (`department` = section name), or use the
`field_section_value` filtered searches. Crawling about 100 section pages also cross-checks the
program and course denominators.

"Sections" here are calendar program areas. Lecture/tutorial *sections* (meeting times) are not in
any calendar; they live in the Timetable (`ttb.utoronto.ca`) and are out of scope, as at UTM.

---

## 5. Other UTSG undergraduate faculties

### 5.1 Same platform, different field names

Directory rows were profiled on the first and last pages of each site, and one detail page per
site was read.

| Concept | Engineering | Music | KPE | Daniels | iSchool |
| --- | --- | --- | --- | --- | --- |
| Title `h1` | `ECE244H1: Programming Fundamentals` | `CMU112H1: …` | `KPE260H1: …` | `ARC200H1: …` | `INF313H1: …` |
| Description | **`field-desc`** (like UTM) | `body` | `body` | `body` | `body` |
| Credits | **`field-credit`** "Fixed Credit Value / Credit Value" (`0.50`, `0.25`, `0.15`, `0.05`) | **`field-fixed-credit`** "Fixed Credit" (`0.17`, `0.33`, …) | from code | from code | from code |
| Hours | `field-hours` (`36.6L/12.2T/24.4P`) | — | — | `field-hours` | `field-hours` |
| Prerequisite / Corequisite / Exclusion | `field-prerequisite` / `field-corequisite` / `field-exclusion` | same | same | same | `field-prerequisite` |
| Recommended | `field-recommended-preparation` | `field-recommended-preparation` | `field-recommended-preparation` | `field-recommended-preparation` | — |
| Restrictions | `field-enrolment-limits` | — | — | `field-enrolment-limits` | — |
| Classification | — | — | `field-course-category` (detail: `field-course-category-formatted`): Physical Cultural (A), Behavioural (B), Biophysical (C), Required, Applications | `field-breadth-requirements` (Arts & Science BR1–5) | `field-course-category`, `field-timetable` ("Year 1 - Winter") |
| Faculty-specific | `field-totalaus` (accreditation units: `53.8 (Fall), …`), **`field-program-tags`** (`AECPEBASC: Fall Session – Year 2`, linked to the program page) | `field_not_offered_this_year` (search filter) | `field-mode-of-delivery` | — | — |
| Directory filters | `field_section_value` (15 values, including Track One), `field_subject_area_target_id` (25 numeric ids → names) | `title` (11 category ids), `field_fixed_credit_value`, `field_not_offered_this_year_value` | `field_section_value`, `field_course_category_value`, `field_mode_of_delivery_value` | `field_section_value` (Architectural Studies, Visual Studies), `field_breadth_requirements_value` | `field_timetable_value`, `field_course_category_value` |
| Soft-404 | `/course-not-available` | (not tested) | (not tested) | (not tested) | (not tested) |

### 5.2 Credits are not always derivable from H/Y

Engineering and Music publish real credit weights that break the `H = 0.5 / Y = 1.0` rule:

- `APS100H1` = 0.25
- `AER303H1` = 0.15
- `APS150H1` = 0.05
- Music `EMU150H1` = 0.17, `EMU207Y1` = 0.33

`Course.credits` must prefer the official credit field when it exists and fall back to the suffix.
Record which one was used (`creditsSource`).

### 5.3 Programs outside Arts & Science

None of these faculties has `/search-programs`:

- **Engineering**: `/programs` → `/section/{Department}` → program nodes with long slugs
  (`/undergraduate-program-computer-engineering-aecpebasc`) and POSt-like codes (`AECPEBASC`,
  certificates `AECERAIEN`, `AEMIN…`). `field-completion-req` is a set of **term-by-term tables**
  ("Fall Session – Year 1", columns Lect./Lab./Tut./Wgt.) followed by elective lists. Course-side
  `field-program-tags` provide the same mapping in reverse: program code → session/year.
  Engineering programs are mostly fixed core plus electives. Model each tagged course as a
  completion group "Year N – Fall/Winter core", and keep the tables' raw text.
- **KPE, Music, Daniels, iSchool**: programs are sections of the page (`/section/BKin` has
  "Enrolment Requirements", "Completion Requirements", then the course list). There are no
  per-program nodes and no `/program/` links. Parse the section page as one program document with
  sub-headings, or (V1 of UTSG) **import Arts & Science and Engineering programs only** and list
  the rest as "see official page" links.

### 5.4 The same course can be listed by more than one faculty

Two cases were confirmed:

- **`APM446H1`** appears on both Arts & Science (with breadth BR5, `body`) and Engineering (with
  `field-credit`, `field-totalaus`, `field-desc`). The descriptions and prerequisites are
  identical.
- **`TMU130H1` Music Theory I** appears on both Music (`field-fixed-credit`) and Engineering (as a
  complementary-studies elective).

Engineering also lists `APM`, `MAT`, `PHY`, `STA` and `CSC` subject areas, so more overlap is
likely. In the other direction, Arts & Science does **not** list Engineering, KPE or Daniels
courses: `/course/ECE286H1`, `/course/APS360H1`, `/course/KPE260H1` and `/course/ARC200H1` all
return `/course-not-in-calendar`. Arts & Science does list `MUS…` courses (its own "Music"
section). The Music faculty's `CMU`/`EMU`/`HMU`/`PMU`/`SMU`/`TMU` courses are separate.

Rules for the UTSG adapter:

1. **One node per course code**: id `UTSG:APM446H1`. Never create two nodes.
2. `faculty` = owning faculty: the faculty listed first in a fixed priority order. Use Arts &
   Science for Arts & Science subjects, otherwise the faculty that lists the most courses with
   that prefix. Store `listedBy: ['ARTSCI','APSC']` with each listing's `sourceUrl` and
   `contentHash`.
3. Take requirement text from the owning faculty's page. Take the union of non-conflicting
   attributes (breadth from Arts & Science, credit/AU from Engineering). If the prerequisite,
   exclusion or corequisite raw text differs between listings, record it in the quality report.
   Do not merge silently.

### 5.5 Size and crawl budget (UTSG)

| Calendar | Directory pages | Course details | Program/section pages | Total |
| --- | --- | --- | --- | --- |
| Arts & Science | 179 | 5,368 | 14 + 413 + about 100 sections | about 6,074 |
| Engineering | 19 | 557 | about 20 | about 596 |
| Music | 11 | 327 | about 6 | about 344 |
| KPE | 4 | 108 | about 4 | about 116 |
| Daniels | 5 | 124 | 2 | 131 |
| iSchool | 1 | 22 | 1 | 24 |
| **Total** | | **about 6,500** | | **about 7,300** |

At the current collector settings (6 workers, 0.12 s pause per request) this takes roughly
10–30 minutes. At a single worker with a 0.5 s pause it takes about 1.5–2 h. Keep it a manual annual run.

---

## 6. Differences vs UTM (adapter checklist)

| Aspect | UTM | UTSG |
| --- | --- | --- |
| Calendars | 1 host | 6 hosts (Arts & Science, Engineering, Music, KPE, Daniels, iSchool), one "faculty" dimension |
| Search paths | `/course-search`, `/program-search` | `/search-courses`, `/search-programs` (Arts & Science only) |
| Directory header | `CODE • Title` | `CODE - Title` |
| Detail `h1` | `CODE • Title` | `CODE: Title` |
| Year heading | `2026-2027` | `2026-27` (Arts & Science), `2026 - 2027` (KPE) |
| Campus digit | `5` | `1`, plus `0` (off-campus) |
| Description field | `field-desc` | `body` (Engineering: `field-desc`) |
| Recommended field | `field-recommended-preparation` | `field-recommended` (Arts & Science), `field-recommended-preparation` (others) |
| Classification | distribution (1 of 3) | breadth BR1–BR5, a **list** (Arts & Science, Daniels); none (Engineering, Music); KPE course category |
| Program area | `field-sections` on detail page | section pages / directory filter only |
| Department | directory filter `field_department_value` | none (Arts & Science) → use sections; Engineering departments = sections |
| Credits | from code | official field for Engineering and Music (fractional) |
| Program link | in directory header | Arts & Science: construct `/program/{code}`; others: sections/tables |
| Program completion field | `field-completion-req` | `field-completion-requirements` (Arts & Science), `field-completion-req` (Engineering) |
| Program code field | `field-post-code` | in `h1` / header suffix |
| Missing course | — | soft-404 with HTTP 200 (`/course-not-in-calendar`, `/course-not-available`) |
| Requirement notation | words + symbols | mostly symbols `, ; / + ( )`, inline `(63%)`, cohort clauses ("Prerequisite for … students:") |
| Extra fields | mode of delivery, notes, international component, campus (Sheridan) | previous course number (aliases), AUs, program tags, fixed credit, course category |
| Cross-listed duplicates | none | yes (section 5.4) |

---

## 7. Cross-campus references today (UTM data)

`pipeline/calendar_parser.py` assigns campus from the last code digit (`course_id`): 5 → UTM,
1 → UTSG, 3 → UTSC, other → `external`. Every referenced id is stored in
`Requirement.courseIds` and in `Rule` leaves (`course` / `minGrade` / `credits.courseIds`).
`data/external-references.json` lists every referenced id that is not a catalog node:

| Status | Count | Meaning |
| --- | --- | --- |
| `UTSG` / `external` | 808 | UTSG ids. `officialLinks` all point to `https://artsci.calendar.utoronto.ca/course/{CODE}` because the UTM pages hard-link every `*1` code there. |
| `UTSC` / `external` | 378 | links to `utsc.calendar.utoronto.ca` |
| `UTM` / `unresolved` | 387 | UTM codes not in the current UTM calendar (retired, such as `ANT200Y5`) |

The 808 UTSG ids span 75 prefixes. Most are Arts & Science; some belong to other faculties:
`ECE286H1`, `MIE286H1` (Engineering; UTM's `CSC263H5`/`CSC311H5` accept them as prerequisites),
`KPE360H1`, `KPE462H1` (KPE).

Distinct (course, referenced id) pairs in `data/utm/catalog.json`:

| Field | → UTSG | → UTSC | UTM courses affected (UTSG) |
| --- | --- | --- | --- |
| prerequisites | 64 | 13 | 44 |
| corequisites | 1 | 0 | 1 |
| exclusions | 1,040 | 484 | 685 |
| recommended | 5 | 0 | 4 |
| restrictions | 0 | 0 | 0 |
| program groups | 147 mentions | 10 | — |

Example: `MAT134H5` accepts `MAT135H1` and `MATA29H3`/`MATA30H3`/`MATA31H3` as alternatives.
`BIO478H5` accepts `IMM250H1`/`IMM340H1`/`IMM341H1`/`BIOC39H3`. 9 UTM prerequisites that mention
UTSG ids still contain `unknown` nodes.

Resolution sample: 20 random UTSG ids were checked against the Arts & Science calendar. 17 exist.
3 redirect to `/course-not-in-calendar`: `GGR220H1`, `CSC421H1`, `ENG270Y1`, which are retired.
`MAT137Y1` is also retired (Arts & Science's own requirements still say
`MAT148H1, MAT149H1 / MAT137Y1`). Engineering codes linked to the Arts & Science host are always
soft-404s there. Expect about 85% of current UTSG references to resolve to a UTSG node and about
15% to stay external ("not in the current calendar"). Arts & Science's
`field-previous-course-number` can map some retired codes to their successors. Show that only as a
hint, never as an automatic equivalence (`docs/data/rule-engine.md`).

The reverse direction will look the same. Arts & Science requirement fields reference UTM and
UTSC codes (`CSC236H5`, `CSCB36H3`, `ECO100Y5 (67%)`, …), so UTSG nodes will carry `UTM:`/`UTSC:`
ids as external references.

---

## 8. UTSC (brief; out of scope)

- Host: `utsc.calendar.utoronto.ca`, the same Drupal build.
- Courses: `/search-courses`, 73 pages (`?page=72`), about 2.2k courses, filters
  `field_program_area_value`, `breadth`, `field_course_experience_value`.
- Programs: `/search-programs` (9 pages; headers such as `CERTIFICATE IN BIOARCHAEOLOGY - SCCER1030`;
  some combined-degree headers have **no code**).
- Codes: `CSCA48H3`. The level is a **letter** (`A` = 100, `B` = 200, `C` = 300, `D` = 400) and
  the campus digit is `3`. `COURSE_PATTERN` already accepts `[A-Z]\d{2}`. Band/level derivation
  must map the letter.
- Breadth: five UTSC-specific categories: Arts, Literature and Language; History, Philosophy and
  Cultural Studies; Social and Behavioural Sciences; Natural Sciences; Quantitative Reasoning.
- Row fields: `body`, `field-prerequisite`, `field-corequisite`, `field-exclusion`,
  `field-recommended-preparation`, `field-breadth-requirements`, `field-note`,
  `field-course-experience`, `field-timetable-link`.
- Effort once the UTSG generalisations exist: a single-host adapter close to UTM.

---

## 9. How the frontend should treat cross-campus references once UTSG exists

1. **One campus per canvas.** Graph nodes and layout edges come only from the active campus's
   `graph.json`. A UTSG graph has about 6.5k nodes, about 2.6 times UTM. A combined UTM+UTSG
   canvas is not a V2 goal. Lane keys are already `${campus}:${subject}`
   (`src/graph/topology.ts`), so a merged view stays possible later.
2. **Cross-campus ids are never layout edges.** The invariant "no edge in the same column" is
   unaffected.
3. **Details panel**: every referenced id is shown as a chip with a campus badge.
   - Same campus and in the dataset: a normal link that selects the node.
   - Other campus that is **available** in the registry and present in that campus's dataset: a
     link that switches campus (`#/utsg?course=CSC148H1`) and selects the course. Optionally show
     a hover card filled lazily from that campus's `graph.json`, which is already cached per
     campus in `src/data/load.ts`.
   - Other campus that is planned, or a code not found (retired): a muted chip "not in the current
     calendar" linking to the official URL. Build it from the owning faculty's
     `coursePageTemplate` when known; otherwise use the link captured from the source page. For
     UTSG ids referenced from UTM, do **not** trust the captured `artsci` link for non-Arts &
     Science prefixes. Look up the UTSG dataset first.
4. **Eligibility evaluation** stays id-exact. A UTSG course marked as completed in the student
   record (`localStorage` key `uoft-course-map:profile:v1` stores full ids) satisfies a UTM rule
   leaf `UTSG:MAT135H1`, and the reverse. Never infer equivalence from exclusions or
   previous-course numbers. The profile is shared across campuses, so switching campus keeps
   marks.
5. **Exclusion warnings**: about 1,040 UTM→UTSG and 484 UTM→UTSC exclusion pairs exist. If the
   profile contains an excluded id from any campus, flag the course ("you hold CSC148H1, which
   excludes CSC148H5"). Do not hide it.
6. **Optional, after V2**: a toggle "show other-campus prerequisites" that draws referenced
   external ids as hollow stub dots in a separate overlay lane. They do not take part in the
   topology, so the column invariants are unaffected. Not needed for the first UTSG release.

---

## 10. Integration checklist

### 10.1 Pipeline: generalise, then add a UTSG adapter

Refactor `pipeline/collect_calendar.py` and `pipeline/calendar_parser.py` so that hard-coded
`BASE`, `CACHE`, `OUT`, `'UTM'` and UTM field names come from a campus/faculty configuration.
UTM output must stay byte-identical. Run the existing `tests/test_calendar_parser.py` and
`tests/test_collection_cache.py` with an added regression check on `data/utm/catalog.json`.

Proposed module `pipeline/campuses.py`:

```python
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal, Protocol, Iterable

CampusId = Literal['UTM', 'UTSG', 'UTSC']

@dataclass(frozen=True)
class FacultySource:
    """One calendar host. UTM has one; UTSG has six."""
    id: str                       # 'ARTSCI', 'APSC', 'MUSIC', 'KPE', 'DANIELS', 'ISCHOOL', 'UTM'
    name: str                     # 'Faculty of Arts & Science'
    base_url: str                 # 'https://artsci.calendar.utoronto.ca'
    course_search_path: str       # '/search-courses' (UTM: '/course-search')
    program_search_path: str | None   # '/search-programs' | None when programs live in sections
    program_discovery: Literal['search', 'sections', 'none']
    course_page_template: str     # base_url + '/course/{slug}'   (slug = code.lower())
    program_page_template: str | None
    missing_page_paths: tuple[str, ...] = ('/course-not-in-calendar', '/course-not-available')
    title_separators: str = '•·:-'
    # concept -> candidate Drupal field names, first non-empty wins
    fields: dict[str, tuple[str, ...]] = field(default_factory=lambda: {
        'description': ('desc', 'body'),
        'prerequisites': ('prerequisite',),
        'corequisites': ('corequisite',),
        'exclusions': ('exclusion',),
        'recommended': ('recommended-preparation', 'recommended'),
        'restrictions': ('enrolment-limits',),
        'notes': ('note',),
        'breadth': ('breadth-requirements',),
        'distribution': ('distribution-requirements',),
        'credits': ('credit', 'fixed-credit'),
        'hours': ('hours',),
        'previousCodes': ('previous-course-number',),
        'programTags': ('program-tags',),
        'category': ('course-category-formatted', 'course-category'),
        'programCompletion': ('completion-req', 'completion-requirements'),
        'programEnrolment': ('enrolment-requirements',),
        'programCode': ('post-code',),
    })
    priority: int = 0             # owner tie-break for cross-listed codes (lower wins)


@dataclass
class DirectoryEntry:
    kind: Literal['course', 'program']
    code: str                     # 'CSC148H1' / 'ASMAJ1689'
    title: str
    url: str                      # detail URL (constructed, not scraped, for ArtSci programs)
    directory_url: str
    faculty: str


class CampusAdapter(Protocol):
    campus: CampusId
    campus_digits: dict[str, CampusId]          # {'1': 'UTSG', '0': 'UTSG', '5': 'UTM', '3': 'UTSC'}
    faculties: tuple[FacultySource, ...]

    def academic_year(self, fetcher: 'Fetcher', source: FacultySource) -> tuple[str, dict]:
        """Read h1.page-title of the faculty homepage. Accept '2026-27', '2026 - 2027' and
        '2026-2027'. Return ('2026-2027', evidence). All faculties must agree or collection
        fails."""

    def discover(self, fetcher: 'Fetcher', source: FacultySource,
                 kind: Literal['course', 'program']) -> dict:
        """Follow nav.pager from the search path. Return {'entryUrl', 'pages', 'entities':
        [DirectoryEntry], 'duplicates', 'complete'} (same shape as today's discover())."""

    def discover_sections(self, fetcher: 'Fetcher', source: FacultySource) -> list[dict]:
        """ArtSci/Engineering/KPE/Music/Daniels /section/* pages:
        [{'slug', 'name', 'programCodes': [...], 'courseCodes': [...], 'url', 'contentHash'}]."""

    def is_missing(self, requested_url: str, fetched: dict) -> bool:
        """True for soft-404s (finalUrl path in missing_page_paths or no
        article.node--type-courses/programs)."""

    def parse_course(self, source: FacultySource, entry: DirectoryEntry, fetched: dict) -> dict:
        """Return a Course dict (src/domain/types.ts) with campus, faculty, breadth, credits and
        creditsSource. Split cohort clauses ('Prerequisite for … students:') into 'applicability'
        rules before parse_rule."""

    def parse_program(self, source: FacultySource, entry: DirectoryEntry, fetched: dict) -> dict:
        """Return a Program dict. Take the code from the h1 suffix when field-post-code is
        absent."""

    def merge_listings(self, courses: Iterable[dict]) -> tuple[list[dict], list[dict]]:
        """Collapse cross-listed codes to one Course (owner by priority, listedBy[], field
        union). Return (courses, conflicts) for the quality report."""

    def build_subjects(self, courses: list[dict], sections: list[dict]) -> dict:
        """data/<campus>/subjects.json: {'divisions': [...], 'subjects': [{'code', 'name',
        'department', 'division'}]}. UTSG: division = faculty id, department = section name
        (majority over the prefix's courses)."""


def course_id(code: str, digits: dict[str, CampusId]) -> str:
    """'CSC148H1' -> 'UTSG:CSC148H1'; unknown digit -> 'external:CODE'."""

COURSE_PATTERN = r'[A-Z]{3}(?:\d{3}|[A-Z]\d{2})[HY][0135]'   # adds 0 (off-campus)

def collect(adapter: CampusAdapter, args) -> dict: ...          # writes .cache/calendar/<campus>/manifest.json
def build_catalog(adapter: CampusAdapter, manifest: dict, allow_decrease: bool = False,
                  accept: bool = False) -> dict: ...            # writes data/<campus>/catalog.json
```

Other pipeline items:

- **Cache layout**: keep `sha256(url).json` file names. URLs are unique across hosts. Move
  generation state per campus to `.cache/calendar/utsg/{active-run.json,manifest.json}` so a UTSG
  `--refresh` can never invalidate the UTM generation. UTM can stay at `.cache/calendar/` until it
  is migrated deliberately.
- **CLI**: `python pipeline/collect_calendar.py --campus utsg [--faculty artsci] --refresh`.
  `--faculty` restricts collection for incremental bring-up. **Publishing still requires all
  faculties complete.**
- **Denominators**: per faculty, the directory entities must equal successful details, as today.
  Add a soft-404 count (must be 0 for directory-discovered codes) and a cross-listing count.
- **Year guard**: every UTSG faculty must report the same academic year.
- **Parser fixes found in this study** (also useful for UTM robustness):
  1. Campus digit `0`.
  2. `:` title separator.
  3. Year regex.
  4. Cohort clause split.
  5. `field-recommended` alias.
  6. Official credit field.
  7. Breadth as a list.
- **Tests** (`tests/test_calendar_parser.py`): fixtures from the live strings in section 4.4.
  Header parsing `KPE261H1 - Theory … - Motor Learning`; soft-404 detection; the cross-listing
  merge (`APM446H1`, `TMU130H1`).

### 10.2 Registry entry: `data/campuses.json`

The existing UTSG entry stays valid for `scripts/build-frontend-data.ts`, which requires the
top-level keys and tolerates extra ones. Add a `faculties` array and `campusDigits`, and flip
`status` to `available` only after `data/utsg/catalog.json` passes validation.

```json
{
  "id": "UTSG",
  "name": "University of Toronto St. George",
  "shortName": "St. George",
  "status": "planned",
  "dataDir": "utsg",
  "calendarUrl": "https://artsci.calendar.utoronto.ca/",
  "courseSearchUrl": "https://artsci.calendar.utoronto.ca/search-courses",
  "programSearchUrl": "https://artsci.calendar.utoronto.ca/search-programs",
  "coursePageTemplate": "https://artsci.calendar.utoronto.ca/course/{slug}",
  "programPageTemplate": "https://artsci.calendar.utoronto.ca/program/{slug}",
  "campusDigit": "1",
  "campusDigits": ["1", "0"],
  "classification": "breadth",
  "faculties": [
    { "id": "ARTSCI",  "name": "Faculty of Arts & Science", "priority": 0,
      "calendarUrl": "https://artsci.calendar.utoronto.ca/",
      "courseSearchUrl": "https://artsci.calendar.utoronto.ca/search-courses",
      "programSearchUrl": "https://artsci.calendar.utoronto.ca/search-programs",
      "coursePageTemplate": "https://artsci.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": "https://artsci.calendar.utoronto.ca/program/{slug}",
      "programDiscovery": "search" },
    { "id": "APSC",    "name": "Faculty of Applied Science & Engineering", "priority": 1,
      "calendarUrl": "https://engineering.calendar.utoronto.ca/",
      "courseSearchUrl": "https://engineering.calendar.utoronto.ca/search-courses",
      "programSearchUrl": "https://engineering.calendar.utoronto.ca/programs",
      "coursePageTemplate": "https://engineering.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": null,
      "programDiscovery": "sections" },
    { "id": "MUSIC",   "name": "Faculty of Music", "priority": 2,
      "calendarUrl": "https://music.calendar.utoronto.ca/",
      "courseSearchUrl": "https://music.calendar.utoronto.ca/search-courses",
      "programSearchUrl": null,
      "coursePageTemplate": "https://music.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": null,
      "programDiscovery": "sections" },
    { "id": "KPE",     "name": "Faculty of Kinesiology & Physical Education", "priority": 3,
      "calendarUrl": "https://kpe.calendar.utoronto.ca/",
      "courseSearchUrl": "https://kpe.calendar.utoronto.ca/search-courses",
      "programSearchUrl": null,
      "coursePageTemplate": "https://kpe.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": null,
      "programDiscovery": "sections" },
    { "id": "DANIELS", "name": "John H. Daniels Faculty of Architecture, Landscape, and Design", "priority": 4,
      "calendarUrl": "https://daniels.calendar.utoronto.ca/",
      "courseSearchUrl": "https://daniels.calendar.utoronto.ca/search-courses",
      "programSearchUrl": null,
      "coursePageTemplate": "https://daniels.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": null,
      "programDiscovery": "sections" },
    { "id": "ISCHOOL", "name": "Faculty of Information", "priority": 5,
      "calendarUrl": "https://ischool.calendar.utoronto.ca/",
      "courseSearchUrl": "https://ischool.calendar.utoronto.ca/search-courses",
      "programSearchUrl": null,
      "coursePageTemplate": "https://ischool.calendar.utoronto.ca/course/{slug}",
      "programPageTemplate": null,
      "programDiscovery": "none" }
  ]
}
```

UTM gets `"campusDigits": ["5"]`, `"classification": "distribution"`, and a one-element
`faculties` array (`UTM`) so that the code path is uniform. Extend `CampusSource` in
`scripts/build-frontend-data.ts`, and `CampusEntry` in `src/data/schema.ts` (with `faculties`
reduced to `{id, name, calendarUrl, coursePageTemplate}`), so the frontend can build official
links per faculty.

### 10.3 Schema fields to generalise (`src/domain/types.ts`, `src/data/schema.ts`)

| Type | Field | Change |
| --- | --- | --- |
| `Catalog.metadata.campus` | `'UTM'` | → `CampusId` (`'UTM' \| 'UTSG' \| 'UTSC'`) |
| `Catalog.metadata` | new | `faculties: { id, name, academicYear, academicYearSource, complete, courseCount, programCount }[]` |
| `Program.campus` | `'UTM'` | → `CampusId` |
| `Course` | new `faculty?: string` | owning faculty (`'ARTSCI'`, `'APSC'`, …; UTM: `'UTM'`) |
| `Course` | new `listedBy?: { faculty: string; sourceUrl: string; contentHash: string }[]` | cross-listing provenance (section 5.4) |
| `Course` | `distribution?: string` | keep for UTM; add **`breadth?: string[]`** (normalised `BR1`…`BR5` for Arts & Science/Daniels; UTSC codes later) with labels in a campus-level enum table `classifications: { scheme, values: {code,label}[] }` |
| `Course` | `credits: number` | keep; add `creditsSource: 'official' \| 'code'` (Engineering 0.25/0.15/0.05, Music 0.17/0.33) |
| `Course` | new `previousCodes?: string[]` | from `field-previous-course-number`; display only, never equivalence |
| `Course` | new `category?: string`, `programTags?: { programCode: string; label: string }[]` | KPE/iSchool category; Engineering program/term tags |
| `Course.level` | `int(code[3]) * 100` | derive by campus: digit for UTM/UTSG; UTSC letter A–D → 100–400 |
| `Program` | new `faculty?: string`, `kind?: string` | `kind` = "Arts Program" / "Science Program" / "BCom" / "BASc" |
| `Program.type` | Specialist/Major/Minor/Certificate/Focus | add `Combined Degree`, `Degree` (Engineering BASc), `Diploma` (Music); `PROGRAM_TYPE_ORDER` in the build script must accept them |
| `Program` | new `sections?: string[]` | Arts & Science `field-section-link` |
| `Rule` | unchanged | `applicability` already exists; use it for cohort clauses |
| `GraphCourse` (frontend) | `distribution?` | → add `breadth?: string[]`, `faculty?: string`, `creditsSource?` |
| `SubjectInfo` | `division` | UTSG: `division` = faculty id; `department` = Arts & Science section / Engineering department |
| `CampusEntry` | new `faculties?`, `classification?` | for campus switcher, filters, and official links |
| `src/app/persist.ts` | `COURSE_ID = /^(UTM\|UTSG\|UTSC):[A-Z0-9]{6,10}$/` | already accepts `UTSG:ACT398H0`; keep |
| `src/domain/profile.ts` | campus prefix check | already accepts `UTSG`; keep |

Keep `schemaVersion: 1` if every change is additive and optional. Bump it to 2 if
`metadata.campus` widening or `breadth` is made required.

### 10.4 Frontend changes

- **Campus switcher** in the header, driven by `public/data/campuses.json`. `available` campuses
  are selectable; `planned` ones are shown disabled as "coming soon / 即将推出". Switching updates
  the URL hash (`#/utsg?course=CSC148H1&program=ASMAJ1689`). The selection and program reset
  unless the target campus has them. Theme, language and student profile persist.
- **Lanes keyed `campus:subject`**: already implemented (`lane.key = \`${campus}:${subject}\``).
  For UTSG, order lanes by division (= faculty, Arts & Science first), then department/section,
  then subject code. Arts & Science alone has about 90 sections and more subject prefixes than
  UTM's 70. Lane headers should show `faculty · section` and collapse faculty groups.
- **Faculty filter** (UTSG only): chips Arts & Science / Engineering / Music / KPE / Daniels /
  iSchool. All are on by default. Turning one off sets its nodes to `hidden`, a display class
  that already exists, so the topology is untouched.
- **Classification filter**: replace the UTM distribution chips with breadth chips BR1–BR5 when
  `campus.classification === 'breadth'`. A course matches if **any** of its breadth values is
  selected. Labels need English plus a Chinese translation (`广度要求`); the official category
  names stay in English per product rule 5.
- **Course details**: show `faculty`, `listedBy` links, official credit when
  `creditsSource === 'official'`, `previousCodes` as "formerly …", and cross-campus chips as
  described in section 9.
- **Data loading**: `graph.json` for UTSG is about 2.6 times UTM. Keep `details.json` and
  `programs.json` lazy. Measure gzip size in `build-frontend-data.ts` and consider a
  per-faculty split only if it exceeds the budget.
- **Program picker**: group by faculty and type. Show Engineering "term core" groups as ordered
  completion groups. Faculties without parsed programs show a link to the official section page
  only.
- **Tests**: topology invariants on a UTSG fixture that includes a cross-listed course, a `H0`
  course, a breadth list and a cohort-split prerequisite. E2E: campus switch keeps the profile,
  restores the hash, and handles cross-campus chip navigation.

### 10.5 Bring-up order

1. Generalise the pipeline with the UTM output unchanged (regression on `data/utm/catalog.json`).
2. Arts & Science courses and programs only, collected as `UTSG` with `faculties: [ARTSCI]`.
   `status` stays `planned`.
3. Add Engineering (with credits, program tags, sections), then Music, KPE, Daniels, iSchool, and
   the cross-listing merge.
4. Build `subjects.json` from sections; run `npm run data:build` and `npm run data:validate`;
   regenerate `data/external-references.json` for both campuses (UTSG ids referenced by UTM become
   resolved nodes).
5. Flip `UTSG.status` to `available`; ship the campus switcher, faculty and breadth filters.

---

## 11. Open questions and risks

- **Directory-only mode**: it would cut UTSG detail requests by about 95%. It needs a broader
  equality check between directory rows and detail pages before use.
- **Cross-listing owner rule**: the prefix-majority heuristic needs a reviewed override table, for
  example `APM` → Arts & Science and `TMU` → Music.
- **Non-Arts & Science program pages** (KPE, Music, Daniels) are free-form section documents.
  Parsing them into groups may not be worth it for the first UTSG release.
- **Soft-404 detection is per host.** Only the Arts & Science and Engineering soft-404 paths were
  observed. Detect by the missing `article.node--type-*` rather than by path alone.
- **Year mismatch**: if one faculty publishes later than the others, refuse to publish a mixed
  UTSG snapshot (same rule as UTM: one current snapshot only).
- **Second-entry/professional faculties** (Pharmacy, MD, Nursing, Dentistry, Law, SGS/OISE) are
  excluded by design.

## Sources (fetched 2026-10-08)

- https://calendar.utoronto.ca/ (Curriculum Publisher hub)
- https://artsci.calendar.utoronto.ca/ , `/search-courses` (pages 0, 40, 90, 140, 178), `/search-programs` (pages 0, 13), `/course/{csc148h1, csc263h1, csc110y1, csc299h1, chm136h1, eco200y1, rsm219h1, psy100h1, hmb265h1, apm446h1, mus110h1, act398h0}` plus 20 sampled UTSG ids, `/program/asmaj1689`, `/section/Computer-Science`, `/listing-program-subject-areas`, `/understanding-courses`, `/how-use-calendar`, `/robots.txt`, `/sitemap.xml`
- https://engineering.calendar.utoronto.ca/ , `/search-courses` (pages 0, 18), `/course/{ece244h1, mie245h1, apm446h1}`, `/programs`, `/undergraduate-program-computer-engineering-aecpebasc`, `/robots.txt`
- https://music.calendar.utoronto.ca/ , `/search-courses` (pages 0, 10), `/course/{cmu112h1, tmu130h1}`, `/robots.txt`
- https://kpe.calendar.utoronto.ca/ , `/search-courses` (pages 0, 3), `/course/kpe260h1`, `/section/BKin`
- https://daniels.calendar.utoronto.ca/ , `/search-courses` (pages 0, 4), `/course/arc200h1`
- https://ischool.calendar.utoronto.ca/ , `/search-courses`, `/course/inf313h1`
- https://utsc.calendar.utoronto.ca/ , `/search-courses`, `/search-programs`, `/robots.txt`
- https://md.calendar.utoronto.ca/ , https://pharmacy.calendar.utoronto.ca/ , https://sgs.calendar.utoronto.ca/ (homepages only)
- Local: `data/utm/catalog.json`, `data/external-references.json`, `.cache/calendar/*` (UTM HTML), `pipeline/*.py`, `scripts/build-frontend-data.ts`, `src/data/schema.ts`, `src/graph/topology.ts`

---

## 12. Implemented adapter (pipeline, 2026-10-08)

The first step of section 10.1 is in place: the pipeline is campus-aware and UTM output is
unchanged by the refactor itself (the offline re-parse was byte-identical before the parser fixes
of the same change landed). UTSG exists as a **planned stub**; nothing was collected for it.

**Code layout.** `pipeline/` is a package, run as `python -I pipeline [--campus utm] ...`
(`npm run data:collect`). Campus specifics live in `pipeline/campuses/`:

| File | Contents |
| --- | --- |
| `base.py` | `Campus`, a frozen dataclass holding every campus constant; `CAMPUS_DIGITS` (`5` UTM, `1` and `0` UTSG, `3` UTSC) |
| `utm.py` | `UTM`, status `available`: the values the collector and parser used before, verbatim |
| `utsg.py` | `UTSG`, status `planned`: Arts & Science values from sections 3, 4 and 6 of this document |
| `__init__.py` | `REGISTRY = {'utm': UTM, 'utsg': UTSG}` and `get_campus()` |

`Campus` fields: `id`, `name`, `status`, `data_dir`, `campus_digit`, `base_url`,
`course_search_path`, `program_search_path`, `course_page_template`, `program_page_template`,
`cache_dir`, `supplementary_dir`, the directory selectors and course-header pattern, pager selector,
page-title marker, `year_heading_re`, `supporting_slugs`, detail selectors (`title_selector`,
`course_article_selector`, `program_article_selector`), `title_separators`, `post_code_re`,
`course_fields` / `program_fields` (concept → Drupal field class, e.g. `description: field-desc`
for UTM and `body` for Arts & Science), `route_cue_re` and `cohort_cue_re` for program prose,
`seed_slugs` and `nav_rule_words_re` for supporting sources, and `data_root`. Derived values
(`calendar_url`, `course_search_url`, `out_dir`, `course_url()`, `course_level()`,
`course_credits()`, `academic_year()`) are methods, so a new campus overrides data, not code.
`tests/test_campuses.py` checks ids, campus digits, `dataDir`, status and all five URLs against
`data/campuses.json`.

**Isolation.** Each campus has its own cache and generation state: UTM keeps `.cache/calendar/`
(no migration), UTSG uses `.cache/calendar/utsg/` and `.cache/supplementary/utsg/`, so a UTSG
`--refresh` can never invalidate the UTM generation. Outputs go to `data/<data_dir>/`. All network
access goes through `pipeline/http.py` (one browser-like User-Agent, one global throttle of at
least 0.5 s between request starts, raised by any `robots.txt` crawl delay). The first HTTP
401/403/429 from any host stops the whole collection and saves the incomplete manifest; a missing
`robots.txt` (404/410) allows everything.

**Planned adapters are closed.** `collect()`, `build_catalog()` and the CLI raise
`NotImplementedError` (the CLI exits with a usage error) for a `planned` campus unless
`--allow-planned` is given, and an experimental run still only writes candidates until `--accept`.

**Covered from the checklist in section 10.1:** campus digit `0` in the course pattern and
`course_id()`; the `:` title separator; the `2026-27` year heading; field-name aliases (`body`,
`field-recommended`, `field-completion-requirements`); per-campus caches; `--campus`; the registry
consistency test. Conditional sentences such as `Students seeking …` / `For students …` are
split out of course prerequisites and their codes kept as mentions, which is the UTM half of the
"cohort clause split" item.

**Still open before UTSG can be collected:** the six-faculty `FacultySource` dimension (the stub
covers the Arts & Science host only); program URLs built from the directory header code (Arts &
Science rows have no `/program/` link, so program discovery fails today); soft-404 detection by
final URL and missing `article.node--type-*`; the `Prerequisite for <cohort> students:` split into
`applicability`; breadth as a list; official credit fields (Engineering, Music); the cross-listing
merge; and `data/utsg/subjects.json`. The design differs from the sketch in section 10.1 only in
form: one `Campus` record per campus instead of a `CampusAdapter` protocol, in a
`pipeline/campuses/` package instead of `pipeline/campuses.py`. A `faculties` tuple can be added to
`Campus` without touching UTM.
