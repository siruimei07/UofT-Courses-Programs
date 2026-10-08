# UTM current snapshot: data quality report

Academic year: 2026-2027. Evidence: the page heading `2026-2027 Calendar` at https://utm.calendar.utoronto.ca/.

Collection finished: 2026-10-08T04:33:00+00:00 (UTC); parser 1.1.0.

| Check | Result |
| --- | ---: |
| Course directory pages | 84 |
| Program directory pages | 6 |
| Courses discovered / detail ok / published | 2491 / 2491 / 2491 |
| Programs discovered / detail ok / published | 168 / 168 / 168 |
| Collection or parse failures | 0 |
| Duplicate directory identities | 0 |
| Non-empty prerequisite fields | 2041 |
| Non-empty prerequisites fully structured | 955 |
| Prerequisites with unknown clauses | 1086 |
| Requirements (all fields and program groups) with unknown / applicability | 3792 |
| Other-campus referenced ids | 1186 |
| UTM ids not in the current calendar (never edges) | 387 |
| Code typography repaired (glued / spaced / campus digit / suffix) | 2 / 2 / 6 / 4 |
| Unrecognised code-like tokens / H-Y weight mismatches (reported only) | 3 / 156 |
| "(formerly X)" aliases (reported, not substituted) | 11 |
| Prerequisite reference cycles (SCCs) | 0 |

Complete entity coverage does not mean every requirement is machine-understood. Whole program admission and completion rules stay `unknown` on purpose; requirement groups support sourced planning hints. Annual cutoffs, cohorts, streams, elective-pool allocation, permissions, high-school courses, complex credit combinations and other unparsed wording need manual confirmation. A simple exclusion list means any listed course triggers the exclusion; exclusions with contextual exceptions, or with "and" mixed into an "or" list, stay `unknown`.

Only `courseIds` are graph edges. Codes the text rules out ("except", "excluding", "no longer accepted"), advisory codes ("Highly Recommended", "Recommended Corequisite") and codes in conditional sentences ("Students seeking ...") are kept in `mentionedIds`; UTM codes absent from this calendar are kept in `unresolvedIds`. "(formerly X)" aliases are listed in the quality report and never substituted.

Cycles are computed over all prerequisite references, including OR alternatives and unknown clauses; they do not imply an impossible study path. Other-campus and retired references keep their full code and source; they are never expanded into other catalogs or treated as equivalent courses.

Details: `data/utm/manifest.json` keeps every directory URL, page number, entity list, hash, fetch time and detail status; `data/utm/quality-report.json` keeps every unknown rule with its reason, cross-campus and retired references with the entities citing them, code repairs, aliases, all cycles and the snapshot diff. Raw HTML stays in the local `.cache/calendar/` cache and is never published to the browser.

Program types: Certificate 11, Focus 2, Major 46, Minor 52, Specialist 57.

## Cycles

- none
