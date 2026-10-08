// Program tab (design-spec 6.7.2): a searchable picker when no program is selected; otherwise the
// program's progress, "Take next" suggestions and its admission and completion groups.
import { memo, useContext, useId, useMemo, useRef, useState } from 'react'
import { actions, useApp, type RecordEntry } from '../../app/store'
import type { ProgramGroupLite, ProgramLite } from '../../data/schema'
import { loadPrograms } from '../../data/load'
import type { CourseEngine, NextCourse } from '../../domain/engine-types'
import type { Eligibility } from '../../graph/types'
import { format, formatNumber, useLang, useStrings } from '../../i18n'
import { ChipList, CourseChip, StatusSvg } from './CourseChip'
import { PanelContext, useCampusData, usePanelEnv } from './context'
import { academicYearText, plural, programCode, programDisplayTitle } from './format'
import { Disclosure, ExternalLink, LoadError, OfficialText, PanelEnvProvider, Readout, Skeleton, SourceFooter, useOverflow } from './parts'
import {
  capSections, categories, filterPrograms, groupNumber, groupSections, programTypeChips, programTypeOf, tally, type CategorySummary,
  type ProgramTypeFilter,
} from './programs'
import { panelStrings, type PanelStrings } from './strings'
import { nextReason, type Relation } from './summary'
import type { PanelProps } from './types'

const NEXT_LIMIT = 5
const GROUP_LIMIT = 8

export function ProgramPanel(props: PanelProps) {
  const env = useContext(PanelContext)
  if (env) return <ProgramView engine={props.engine} />
  return (
    <PanelEnvProvider props={props}>
      <ProgramView engine={props.engine} />
    </PanelEnvProvider>
  )
}

const TYPE_LABEL: Record<ProgramTypeFilter, keyof PanelStrings> = {
  all: 'typeAll',
  Specialist: 'typeSpecialist',
  Major: 'typeMajor',
  Minor: 'typeMinor',
  Certificate: 'typeCertificate',
  Focus: 'typeFocus',
  other: 'typeOther',
}

/** Known types are translated; an unexpected official type is shown as printed. */
function typeLabel(type: string, s: PanelStrings): string {
  const key = programTypeOf(type)
  return key === 'other' ? type : s[TYPE_LABEL[key]]
}

const ProgramView = memo(function ProgramView({ engine }: { engine: CourseEngine }) {
  const s = useStrings(panelStrings)
  const { campus, dataset } = usePanelEnv()
  const programId = useApp(state => state.programId)
  const programs = useCampusData(campus, loadPrograms)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<ProgramTypeFilter>('all')

  if (programs.status === 'loading') {
    return (
      <div className="rp-pad" aria-busy="true">
        <p className="rp-muted">{s.programsLoading}</p>
        <Skeleton lines={5} />
      </div>
    )
  }
  if (programs.status === 'error') return <div className="rp-pad"><LoadError retry={programs.retry} /></div>

  const list = programs.data.programs
  if (programId) {
    const program = list.find(item => item.id === programId)
    if (program) return <ProgramDetails key={program.id} program={program} engine={engine} />
    return (
      <div className="rp-pad">
        <p className="rp-info">{format(s.programMissing, { year: academicYearText(dataset.academicYear) })}</p>
        <button type="button" className="rp-btn" onClick={() => actions.selectProgram(null)}>{s.clearProgram}</button>
      </div>
    )
  }
  return <ProgramPicker programs={list} query={query} onQuery={setQuery} type={type} onType={setType} />
})

function ProgramPicker({ programs, query, onQuery, type, onType }: {
  programs: readonly ProgramLite[]
  query: string
  onQuery(query: string): void
  type: ProgramTypeFilter
  onType(type: ProgramTypeFilter): void
}) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const chips = useMemo(() => programTypeChips(programs), [programs])
  const filtered = useMemo(() => filterPrograms(programs, query, type), [programs, query, type])
  const placeholder = format(s.programSearch, { n: formatNumber(programs.length, lang) })
  return (
    <div className="rp-picker">
      <div className="rp-picker-head">
        <input
          type="search"
          className="rp-input rp-search"
          placeholder={placeholder}
          aria-label={placeholder}
          value={query}
          onChange={event => onQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation()
              onQuery('')
            }
          }}
        />
        <div className="rp-filter" role="group" aria-label={s.programTypes}>
          {chips.map(chip => (
            <button
              key={chip.type}
              type="button"
              className="rp-filter-chip"
              aria-pressed={chip.type === type}
              onClick={() => onType(chip.type)}
            >
              {s[TYPE_LABEL[chip.type]]}
              <span className="rp-filter-count">{formatNumber(chip.count, lang)}</span>
            </button>
          ))}
        </div>
      </div>
      {filtered.length ? (
        <ul className="rp-rows">
          {filtered.map(program => {
            const code = programCode(program)
            return (
              <li key={program.id}>
                <button type="button" className="rp-row" onClick={() => actions.selectProgram(program.id)}>
                  <span className="rp-row-title" lang="en">{programDisplayTitle(program.title, program.code)}</span>
                  <span className="rp-row-meta">
                    {typeLabel(program.type, s)}
                    {code ? <>{s.metaSep}<span lang="en">{code}</span></> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rp-pad rp-muted">{format(s.programsEmpty, { q: query.trim() })}</p>
      )}
    </div>
  )
}

function attempt<T>(run: () => T): T | null {
  try {
    return run()
  } catch {
    // Engine failures leave the official text usable.
    return null
  }
}

const programRelation = (): Relation => 'program'

function ProgramDetails({ program, engine }: { program: ProgramLite; engine: CourseEngine }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { record, courses } = usePanelEnv()
  const progress = useMemo(() => attempt(() => engine.programProgress(program, record)), [engine, program, record])
  const next = useMemo(() => attempt(() => engine.nextCourses(program, record, NEXT_LIMIT)) ?? [], [engine, program, record])
  const sections = useMemo(() => categories(program, progress, record), [program, progress, record])
  const overall = tally(progress?.courseIds ?? program.groups.flatMap(group => group.ids).filter(id => courses.has(id)), record)
  const statusOf = useMemo(() => new Map(progress?.groups.map(group => [group.groupId, group.status]) ?? []), [progress])
  const percent = overall.total ? Math.round((overall.done / overall.total) * 100) : 0
  const n = (value: number) => formatNumber(value, lang)
  const progressTemplate = plural(overall.total, s.progressOne, s.progressMany)
  const code = programCode(program)
  const [officialOpen, setOfficialOpen] = useState(false)
  const official = [
    { label: s.description, text: program.description },
    { label: s.admission, text: program.admissionText },
    { label: s.completion, text: program.completionText },
    { label: s.notes, text: program.notes ?? '' },
  ].filter(block => block.text)

  return (
    <article className="rp-program" aria-label={program.title}>
      <header className="rp-head">
        <div className="rp-plate-row">
          <span className="rp-type-chip">{typeLabel(program.type, s)}</span>
          {code ? <span className="rp-meta" lang="en">{code}</span> : null}
        </div>
        <h2 className="rp-title" lang="en">{programDisplayTitle(program.title, program.code)}</h2>
        <div className="rp-links">
          <ExternalLink href={program.sourceUrl}>{s.programPage}</ExternalLink>
          <button type="button" className="rp-link" onClick={() => actions.selectProgram(null)}>{s.clearProgram}</button>
        </div>
      </header>

      <section className="rp-sec rp-progress">
        <p className="rp-progress-label">
          <Readout template={progressTemplate} values={{ done: n(overall.done), total: n(overall.total) }} />
        </p>
        <div
          className="rp-bar"
          role="progressbar"
          aria-label={format(progressTemplate, { done: n(overall.done), total: n(overall.total) })}
          aria-valuemin={0}
          aria-valuemax={overall.total}
          aria-valuenow={overall.done}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        {/* The count includes every alternative and every pathway, so it is never a target. */}
        <p className="rp-muted rp-progress-note">{s.progressNote}</p>
      </section>

      <section className="rp-sec">
        <h3 className="rp-sec-title">{s.takeNext}</h3>
        {next.length ? (
          <ol className="rp-next">
            {next.map(item => <NextRow key={item.courseId} item={item} engine={engine} record={record} />)}
          </ol>
        ) : (
          <p className="rp-muted">{s.takeNextEmpty}</p>
        )}
      </section>

      {sections.map(section => section.groups.length ? <Category key={section.category} section={section} statusOf={statusOf} /> : null)}

      {official.length ? (
        <section className="rp-sec">
          <Disclosure open={officialOpen} onToggle={() => setOfficialOpen(open => !open)} summary={<span className="rp-sec-title">{s.officialText}</span>}>
            {official.map(block => (
              <div key={block.label} className="rp-official-block">
                <h4 className="rp-sublabel">{block.label}</h4>
                <OfficialText text={block.text} />
              </div>
            ))}
          </Disclosure>
        </section>
      ) : null}
      <SourceFooter />
    </article>
  )
}

function NextRow({ item, engine, record }: { item: NextCourse; engine: CourseEngine; record: ReadonlyMap<string, RecordEntry> }) {
  const s = useStrings(panelStrings)
  const { courses } = usePanelEnv()
  const reason = useMemo(() => {
    const unmet = item.reason === 'needs-prerequisites' || item.reason === 'needs-corequisites'
    return nextReason(item.reason, unmet ? attempt(() => engine.evaluateCourse(item.courseId, record)) : null, s)
  }, [item, engine, record, s])
  return (
    <li className="rp-next-row">
      <CourseChip id={item.courseId} relation="program" />
      <span className="rp-next-title" lang="en" title={courses.get(item.courseId)?.title}>{courses.get(item.courseId)?.title}</span>
      <span className={`rp-next-reason rp-next-${item.reason}`}>{reason}</span>
    </li>
  )
}

function Category({ section, statusOf }: { section: CategorySummary; statusOf: ReadonlyMap<string, Eligibility> }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const [expanded, setExpanded] = useState(false)
  const sections = useMemo(() => groupSections(section.groups), [section.groups])
  const { shown, rest } = capSections(sections, GROUP_LIMIT, expanded)
  const cards = sections.reduce((sum, block) => sum + block.items.length, 0)
  const headingId = useId()
  const n = (value: number) => formatNumber(value, lang)
  return (
    <section className="rp-sec" aria-labelledby={headingId}>
      <h3 className="rp-sec-title rp-sec-split" id={headingId}>
        <span>{section.category === 'admission' ? s.admission : s.completion}</span>
        <span className="rp-sec-meta">
          {section.tally.total
            ? (
              <Readout
                template={plural(section.tally.total, s.categoryProgressOne, s.categoryProgressMany)}
                values={{ done: n(section.tally.done), total: n(section.tally.total) }}
              />
            )
            : s.categoryNoCourses}
        </span>
      </h3>
      {shown.map(block => (
        <div key={`${block.key}|${block.items[0]?.id ?? ''}`} className="rp-group-section">
          {block.heading ? <h4 className="rp-group-heading" lang="en">{block.heading}</h4> : null}
          {block.items.length ? (
            <ul className="rp-cards">
              {block.items.map(group => <GroupCard key={group.id} group={group} status={statusOf.get(group.id) ?? null} />)}
            </ul>
          ) : null}
        </div>
      ))}
      {rest || expanded ? (
        <button type="button" className="rp-link rp-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? s.showLess : format(s.showAllGroups, { n: n(cards) })}
        </button>
      ) : null}
    </section>
  )
}

const STATE_LABEL: Record<Eligibility, keyof PanelStrings> = { met: 'statusMet', unmet: 'statusUnmet', unknown: 'statusUnknown' }
const STATE_TITLE: Record<Eligibility, keyof PanelStrings> = { met: 'statusMetLong', unmet: 'statusUnmetLong', unknown: 'statusUnknownLong' }

function GroupCard({ group, status }: { group: ProgramGroupLite; status: Eligibility | null }) {
  const s = useStrings(panelStrings)
  const [open, setOpen] = useState(false)
  const textId = useId()
  const clampRef = useRef<HTMLSpanElement>(null)
  // "Show more" only when the 4-line clamp actually hides text at the current panel width.
  const overflowing = useOverflow(clampRef, !open, group.text)
  const mentioned = group.mentioned ?? []
  const unresolved = group.unresolved ?? []
  // The label is the section heading above the card; only an item number stays on the card.
  const number = groupNumber(group)
  return (
    <li className="rp-group-card">
      <div className="rp-group-card-head">
        <span className="rp-group-card-label">{number !== null ? `${number}.` : ''}</span>
        {status ? (
          <span className={`rp-state rp-state-${status}`} title={s[STATE_TITLE[status]]}>
            <StatusSvg status={status} />
            {s[STATE_LABEL[status]]}
          </span>
        ) : null}
      </div>
      <OfficialText text={group.text} clamp={!open} clampRef={clampRef} id={textId} />
      {open || overflowing ? (
        <button type="button" className="rp-link rp-more" aria-expanded={open} aria-controls={textId} onClick={() => setOpen(value => !value)}>
          {open ? s.showLess : s.showMore}
        </button>
      ) : null}
      {group.ids.length ? <ChipList ids={group.ids} relation={programRelation} /> : null}
      {mentioned.length ? (
        <div className="rp-group-extra">
          <p className="rp-sublabel" aria-hidden="true">{s.groupMentioned}</p>
          <ChipList ids={mentioned} label={s.groupMentioned} muted />
        </div>
      ) : null}
      {unresolved.length ? (
        <div className="rp-group-extra">
          <p className="rp-sublabel" aria-hidden="true">{s.notInCalendar}</p>
          <ChipList ids={unresolved} label={s.notInCalendar} />
        </div>
      ) : null}
    </li>
  )
}
