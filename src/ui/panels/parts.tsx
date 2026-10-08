// Small building blocks shared by the three panels.
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import { actions, useApp } from '../../app/store'
import { format, useStrings } from '../../i18n'
import { PanelContext, usePanelEnv, type PanelEnv } from './context'
import { academicYearText, courseIndex, splitTemplate } from './format'
import { isOverflowing } from './programs'
import { cachedEligibility } from './record'
import { panelStrings } from './strings'
import type { PanelProps } from './types'

/**
 * Provides the panel environment from PanelProps (RightPanel does this once for all panels).
 * `onPick` runs before a chip selects a course, so the host can move focus to the new title.
 */
export function PanelEnvProvider({ props, onPick, children }: { props: PanelProps; onPick?(courseId: string): void; children: ReactNode }) {
  const record = useApp(state => state.record)
  const { campus, dataset, topology, engine } = props
  const eligibility = useMemo(() => {
    if (!record.size) return null
    try {
      return cachedEligibility(engine, record)
    } catch {
      // Without eligibility the chips simply omit the "available now" ring.
      return null
    }
  }, [engine, record])
  const env = useMemo<PanelEnv>(() => ({
    campus,
    dataset,
    topology,
    courses: courseIndex(dataset),
    record,
    eligibility,
    // The shell frames every selection that does not come from the map, so a pick only selects.
    pick(courseId) {
      onPick?.(courseId)
      actions.selectCourse(courseId)
    },
  }), [campus, dataset, topology, record, eligibility, onPick])
  return <PanelContext.Provider value={env}>{children}</PanelContext.Provider>
}

/** Official calendar wording, verbatim (always English); `clamp` limits it to 4 lines. */
export function OfficialText({ text, clamp = false, clampRef, id }: { text: string; clamp?: boolean; clampRef?: Ref<HTMLSpanElement>; id?: string }) {
  return (
    <p className="rp-official" lang="en" id={id}>
      {clamp ? <span ref={clampRef} className="rp-clamp">{text}</span> : text}
    </p>
  )
}

/**
 * Whether the clamped element hides part of its content, measured while `active` and again when
 * its box changes (panel width, tab shown). Keeps the last answer while inactive (expanded).
 */
export function useOverflow(ref: RefObject<HTMLElement | null>, active: boolean, content: string): boolean {
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || !element) return
    const measure = () => setOverflow(isOverflowing(element.scrollHeight, element.clientHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, active, content])
  return overflow
}

/** Renders a template with its values set in bold tabular numerals. */
export function Readout({ template, values }: { template: string; values: Record<string, string | number> }) {
  return (
    <>
      {splitTemplate(template, values).map((part, i) =>
        'key' in part ? <b key={i} className="rp-num">{part.value}</b> : <span key={i}>{part.text}</span>,
      )}
    </>
  )
}

/**
 * Renders a UI template with elements in its slots, so official wording inside a translated
 * sentence keeps `lang="en"` ("Delivered at {place}", "授课地点：{place}").
 */
export function Template({ template, slots, textClassName }: { template: string; slots: Record<string, ReactNode>; textClassName?: string }) {
  const keys = Object.fromEntries(Object.keys(slots).map(key => [key, '']))
  return (
    <>
      {splitTemplate(template, keys).map((part, i) =>
        'key' in part ? <span key={i}>{slots[part.key]}</span> : <span key={i} className={textClassName}>{part.text}</span>,
      )}
    </>
  )
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const s = useStrings(panelStrings)
  return (
    <a className="rp-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
      <span className="rp-sr"> {s.newTab}</span>
    </a>
  )
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rp-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} />)}
    </div>
  )
}

export function LoadError({ retry }: { retry(): void }) {
  const s = useStrings(panelStrings)
  return (
    <p className="rp-error" role="alert">
      {s.loadFailed}{' '}
      <button type="button" className="rp-link" onClick={retry}>{s.retry}</button>
    </p>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

/** Segmented control (role radiogroup) with arrow-key movement, design-spec 6.2 / 11.1. */
export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  options: readonly SegmentOption<T>[]
  value: T
  onChange(value: T): void
  label: string
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div className={className ? `rp-seg ${className}` : 'rp-seg'} role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={element => { refs.current[i] = element }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="rp-seg-btn"
          onClick={() => onChange(option.value)}
          onKeyDown={event => onKeyDown(event, i)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Disclosure button + region; the region stays in the DOM (hidden) when closed. */
export function Disclosure({ open, onToggle, summary, children, className }: {
  open: boolean
  onToggle(): void
  summary: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={className ? `rp-disclosure ${className}` : 'rp-disclosure'}>
      <button type="button" className="rp-disclosure-btn" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <svg className="rp-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
          <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary}
      </button>
      <div id={id} className="rp-disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  )
}

/** "Source: UTM Academic Calendar 2026–2027 ↗". */
export function SourceFooter() {
  const s = useStrings(panelStrings)
  const { dataset, campus } = usePanelEnv()
  return (
    <footer className="rp-footer">
      <ExternalLink href={dataset.sources.calendar || campus.calendarUrl}>
        {format(s.source, { campus: campus.shortName, year: academicYearText(dataset.academicYear) })}
      </ExternalLink>
    </footer>
  )
}

