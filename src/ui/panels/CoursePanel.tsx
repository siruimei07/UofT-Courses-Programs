// Course tab (design-spec 6.7.1): header with record control, chain summary (the screen-reader
// chain list of section 12), official requirement text with evaluated trees, and description.
import { memo, useContext, useId, useMemo, useState, type ReactNode } from 'react'
import { classifyRequirements, type CoreqReadout, type NeedsReadout } from '../../app/readout'
import { actions, useApp, type RecordEntry } from '../../app/store'
import type { GraphCourse, RequirementLite } from '../../data/schema'
import { loadDetails } from '../../data/load'
import type { CourseEngine, CourseEvaluation, EvalNode } from '../../domain/engine-types'
import { format, formatNumber, useLang, useStrings } from '../../i18n'
import { CourseChip, ChipList, RecordGlyph } from './CourseChip'
import { PanelContext, useCampusData, usePanelEnv } from './context'
import { capList, codeOf, coursePageUrl, creditsText, levelText, parseGrade, plural, pushRecent } from './format'
import { Disclosure, ExternalLink, LoadError, OfficialText, PanelEnvProvider, Readout, Segmented, Skeleton, SourceFooter, Template } from './parts'
import { failedGrade, gradedEntry, gradeText, nextRecordEntry, recordMark, syncGradeDraft, type RecordChoice } from './record'
import { RuleTree } from './RuleTree'
import { panelStrings, type PanelStrings } from './strings'
import {
  chainOf, exclusionNote, isUnparsed, mentionsOf, relationsOf, ruleAsEval, unlocksReadout, unresolvedOf,
  type Chain, type Mention, type Relation,
} from './summary'
import type { PanelProps } from './types'

const LIST_LIMIT = 24
const RECENT_MAX = 6

export function CoursePanel(props: PanelProps) {
  const env = useContext(PanelContext)
  if (env) return <CourseView engine={props.engine} onCenter={props.onCenter} />
  return (
    <PanelEnvProvider props={props}>
      <CourseView engine={props.engine} onCenter={props.onCenter} />
    </PanelEnvProvider>
  )
}

interface ViewProps {
  engine: CourseEngine
  onCenter(courseId: string): void
}

const CourseView = memo(function CourseView({ engine, onCenter }: ViewProps) {
  const { courses } = usePanelEnv()
  const focusId = useApp(state => state.focusId)
  const [recent, setRecent] = useState<string[]>(() => (focusId ? [focusId] : []))
  const [seen, setSeen] = useState(focusId)
  if (focusId !== seen) {
    setSeen(focusId)
    if (focusId) setRecent(list => pushRecent(list, focusId, RECENT_MAX))
  }
  const course = focusId ? courses.get(focusId) : undefined
  if (!course) return <CourseEmpty recent={recent} />
  return <CourseDetails key={course.id} course={course} engine={engine} onCenter={onCenter} />
})

function CourseEmpty({ recent }: { recent: readonly string[] }) {
  const s = useStrings(panelStrings)
  return (
    <div className="rp-empty">
      <p>{s.courseEmpty}</p>
      {recent.length ? (
        <div className="rp-recent">
          <h3 className="rp-sublabel">{s.recentlyViewed}</h3>
          <ChipList ids={recent} label={s.recentlyViewed} />
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_CHAIN: Chain = { focus: -1, directPreds: [], directCoreqs: [], earlierPreds: [], directSuccs: [], laterSuccs: [] }

function evaluate(engine: CourseEngine, courseId: string, record: ReadonlyMap<string, RecordEntry>): CourseEvaluation | null {
  try {
    return engine.evaluateCourse(courseId, record)
  } catch {
    // An engine failure must not take the official text down with it.
    return null
  }
}

function CourseDetails({ course, engine, onCenter }: ViewProps & { course: GraphCourse }) {
  const s = useStrings(panelStrings)
  const { topology, record, courses } = usePanelEnv()
  const focus = topology.indexById.get(course.id)
  const chain = useMemo(() => (focus === undefined ? EMPTY_CHAIN : chainOf(topology, focus)), [topology, focus])
  const relationOf = useMemo(() => {
    const relations = relationsOf(chain)
    return (id: string): Relation => {
      const index = topology.indexById.get(id)
      return index === undefined ? 'none' : relations.get(index) ?? 'none'
    }
  }, [chain, topology])
  const evaluation = useMemo(() => evaluate(engine, course.id, record), [engine, course.id, record])
  const mentions = useMemo(
    () => (focus === undefined ? [] : mentionsOf(course, topology, focus, [course.prereq, course.coreq])),
    [course, topology, focus],
  )
  const unresolved = useMemo(() => unresolvedOf(course, id => courses.has(id)), [course, courses])

  return (
    <article className="rp-course" aria-label={`${course.code} ${course.title}`}>
      <CourseHeader course={course} onCenter={onCenter} />
      <ChainSummary course={course} chain={chain} />

      {course.prereq ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.prerequisites}</h3>
          <Requirement field={course.prereq} node={evaluation?.prerequisites ?? null} relationOf={relationOf} />
          <Mentions mentions={mentions} relationOf={relationOf} />
        </section>
      ) : mentions.length ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.prerequisites}</h3>
          <Mentions mentions={mentions} relationOf={relationOf} />
        </section>
      ) : null}

      {course.coreq ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.corequisites}</h3>
          <Requirement field={course.coreq} node={evaluation?.corequisites ?? null} relationOf={relationOf} />
        </section>
      ) : null}

      {course.recommended ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">
            {s.recommended} <span className="rp-sec-note">{s.notRequired}</span>
          </h3>
          <OfficialText text={course.recommended.text} />
          <ReferencedChips field={course.recommended} relationOf={relationOf} />
        </section>
      ) : null}

      {course.exclusion ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.exclusions}</h3>
          <OfficialText text={course.exclusion.text} />
          <ReferencedChips field={course.exclusion} relationOf={relationOf} />
          <ExclusionNote evaluation={evaluation} />
        </section>
      ) : null}

      {course.restriction || course.notes ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.restrictions}</h3>
          {course.restriction ? <OfficialText text={course.restriction.text} /> : null}
          {course.restriction ? <ReferencedChips field={course.restriction} relationOf={relationOf} /> : null}
          {course.notes ? <OfficialText text={course.notes} /> : null}
        </section>
      ) : null}

      {unresolved.length ? (
        <section className="rp-sec">
          <h3 className="rp-sec-title">{s.notInCalendar}</h3>
          <ChipList ids={unresolved} label={s.notInCalendar} />
        </section>
      ) : null}

      <Description course={course} />
      <SourceFooter />
    </article>
  )
}

/** Red when a parsed exclusion matches the record; a soft "May exclude" note for a possible match. */
function ExclusionNote({ evaluation }: { evaluation: CourseEvaluation | null }) {
  const s = useStrings(panelStrings)
  const note = exclusionNote(evaluation?.exclusions)
  if (!note) return null
  const codes = note.ids.map(codeOf).join(s.listSep)
  return note.tone === 'blocked'
    ? <p className="rp-danger" role="note">{format(s.excludedByRecord, { codes })}</p>
    : <p className="rp-info" role="note">{format(s.mayExclude, { codes })}</p>
}

function CourseHeader({ course, onCenter }: { course: GraphCourse; onCenter(courseId: string): void }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { dataset } = usePanelEnv()
  // Distribution and delivery place are official wording; only the labels around them translate.
  const meta: ReactNode[] = [creditsText(course.credits, lang, s), format(s.level, { n: levelText(course.level) })]
  if (course.distribution) meta.push(<span lang="en">{course.distribution}</span>)
  if (course.deliveryCampus) meta.push(<Template template={s.deliveredAt} slots={{ place: <span lang="en">{course.deliveryCampus}</span> }} />)
  return (
    <header className="rp-head">
      <div className="rp-plate-row">
        <span className="rp-plate" lang="en">{course.code}</span>
        <span className="rp-meta rp-num-tab">
          {meta.map((part, i) => <span key={i}>{i ? s.metaSep : ''}{part}</span>)}
        </span>
      </div>
      {/* Focus target after a chip pick (the tab remounts for the new course). */}
      <h2 className="rp-title" lang="en" tabIndex={-1}>{course.title}</h2>
      <RecordControl course={course} />
      <div className="rp-links">
        <ExternalLink href={coursePageUrl(dataset.sources.coursePageTemplate, course.code)}>{s.officialPage}</ExternalLink>
        <button type="button" className="rp-link" onClick={() => onCenter(course.id)}>{s.centerOnMap}</button>
      </div>
    </header>
  )
}

function write(courseId: string, next: RecordEntry | null | 'unchanged'): void {
  if (next !== 'unchanged') actions.setRecord(courseId, next)
}

function RecordControl({ course }: { course: GraphCourse }) {
  const s = useStrings(panelStrings)
  const { record } = usePanelEnv()
  const entry = record.get(course.id)
  const stored = entry?.grade
  const [draft, setDraft] = useState(() => gradeText(stored))
  // Re-sync the input whenever the stored grade changes (typing, import, clear all, My courses).
  const [synced, setSynced] = useState(stored)
  if (stored !== synced) {
    setSynced(stored)
    setDraft(syncGradeDraft(draft, stored))
  }
  const parsed = parseGrade(draft)
  const failed = recordMark(entry) === 'failed'
  const options: { value: RecordChoice; label: string }[] = [
    { value: 'none', label: s.notTaken },
    { value: 'planned', label: s.planned },
    { value: 'inProgress', label: s.inProgress },
    { value: 'completed', label: s.completed },
  ]
  const onGrade = (text: string) => {
    setDraft(text)
    write(course.id, gradedEntry(entry, text))
  }
  const gradeId = `rp-grade-${course.code}`
  const failedId = `${gradeId}-failed`
  const describedBy = [parsed === 'invalid' ? `${gradeId}-error` : null, failed ? failedId : null].filter(Boolean).join(' ')
  return (
    <div className="rp-record">
      <Segmented
        className="rp-seg-full"
        options={options}
        value={entry?.status ?? 'none'}
        onChange={choice => write(course.id, nextRecordEntry(entry, choice))}
        label={format(s.recordControl, { code: course.code })}
        describedBy={failed ? failedId : undefined}
      />
      {entry?.status === 'completed' ? (
        <div className="rp-grade">
          <label htmlFor={gradeId}>{s.grade}</label>
          <input
            id={gradeId}
            className="rp-input rp-grade-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            maxLength={6}
            value={draft}
            aria-invalid={parsed === 'invalid'}
            aria-describedby={describedBy || undefined}
            onChange={event => onGrade(event.target.value)}
          />
          <span aria-hidden="true">%</span>
          {parsed === 'invalid' ? <span id={`${gradeId}-error`} className="rp-field-error">{s.gradeInvalid}</span> : null}
        </div>
      ) : null}
      {/* Completed below 50 (UTM Calendar F): not passed, no credit, may be retaken. */}
      {failed ? (
        <p id={failedId} className="rp-failed-note">
          <RecordGlyph status="failed" />
          <span>{s.failedNote}</span>
        </p>
      ) : null}
    </div>
  )
}

function needsSummary(needs: NeedsReadout, s: PanelStrings, n: (value: number) => string): ReactNode {
  switch (needs.kind) {
    case 'none': return <span>{s.readoutNoneListed}</span>
    case 'offMap': return <span>{s.readoutNoCourses}</span>
    case 'oneOf': return <Readout template={s.readoutNeedsOneOf} values={{ n: n(needs.of), t: n(needs.total) }} />
    case 'plain': return <Readout template={s.readoutNeeds} values={{ d: n(needs.direct), t: n(needs.total) }} />
    case 'alternatives': return <Readout template={s.readoutNeedsSome} values={{ d: n(needs.direct), t: n(needs.total) }} />
    case 'unknown': return <Readout template={plural(needs.direct, s.readoutUnknownOne, s.readoutUnknown)} values={{ d: n(needs.direct), t: n(needs.total) }} />
  }
}

function coreqSummary(coreqs: CoreqReadout, s: PanelStrings, n: (value: number) => string): ReactNode {
  switch (coreqs.kind) {
    case 'none': return null
    case 'plain': return <Readout template={plural(coreqs.count, s.coreqOne, s.coreqMany)} values={{ n: n(coreqs.count) }} />
    case 'oneOf': return <Readout template={s.coreqOneOf} values={{ n: n(coreqs.of) }} />
    case 'alternatives': return <Readout template={s.coreqAlternatives} values={{ n: n(coreqs.count) }} />
    case 'unknown': return <Readout template={plural(coreqs.count, s.coreqUnknownOne, s.coreqUnknownMany)} values={{ n: n(coreqs.count) }} />
  }
}

const NO_NEEDS: NeedsReadout = { kind: 'none' }

function ChainSummary({ course, chain }: { course: GraphCourse; chain: Chain }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { topology, record } = usePanelEnv()
  const failed = failedGrade(record.get(course.id))
  const [needsOpen, setNeedsOpen] = useState(true)
  const [unlocksOpen, setUnlocksOpen] = useState(true)
  const n = (value: number) => formatNumber(value, lang)
  // Same classifier as the card head (src/app/readout.ts), so both always say the same thing.
  const requirements = useMemo(
    () => (chain.focus < 0 ? null : classifyRequirements(course, topology, chain.focus)),
    [course, topology, chain.focus],
  )
  const unlocks = unlocksReadout(chain)
  const idsOf = (indices: readonly number[]) => indices.map(v => topology.nodes[v].id)

  const coreqText = requirements ? coreqSummary(requirements.coreqs, s, n) : null
  const needsText = (
    <>
      {needsSummary(requirements?.needs ?? NO_NEEDS, s, n)}
      {coreqText ? <> {coreqText}</> : null}
    </>
  )
  const unlocksText = unlocks.kind === 'none' ? <span>{s.readoutUnlocksNone}</span>
    : <Readout template={s.readoutUnlocks} values={{ d: n(unlocks.direct), t: n(unlocks.total) }} />

  return (
    <section className="rp-summary" aria-label={course.code}>
      {failed !== null ? <FailedRow grade={failed} /> : null}
      <ChainRow
        tone="pre"
        open={needsOpen}
        onToggle={() => setNeedsOpen(open => !open)}
        summary={needsText}
        label={format(s.needsList, { code: course.code })}
        lists={[
          // An unparsed rule (7.4): the courses are listed in its text, not known to be required
          // (CSC207H5 lists "CSC111H5 or CSC148H5").
          { key: 'direct', label: requirements?.needs.kind === 'unknown' ? s.listedDirectly : s.neededDirectly, ids: idsOf(chain.directPreds), relation: 'prereq-direct' },
          { key: 'coreq', label: s.takeTogether, ids: idsOf(chain.directCoreqs), relation: 'prereq-direct' },
          { key: 'earlier', label: s.neededEarlier, ids: idsOf(chain.earlierPreds), relation: 'prereq' },
        ]}
      />
      <ChainRow
        tone="unl"
        open={unlocksOpen}
        onToggle={() => setUnlocksOpen(open => !open)}
        summary={unlocksText}
        label={format(s.unlocksList, { code: course.code })}
        lists={[
          { key: 'direct', label: s.unlocksDirectly, ids: idsOf(chain.directSuccs), relation: 'unlock-direct' },
          { key: 'later', label: s.unlocksLater, ids: idsOf(chain.laterSuccs), relation: 'unlock' },
        ]}
      />
    </section>
  )
}

/** First summary row for a failed attempt: "Not passed (44%) · no credit · may be retaken". */
function FailedRow({ grade }: { grade: number }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  return (
    <p className="rp-chain-row rp-chain-row-static rp-failed-row">
      <span className="rp-readout">
        <RecordGlyph status="failed" size={10} />
        <span>
          <Template
            template={s.failedSummary}
            slots={{ status: <b className="rp-failed-label">{s.notPassed}</b>, grade: <span className="rp-num-tab">{formatNumber(grade, lang)}</span> }}
          />
        </span>
      </span>
    </p>
  )
}

interface ChainList {
  key: string
  label: string
  ids: string[]
  relation: Relation
}

function ChainRow({ tone, open, onToggle, summary, label, lists }: {
  tone: 'pre' | 'unl'
  open: boolean
  onToggle(): void
  summary: ReactNode
  label: string
  lists: ChainList[]
}) {
  const filled = lists.filter(list => list.ids.length)
  const line = (
    <span className="rp-readout">
      <span className={`rp-dot rp-dot-${tone}`} aria-hidden="true" />
      <span>{summary}</span>
    </span>
  )
  if (!filled.length) return <div className="rp-chain-row rp-chain-row-static">{line}</div>
  return (
    <Disclosure className="rp-chain-row" open={open} onToggle={onToggle} summary={line}>
      <div role="group" aria-label={label} className="rp-chain-lists">
        {filled.map(list => <ChainGroup key={list.key} list={list} />)}
      </div>
    </Disclosure>
  )
}

function ChainGroup({ list }: { list: ChainList }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const [expanded, setExpanded] = useState(false)
  const { shown, rest } = capList(list.ids, LIST_LIMIT, expanded)
  const headingId = useId()
  return (
    <div role="group" aria-labelledby={headingId} className="rp-chain-group">
      <h3 id={headingId} className="rp-sublabel">
        {list.label} <span className="rp-count">{formatNumber(list.ids.length, lang)}</span>
      </h3>
      <ul className="rp-chips">
        {shown.map(id => (
          <li key={id}>
            <CourseChip id={id} relation={list.relation} />
          </li>
        ))}
      </ul>
      {rest || expanded ? (
        <button type="button" className="rp-link rp-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? s.showFewer : format(s.showAll, { n: formatNumber(list.ids.length, lang) })}
        </button>
      ) : null}
    </div>
  )
}

/** Official text plus the evaluated tree, or the neutral state when the rule was not parsed. */
function Requirement({ field, node, relationOf }: { field: RequirementLite; node: EvalNode | null; relationOf(id: string): Relation }) {
  const s = useStrings(panelStrings)
  const unparsed = isUnparsed(field.rule)
  return (
    <>
      <OfficialText text={field.text} />
      {unparsed ? (
        <>
          <p className="rp-info">{s.unparsed}</p>
          {field.ids.length ? (
            <div>
              <h4 className="rp-sublabel">{s.coursesInText}</h4>
              <ChipList ids={field.ids} relation={relationOf} label={s.coursesInText} />
            </div>
          ) : null}
        </>
      ) : field.rule.kind === 'true' ? (
        field.ids.length ? <ChipList ids={field.ids} relation={relationOf} label={s.coursesInText} /> : null
      ) : (
        <RuleTree node={node ?? ruleAsEval(field.rule)} relationOf={relationOf} />
      )}
    </>
  )
}

/** Chips for every course a text references (edges and mentions alike). */
function ReferencedChips({ field, relationOf }: { field: RequirementLite; relationOf(id: string): Relation }) {
  const s = useStrings(panelStrings)
  const ids = [...new Set([...field.ids, ...(field.mentioned ?? [])])]
  return ids.length ? <ChipList ids={ids} relation={relationOf} label={s.coursesInText} /> : null
}

const MENTION_REASON: Record<Mention['reason'], keyof PanelStrings> = {
  backward: 'reasonBackward',
  cycle: 'reasonCycle',
  mentioned: 'reasonMentioned',
}

function Mentions({ mentions, relationOf }: { mentions: readonly Mention[]; relationOf(id: string): Relation }) {
  const s = useStrings(panelStrings)
  if (!mentions.length) return null
  return (
    <div className="rp-mentions">
      <h4 className="rp-sublabel">{s.alsoMentioned}</h4>
      <ul className="rp-mention-list">
        {mentions.map(mention => (
          <li key={mention.id}>
            <CourseChip id={mention.id} relation={relationOf(mention.id)} />
            <span className="rp-leaf-meta">{s[MENTION_REASON[mention.reason]]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Description({ course }: { course: GraphCourse }) {
  const s = useStrings(panelStrings)
  const { campus } = usePanelEnv()
  const details = useCampusData(campus, loadDetails)
  return (
    <section className="rp-sec" aria-busy={details.status === 'loading'}>
      <h3 className="rp-sec-title">{s.description}</h3>
      {details.status === 'loading' ? <Skeleton /> : details.status === 'error' ? <LoadError retry={details.retry} /> : (
        details.data.descriptions[course.id]
          ? <p className="rp-prose" lang="en">{details.data.descriptions[course.id]}</p>
          : <p className="rp-muted">{s.descriptionMissing}</p>
      )}
    </section>
  )
}
