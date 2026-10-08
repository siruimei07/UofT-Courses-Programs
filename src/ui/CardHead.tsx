// Graph card head row (design-spec 6.3): title, meta, then the hint, the first-visit start strip,
// the selected-course context strip with the plain-language readout, or the program context.
import type { ReactNode } from 'react'
import type { NeedsReadout, Readout, UnlocksReadout } from '../app/readout'
import { useApp, type Lang } from '../app/store'
import type { Breakpoint } from '../app/useBreakpoint'
import type { GraphCourse } from '../data/schema'
import { useStrings } from '../i18n'
import { richNumbers } from './rich'
import { cardStrings } from './strings'

type CardText = (typeof cardStrings)['en']

export type CardMeta =
  | { kind: 'all'; subjects: number; courses: number }
  | { kind: 'filtered'; shown: number; courses: number }
  | { kind: 'subjects'; shown: number; total: number }

interface CardHeadProps {
  breakpoint: Breakpoint
  meta: CardMeta
  /** Selected course and its readout. */
  focus: { course: GraphCourse; readout: Readout } | null
  /** Program mode without a selected course. */
  program: { title: string; courses: number } | null
  /** First-visit start strip (replaces the hint). */
  start: ReactNode | null
  onDetails(): void
  onClear(): void
  onClearProgram(): void
}

function needsText(t: CardText, needs: NeedsReadout, lang: Lang): ReactNode {
  switch (needs.kind) {
    case 'none': return t.needsNone
    case 'offMap': return t.needsOffMap
    case 'plain': return richNumbers(t.needs, { d: needs.direct, t: needs.total }, lang)
    case 'oneOf': return richNumbers(t.needsOneOf, { n: needs.of, t: needs.total }, lang)
    case 'alternatives': return richNumbers(t.needsAlternatives, { d: needs.direct, t: needs.total }, lang)
    case 'unknown': return richNumbers(t.needsUnknown, { d: needs.direct, t: needs.total }, lang)
  }
}

function unlocksText(t: CardText, unlocks: UnlocksReadout, lang: Lang): ReactNode {
  return unlocks.kind === 'none' ? t.unlocksNone : richNumbers(t.unlocks, { d: unlocks.direct, t: unlocks.total }, lang)
}

function MetaText({ meta, t, lang }: { meta: CardMeta; t: CardText; lang: Lang }) {
  switch (meta.kind) {
    case 'all': return <>{richNumbers(t.metaAll, { s: meta.subjects, n: meta.courses }, lang, 'num-plain')}</>
    case 'filtered': return <>{richNumbers(t.metaFiltered, { shown: meta.shown, n: meta.courses }, lang, 'num-plain')}</>
    case 'subjects': return <>{richNumbers(t.metaSubjects, { shown: meta.shown, total: meta.total, empty: meta.total - meta.shown }, lang, 'num-plain')}</>
  }
}

export function CardHead({ breakpoint, meta, focus, program, start, onDetails, onClear, onClearProgram }: CardHeadProps) {
  const t = useStrings(cardStrings)
  const lang = useApp(state => state.lang)
  const panelCollapsed = useApp(state => state.panelCollapsed)
  // Standard and compact frames trade the meta for the readout while a course is selected.
  const showMeta = !(focus && breakpoint !== 'wide') && !(start && breakpoint !== 'wide')

  return (
    <div className="card-head">
      <h2 className="card-title" id="card-title">{t.title}</h2>
      {showMeta && <span className="card-meta"><MetaText meta={meta} t={t} lang={lang} /></span>}
      {focus ? (
        <div className="context-strip" aria-label={t.selected} role="group">
          <span className="code-plate" lang="en">{focus.course.code}</span>
          <span className="context-title" lang="en" title={focus.course.title}>{focus.course.title}</span>
          <span className="readout readout-needs">
            <span className="readout-dot" aria-hidden="true" />
            <span>{needsText(t, focus.readout.needs, lang)}</span>
          </span>
          <span className="readout readout-unlocks">
            <span className="readout-dot" aria-hidden="true" />
            <span>{unlocksText(t, focus.readout.unlocks, lang)}</span>
          </span>
          {focus.readout.hiddenByFilters > 0 && (
            <span className="readout-hidden">{richNumbers(t.hiddenByFilters, { n: focus.readout.hiddenByFilters }, lang, 'num-plain')}</span>
          )}
          <span className="context-actions">
            {panelCollapsed && <button type="button" className="btn btn-small" title={t.detailsTitle} onClick={onDetails}>{t.details}</button>}
            <button type="button" className="btn btn-small" title={t.clearTitle} aria-keyshortcuts="Escape" onClick={onClear}>{t.clear}</button>
          </span>
        </div>
      ) : program ? (
        <div className="context-strip" role="group" aria-label={t.programLabel}>
          <span className="readout readout-program">
            <span className="readout-dot" aria-hidden="true" />
            <span className="context-title program-name" lang="en" title={program.title}>{program.title}</span>
          </span>
          <span className="readout">{richNumbers(t.programCourses, { n: program.courses }, lang)}</span>
          <span className="context-actions">
            <button type="button" className="btn btn-small" title={t.clearProgramTitle} onClick={onClearProgram}>{t.clear}</button>
          </span>
        </div>
      ) : start ? (
        start
      ) : (
        <span className="card-hint" title={t.hint}>{t.hint}</span>
      )}
    </div>
  )
}

/** Card meta (6.3): all courses, filtered courses, or subjects left in "Hide unrelated" mode. */
export function cardMeta(input: {
  subjects: number
  courses: number
  shownCourses: number
  shownSubjects: number
  filtered: boolean
  collapsing: boolean
}): CardMeta {
  if (input.collapsing) return { kind: 'subjects', shown: input.shownSubjects, total: input.subjects }
  if (input.filtered) return { kind: 'filtered', shown: input.shownCourses, courses: input.courses }
  return { kind: 'all', subjects: input.subjects, courses: input.courses }
}
