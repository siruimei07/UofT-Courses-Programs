// Code chip (design-spec 6.7.1) with the record glyph of 7.2: shape encodes the student record,
// colour encodes the relation to the selected course. Other-campus and unresolved references
// render as plain, non-clickable chips.
import type { ReactNode } from 'react'
import type { Eligibility, RecordStatus } from '../../graph/types'
import { format, useStrings } from '../../i18n'
import { usePanelEnv } from './context'
import { academicYearText, campusOf, codeOf } from './format'
import { panelStrings, type PanelStrings } from './strings'
import type { Relation } from './summary'

const TRANSITIVE: ReadonlySet<Relation> = new Set(['prereq', 'unlock'])

/** 12 × 12 glyph: disc (not taken), check square (completed), half disc (in progress), dashed ring (planned). */
export function RecordGlyph({ status, relation = 'none', available = false, size = 12 }: {
  status: RecordStatus | null
  relation?: Relation
  /** "Available now": not taken and eligible; adds the outer ring (7.2). */
  available?: boolean
  size?: number
}) {
  const hollow = TRANSITIVE.has(relation)
  return (
    <svg className={`rp-glyph rp-rel-${relation}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {available && !status ? <circle className="rp-glyph-ring" cx="6" cy="6" r="5.25" fill="none" strokeWidth="1.25" /> : null}
      {status === 'completed' ? (
        <>
          <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" />
          <path className="rp-glyph-cut" d="M3.6 6.1 5.3 7.8 8.5 4.4" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : status === 'inProgress' ? (
        <>
          <circle cx="6" cy="6" r="4.25" className="rp-glyph-hole" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75 A4.25 4.25 0 0 0 6 10.25 Z" fill="currentColor" />
        </>
      ) : status === 'planned' ? (
        <>
          <circle cx="6" cy="6" r="4.25" className="rp-glyph-hole" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.5" />
          <circle cx="6" cy="6" r="1.5" fill="currentColor" />
        </>
      ) : hollow ? (
        <circle cx="6" cy="6" r={available ? 2.5 : 3} className="rp-glyph-hole" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <circle cx="6" cy="6" r={available ? 2.75 : 3.25} fill="currentColor" />
      )}
    </svg>
  )
}

const STATUS_LABEL: Record<Eligibility, keyof PanelStrings> = { met: 'statusMetLong', unmet: 'statusUnmetLong', unknown: 'statusUnknownLong' }

/** Check, cross or question mark in currentColor. */
export function StatusSvg({ status }: { status: Eligibility }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {status === 'met' ? (
        <path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : status === 'unmet' ? (
        <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M4.3 4.5a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M6 9.4v.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  )
}

/** Met (check, --ready), unmet (cross, ink-3) or unknown (question mark, ink-3). */
export function StatusIcon({ status }: { status: Eligibility }) {
  const s = useStrings(panelStrings)
  return (
    <span className={`rp-status rp-status-${status}`} title={s[STATUS_LABEL[status]]}>
      <StatusSvg status={status} />
      <span className="rp-sr">{s[STATUS_LABEL[status]]}</span>
    </span>
  )
}

export const RECORD_LABEL: Record<RecordStatus, keyof PanelStrings> = { completed: 'completed', inProgress: 'inProgress', planned: 'planned' }

export function campusName(campus: string, s: PanelStrings): string {
  if (campus === 'UTSG') return s.campusUTSG
  if (campus === 'UTSC') return s.campusUTSC
  if (campus === 'UTM') return s.campusUTM
  return campus
}

export interface CourseChipProps {
  id: string
  relation?: Relation
  /** Eligibility icon; shown only when the student record is not empty. */
  status?: Eligibility | null
  /** Extra text after the code, e.g. "with ≥ 60 %". */
  suffix?: ReactNode
  /** Codes a text only mentions (program groups): quieter chip, never counted. */
  muted?: boolean
}

export function CourseChip({ id, relation = 'none', status = null, suffix, muted = false }: CourseChipProps) {
  const s = useStrings(panelStrings)
  const { dataset, courses, record, eligibility, pick } = usePanelEnv()
  const code = codeOf(id)
  const course = courses.get(id)
  const showStatus = status !== null && record.size > 0
  if (!course) {
    const campus = campusOf(id)
    const external = campus !== '' && campus !== dataset.campus
    const tip = external
      ? format(s.otherCampusTip, { code, campus: campusName(campus, s) })
      : format(s.notInCalendarTip, { code, year: academicYearText(dataset.academicYear), campus: dataset.campus })
    return (
      <span className={`rp-chip ${external ? 'rp-chip-ext' : 'rp-chip-missing'}`} title={tip}>
        <span lang="en">{code}</span>
        {external ? <span className="rp-chip-campus">{campusName(campus, s)}</span> : null}
        {suffix ? <span className="rp-chip-suffix">{suffix}</span> : null}
        {showStatus ? <StatusIcon status={status} /> : null}
        <span className="rp-sr">{s.srSep}{tip}</span>
      </span>
    )
  }
  const recordStatus = record.get(id)?.status ?? null
  const available = !recordStatus && eligibility?.get(id) === 'met'
  // The title tooltip is also the accessible description, so the name carries only code and state.
  return (
    <button type="button" className={muted ? 'rp-chip rp-chip-muted' : 'rp-chip'} title={course.title} onClick={() => pick(id)}>
      <RecordGlyph status={recordStatus} relation={relation} available={available} />
      <span lang="en">{code}</span>
      {recordStatus ? <span className="rp-sr">{s.srSep}{s[RECORD_LABEL[recordStatus]]}</span> : null}
      {available ? <span className="rp-sr">{s.srSep}{s.availableNow}</span> : null}
      {suffix ? <span className="rp-chip-suffix">{suffix}</span> : null}
      {showStatus ? <StatusIcon status={status} /> : null}
    </button>
  )
}

/** Wrapping row of chips. */
export function ChipList({ ids, relation, label, muted }: { ids: readonly string[]; relation?: (id: string) => Relation; label?: string; muted?: boolean }) {
  return (
    <ul className="rp-chips" aria-label={label}>
      {ids.map(id => (
        <li key={id}>
          <CourseChip id={id} relation={relation?.(id)} muted={muted} />
        </li>
      ))}
    </ul>
  )
}
