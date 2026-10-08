// Graph card toolbar (design-spec 6.4): level chips with counts, the subject picker, the map
// toggles (inline in the wide frame, in a View menu otherwise) and the zoom group.
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { actions, useApp, type Store } from '../app/store'
import type { Breakpoint } from '../app/useBreakpoint'
import type { Division, SubjectInfo } from '../data/schema'
import type { Topology } from '../graph/types'
import { format, formatNumber, useStrings } from '../i18n'
import { CheckIcon, ChevronDownIcon } from './icons'
import { toolbarStrings } from './strings'
import { SubjectPicker } from './SubjectPicker'
import type { SubjectTone } from './SubjectBullet'
import type { Popover } from './usePopover'
import { ViewMenu } from './ViewMenu'
import { ZoomControls } from './ZoomControls'

export const LEVELS = [100, 200, 300, 400] as const

/** Current zoom, reported by GraphCanvas on every change. */
export type ZoomSource = Store<{ zoom: number }>

export interface ToggleSpec {
  key: string
  label: string
  title: string
  pressed: boolean
  disabled: boolean
  disabledTitle?: string
  onToggle(): void
}

interface ToolbarProps {
  breakpoint: Breakpoint
  topology: Topology
  subjects: readonly SubjectInfo[]
  divisions: readonly Division[]
  tones: ReadonlyMap<string, SubjectTone>
  /** Courses per level group under the current subject filter. */
  levelCounts: ReadonlyMap<number, number>
  subjectPicker: Popover
  hasFocus: boolean
  programActive: boolean
  zoom: ZoomSource
  onJumpSubject(subject: string): void
  onZoomIn(): void
  onZoomOut(): void
  onZoomReset(): void
  onFit(): void
}

/** Level chip click (6.4): solo a level; Ctrl/Shift + click adds or removes it; empty means All. */
export function nextLevels(current: ReadonlySet<number> | null, level: number, additive: boolean): ReadonlySet<number> | null {
  if (!additive) return current?.size === 1 && current.has(level) ? null : new Set([level])
  const next = new Set(current ?? [])
  if (next.has(level)) next.delete(level)
  else next.add(level)
  return next.size ? next : null
}

export function useToggles(hasFocus: boolean, programActive: boolean): ToggleSpec[] {
  const t = useStrings(toolbarStrings)
  const depth = useApp(state => state.depth)
  const hideUnrelated = useApp(state => state.hideUnrelated)
  const showAllEdges = useApp(state => state.showAllEdges)
  const hideCompleted = useApp(state => state.hideCompleted)
  const titles = useApp(state => state.titles)
  const recordEmpty = useApp(state => state.record.size === 0)
  return [
    {
      key: 'hideUnrelated', label: t.hideUnrelated, title: t.hideUnrelatedTitle, pressed: hideUnrelated,
      disabled: !hasFocus && !programActive, disabledTitle: t.hideUnrelatedDisabled, onToggle: () => actions.toggle('hideUnrelated'),
    },
    {
      key: 'directOnly', label: t.directOnly, title: t.directOnlyTitle, pressed: depth === 'direct', disabled: false,
      onToggle: () => actions.setDepth(depth === 'direct' ? 'all' : 'direct'),
    },
    { key: 'showAll', label: t.showAll, title: t.showAllTitle, pressed: showAllEdges, disabled: false, onToggle: () => actions.toggle('showAllEdges') },
    {
      key: 'hideCompleted', label: t.hideCompleted, title: t.hideCompletedTitle, pressed: hideCompleted,
      disabled: recordEmpty, disabledTitle: t.hideCompletedDisabled, onToggle: () => actions.toggle('hideCompleted'),
    },
    { key: 'titles', label: t.titles, title: t.titlesTitle, pressed: titles, disabled: false, onToggle: () => actions.toggle('titles') },
  ]
}

/**
 * Toggles sit inline in the wide frame (6.4) as long as they fit next to the other controls (a
 * 1700 px window with the panel open has no room); otherwise they move into the View menu. The
 * check re-runs when the bar or any of its controls changes size ("Subjects: 12 of 70", level
 * counts, a language switch), not only on window resizes.
 */
function useInlineToggles(wide: boolean, lang: string) {
  const barRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const [fits, setFits] = useState(wide)

  useLayoutEffect(() => {
    const bar = barRef.current
    const probe = probeRef.current
    if (!wide || !bar || !probe) {
      setFits(false)
      return
    }
    const compute = () => {
      const style = getComputedStyle(bar)
      const gap = parseFloat(style.columnGap) || 0
      let used = 0
      for (const child of bar.children) {
        if (child === probe || child === slotRef.current || child.classList.contains('tb-spacer')) continue
        const margins = getComputedStyle(child)
        used += child.getBoundingClientRect().width + parseFloat(margins.marginLeft) + parseFloat(margins.marginRight) + gap
      }
      const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setFits(used + probe.getBoundingClientRect().width + gap <= available)
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(bar)
    // The slot and the spacer are left out: their sizes follow the decision itself.
    for (const child of bar.children) {
      if (child !== slotRef.current && !child.classList.contains('tb-spacer')) observer.observe(child)
    }
    return () => observer.disconnect()
  }, [wide, lang])

  return { fits: wide && fits, barRef, slotRef, probeRef }
}

function ToggleChip({ toggle }: { toggle: ToggleSpec }) {
  return (
    <button type="button" className="chip chip-toggle" aria-pressed={toggle.pressed} aria-disabled={toggle.disabled || undefined}
      title={toggle.disabled ? toggle.disabledTitle : toggle.title}
      onClick={() => { if (!toggle.disabled) toggle.onToggle() }}>
      <span className="toggle-glyph" aria-hidden="true">{toggle.pressed ? <CheckIcon size={12} /> : null}</span>
      {toggle.label}
    </button>
  )
}

export function Toolbar(props: ToolbarProps) {
  const { breakpoint, levelCounts, subjectPicker, hasFocus, programActive } = props
  const t = useStrings(toolbarStrings)
  const lang = useApp(state => state.lang)
  const levels = useApp(state => state.levels)
  const visibleSubjects = useApp(state => state.subjects)
  const toggles = useToggles(hasFocus, programActive)
  const total = props.topology.lanes.length
  const inline = useInlineToggles(breakpoint === 'wide', lang)

  const onLevel = (level: number, event: MouseEvent) => {
    actions.setLevels(nextLevels(levels, level, event.ctrlKey || event.shiftKey || event.metaKey))
  }

  return (
    <div className="toolbar" role="group" aria-label={t.label} ref={inline.barRef}>
      <span className="tb-label" id="level-label">{t.level}</span>
      <div className="tb-group" role="group" aria-labelledby="level-label">
        <button type="button" className="chip" aria-pressed={levels === null} onClick={() => actions.setLevels(null)}>{t.all}</button>
        {LEVELS.map(level => {
          const count = levelCounts.get(level) ?? 0
          return (
            <button key={level} type="button" className="chip chip-level" aria-pressed={levels?.has(level) ?? false} title={t.levelTitle}
              aria-label={`${level}, ${format(t.levelCount, { n: formatNumber(count, lang) })}`} onClick={event => onLevel(level, event)}>
              {level}
              <span className="chip-count">{formatNumber(count, lang)}</span>
            </button>
          )
        })}
      </div>
      <span className="tb-divider" aria-hidden="true" />
      <div className="menu-root" ref={subjectPicker.rootRef}>
        <button ref={subjectPicker.triggerRef} type="button" className="chip chip-menu" aria-haspopup="dialog"
          aria-expanded={subjectPicker.open} onClick={subjectPicker.toggle}>
          {visibleSubjects === null ? t.subjectsAll : format(t.subjectsSome, { n: formatNumber(visibleSubjects.size, lang), total: formatNumber(total, lang) })}
          <ChevronDownIcon size={14} />
        </button>
        {subjectPicker.open && (
          <SubjectPicker topology={props.topology} subjects={props.subjects} divisions={props.divisions} tones={props.tones}
            onJump={subject => { subjectPicker.close(); props.onJumpSubject(subject) }} />
        )}
      </div>
      <span className="tb-divider" aria-hidden="true" />
      <div className="tb-slot" ref={inline.slotRef}>
        {inline.fits
          ? <div className="tb-group" role="group" aria-label={t.view}>{toggles.map(toggle => <ToggleChip key={toggle.key} toggle={toggle} />)}</div>
          : <ViewMenu toggles={toggles} />}
      </div>
      {breakpoint === 'wide' && (
        <div className="tb-group tb-probe" ref={inline.probeRef} aria-hidden="true">
          {toggles.map(toggle => (
            <span key={toggle.key} className="chip chip-toggle" aria-pressed={toggle.pressed}><span className="toggle-glyph" />{toggle.label}</span>
          ))}
        </div>
      )}
      <span className="tb-spacer" />
      <ZoomControls zoom={props.zoom} onZoomIn={props.onZoomIn} onZoomOut={props.onZoomOut} onReset={props.onZoomReset} onFit={props.onFit} />
    </div>
  )
}
