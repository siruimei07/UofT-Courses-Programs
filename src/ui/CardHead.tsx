// Graph card head row (design-spec 6.3): title, meta, then the hint, the first-visit start strip,
// the selected-course context strip with the plain-language readout, or the program context.
import type { ReactNode } from 'react'
import type { CoreqReadout, NeedsReadout, Readout, UnlocksReadout } from '../app/readout'
import { useApp, type Lang } from '../app/store'
import type { Breakpoint } from '../app/useBreakpoint'
import type { ProgramsStatus } from '../app/usePrograms'
import type { GraphCourse } from '../data/schema'
import { useStrings } from '../i18n'
import { ProgramsNote } from './ProgramsNote'
import { richNumbers } from './rich'
import { cardStrings } from './strings'

type CardText = (typeof cardStrings)['en']

export type CardMeta =
  | { kind: 'all'; subjects: number; courses: number }
  | { kind: 'filtered'; shown: number; courses: number }
  /** Hide unrelated: lanes with nothing on the path collapse and the meta reports it (19.4). */
  | { kind: 'subjects'; shown: number; total: number }

/** Program mode without a selected course: the program, or programs.json still on its way. */
export type ProgramContext =
  | { kind: 'ready'; title: string; courses: number }
  | { kind: 'waiting'; status: Exclude<ProgramsStatus, 'ready'>; onRetry(): void }

interface CardHeadProps {
  breakpoint: Breakpoint
  meta: CardMeta
  /** Selected course and its readout. */
  focus: { course: GraphCourse; readout: Readout } | null
  /** Program mode without a selected course. */
  program: ProgramContext | null
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

function coreqText(t: CardText, coreqs: CoreqReadout, lang: Lang): ReactNode {
  switch (coreqs.kind) {
    case 'none': return null
    case 'plain': return coreqs.count === 1 ? t.coreqOne : richNumbers(t.coreqMany, { n: coreqs.count }, lang)
    case 'oneOf': return richNumbers(t.coreqOneOf, { n: coreqs.of }, lang)
    case 'alternatives': return richNumbers(t.coreqAlternatives, { n: coreqs.count }, lang)
    case 'unknown': return coreqs.count === 1 ? t.coreqUnknownOne : richNumbers(t.coreqUnknownMany, { n: coreqs.count }, lang)
  }
}

function unlocksText(t: CardText, unlocks: UnlocksReadout, lang: Lang): ReactNode {
  return unlocks.kind === 'none' ? t.unlocksNone : richNumbers(t.unlocks, { d: unlocks.direct, t: unlocks.total }, lang)
}

function MetaText({ meta, short, program, t, lang }: { meta: CardMeta; short: boolean; program: boolean; t: CardText; lang: Lang }) {
  switch (meta.kind) {
    case 'all': return <>{richNumbers(t.metaAll, { s: meta.subjects, n: meta.courses }, lang, 'num-plain')}</>
    case 'filtered': return <>{richNumbers(t.metaFiltered, { shown: meta.shown, n: meta.courses }, lang, 'num-plain')}</>
    case 'subjects': {
      const values = { shown: meta.shown, total: meta.total, empty: meta.total - meta.shown }
      // Program mode hides lanes without a program course: there is no "path" to speak of.
      return <>{richNumbers(short ? t.metaSubjectsShort : program ? t.metaSubjectsProgram : t.metaSubjects, values, lang, 'num-plain')}</>
    }
  }
}

/**
 * Standard and compact frames trade the meta for the readout while a course is selected, and for
 * the start strip on a first visit (6.3). The collapsed-lane count of Hide unrelated (19.4) stays
 * during a selection, in its short form.
 */
export function metaVisibility(breakpoint: Breakpoint, meta: CardMeta, focused: boolean, starting: boolean): 'full' | 'short' | 'hidden' {
  if (breakpoint === 'wide') return 'full'
  if (starting) return 'hidden'
  if (!focused) return 'full'
  return meta.kind === 'subjects' ? 'short' : 'hidden'
}

export function CardHead({ breakpoint, meta, focus, program, start, onDetails, onClear, onClearProgram }: CardHeadProps) {
  const t = useStrings(cardStrings)
  const lang = useApp(state => state.lang)
  const panelCollapsed = useApp(state => state.panelCollapsed)
  const metaShown = metaVisibility(breakpoint, meta, focus !== null, start !== null && !focus && !program)
  const coreqs = focus ? coreqText(t, focus.readout.coreqs, lang) : null

  return (
    <div className="card-head">
      <h2 className="card-title" id="card-title">{t.title}</h2>
      {metaShown !== 'hidden' && <span className="card-meta"><MetaText meta={meta} short={metaShown === 'short'} program={!focus && program !== null} t={t} lang={lang} /></span>}
      {focus ? (
        <div className="context-strip" aria-label={t.selected} role="group">
          <span className="code-plate" lang="en">{focus.course.code}</span>
          <span className="context-title" lang="en" title={focus.course.title}>{focus.course.title}</span>
          <span className="readout readout-needs">
            <span className="readout-dot" aria-hidden="true" />
            <span>{needsText(t, focus.readout.needs, lang)}{coreqs && <> {coreqs}</>}</span>
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
          {program.kind === 'ready' ? (
            <>
              <span className="readout readout-program">
                <span className="readout-dot" aria-hidden="true" />
                <span className="context-title program-name" lang="en" title={program.title}>{program.title}</span>
              </span>
              <span className="readout"><span>{richNumbers(t.programCourses, { n: program.courses }, lang)}</span></span>
            </>
          ) : (
            <span className="readout readout-program">
              <span className="readout-dot" aria-hidden="true" />
              <ProgramsNote status={program.status} onRetry={program.onRetry} />
            </span>
          )}
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
