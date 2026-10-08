// Sticky lane column (design-spec 9.1): one element per visible lane with its division-tone bar,
// a clamped label block (division, name, meta) that falls back to a single line and then hides,
// the focus-row marker ▸ and a hover kebab menu (Jump / Make home / Show only / Hide).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { format, formatNumber } from '../../i18n'
import type { Lang } from '../../app/store'
import type { GraphStrings } from '../strings'
import { laneBulletInkVar, laneToneVar } from '../tokens'
import { laneTone } from '../topology'
import type { Geometry, Topology } from '../types'
import type { Counts } from './counts'
import { clamp, px, setShown, setTransform, useFrameLayout, type FrameBus, type FrameInfo } from './frame'

/** Label block metrics (CSS px; graph.css uses the same heights). */
const DIVISION_H = 17
const NAME_H = 17
const META_H = 19
const SINGLE_H = 18
const LABEL_TOP = 12
const LABEL_EDGE = 8
const HIDE_BELOW = 22

export type LaneAction = 'jump' | 'home' | 'only' | 'hide'

export interface LaneRow {
  lane: number
  subject: string
  name: string
  title: string
  /** Division label shown on this lane (null when another lane of the division carries it). */
  division: string | null
  /** First visible lane of a later division: the 1.5 px division rule above it. */
  divisionStart: boolean
  tone: 1 | 2
  meta: { text: string; needed?: string; unlocked?: string; neededN?: string; unlockedN?: string } | null
  slim: boolean
  blockH: number
}

export interface LaneColumnProps {
  bus: FrameBus
  topology: Topology
  geometry: Geometry
  counts: readonly Counts[]
  focus: number
  programActive: boolean
  strings: GraphStrings
  divisionLabels: Record<string, string>
  lang: Lang
  onAction(action: LaneAction, lane: number): void
}

export interface LaneRowInput {
  topology: Topology
  geometry: Geometry
  counts: readonly Counts[]
  focus: number
  programActive: boolean
  strings: GraphStrings
  divisionLabels: Record<string, string>
  lang: Lang
}

/**
 * One row per visible lane. Tones come from laneTone (static order, never recoloured by filters);
 * the division label sits on the lane geometry reserved it for (LaneBox.divisionLabel: the first
 * lane of its division that is neither collapsed nor slim); the strong rule marks the first visible
 * lane of each later division, as on the canvas.
 */
export function buildLaneRows({ topology, geometry, counts, focus, programActive, strings, divisionLabels, lang }: LaneRowInput): LaneRow[] {
  const out: LaneRow[] = []
  let lastDivision: string | null = null
  topology.lanes.forEach((lane, i) => {
    const box = geometry.lanes[i]
    if (!box || box.collapsed || box.h <= 0) return
    const divisionStart = lastDivision !== null && lane.division !== lastDivision
    lastDivision = lane.division
    const division = box.divisionLabel ? divisionLabels[lane.division] ?? lane.division : null
    const c = counts[i]
    let meta: LaneRow['meta']
    if (focus >= 0) {
      const neededN = formatNumber(c.needed, lang)
      const unlockedN = formatNumber(c.unlocked, lang)
      const needed = format(strings.countNeeded, { n: neededN })
      const unlocked = format(strings.countUnlocked, { n: unlockedN })
      meta = c.needed + c.unlocked > 0 || c.focus
        ? { text: `${needed}${strings.sep}${unlocked}`, needed, unlocked, neededN, unlockedN }
        : { text: strings.laneNone }
    } else if (programActive) {
      meta = { text: format(strings.laneInProgram, { n: formatNumber(c.program, lang) }) }
    } else if (c.visible < c.total) {
      meta = { text: format(strings.laneCoursesOf, { v: formatNumber(c.visible, lang), n: formatNumber(c.total, lang) }) }
    } else {
      meta = { text: c.total === 1 ? strings.laneCourse : format(strings.laneCourses, { n: formatNumber(c.total, lang) }) }
    }
    const title = lane.department
      ? format(strings.laneTitle, { name: lane.name, code: lane.subject, department: lane.department })
      : `${lane.name} (${lane.subject})`
    out.push({
      lane: i,
      subject: lane.subject,
      name: lane.name,
      title,
      division,
      divisionStart,
      tone: laneTone(topology, i),
      meta,
      slim: box.slim,
      blockH: (division ? DIVISION_H : 0) + NAME_H + META_H,
    })
  })
  return out
}

/**
 * Positions one lane row. The height is written whenever it differs, not only on frames whose zoom
 * or geometry changed: a lane that was off screen at that frame (skipped) would otherwise keep a
 * 0 px height (no lane bar, no hover area) after it scrolls into view.
 */
export function placeLane(el: HTMLElement, top: number, h: number): void {
  setTransform(el, 0, top)
  const height = px(h)
  if (el.style.height !== height) el.style.height = height
}

export function LaneColumn(props: LaneColumnProps) {
  const { bus, topology, geometry, counts, focus, programActive, strings, divisionLabels, lang, onAction } = props
  const laneEls = useRef(new Map<number, HTMLDivElement>())
  const labelEls = useRef(new Map<number, HTMLDivElement>())
  const kebabEls = useRef(new Map<number, HTMLButtonElement>())
  const markerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ lane: number; x: number; y: number } | null>(null)
  /** Lane whose kebab gets focus back when the menu closes by Escape or an action. */
  const restoreTo = useRef<number | null>(null)
  const measured = useRef(new Set<number>())

  const rows = useMemo<LaneRow[]>(
    () => buildLaneRows({ topology, geometry, counts, focus, programActive, strings, divisionLabels, lang }),
    [topology, geometry, counts, focus, programActive, strings, divisionLabels, lang],
  )

  useLayoutEffect(() => {
    measured.current.clear()
  }, [rows])

  const layout = useCallback((frame: FrameInfo) => {
    const { geometry: g, plot } = frame
    const plotH = plot.height
    for (const row of rows) {
      const el = laneEls.current.get(row.lane)
      const label = labelEls.current.get(row.lane)
      const box = g.lanes[row.lane]
      if (!el || !box) continue
      const top = frame.toY(box.y) - plot.top
      const h = box.h * frame.view.zoom
      const bottom = top + h
      const onScreen = bottom > 0 && top < plotH && h > 0.5
      setShown(el, onScreen)
      if (!onScreen) continue
      placeLane(el, top, h)
      if (!label) continue
      const visTop = Math.max(top, 0)
      const visBottom = Math.min(bottom, plotH)
      const visH = visBottom - visTop
      // A division label that does not fit is dropped before the block falls back to one line.
      const plainH = row.division ? row.blockH - DIVISION_H : row.blockH
      let mode: 'full' | 'plain' | 'single' | 'hidden'
      let labelTop: number
      if (visH < HIDE_BELOW) {
        mode = 'hidden'
        labelTop = 0
      } else if (!row.slim && row.division && visH < row.blockH + LABEL_EDGE && visH >= plainH + LABEL_EDGE) {
        mode = 'plain'
        labelTop = clamp(top + LABEL_TOP, LABEL_EDGE, bottom - plainH - LABEL_EDGE)
      } else if (row.slim || visH < row.blockH + LABEL_EDGE) {
        mode = 'single'
        labelTop = row.slim ? clamp(top + (h - SINGLE_H) / 2, visTop + 2, visBottom - SINGLE_H - 2) : clamp(top + LABEL_TOP, visTop + 2, visBottom - SINGLE_H - 2)
      } else {
        mode = 'full'
        labelTop = clamp(top + LABEL_TOP, LABEL_EDGE, bottom - row.blockH - LABEL_EDGE)
      }
      if (label.dataset.mode !== mode) label.dataset.mode = mode
      setTransform(label, 0, labelTop - top)
      // Counts that do not fit the 140 px line drop their words (the full text stays in `title`).
      if ((mode === 'full' || mode === 'plain') && row.meta?.needed !== undefined && !measured.current.has(row.lane)) {
        const meta = label.querySelector<HTMLElement>('.gc-lane-meta')
        const long = label.querySelector<HTMLElement>('.gc-counts-long')
        if (meta && long && meta.clientWidth > 0) {
          measured.current.add(row.lane)
          if (long.scrollWidth > meta.clientWidth) label.dataset.compact = 'true'
          else delete label.dataset.compact
        }
      }
    }
    const marker = markerRef.current
    if (marker) {
      const node = focus >= 0 ? g.nodes[focus] : undefined
      const lane = focus >= 0 ? g.lanes[topology.nodes[focus].lane] : undefined
      if (!node || !lane || node.cls === 'hidden') {
        setShown(marker, false)
      } else {
        const laneTop = frame.toY(lane.y) - plot.top
        const laneBottom = laneTop + lane.h * frame.view.zoom
        const y = clamp(frame.toY(node.cy) - plot.top, Math.max(laneTop, 0) + 4, Math.min(laneBottom, plotH) - 4)
        setShown(marker, laneBottom > 0 && laneTop < plotH)
        setTransform(marker, 0, y - 4)
      }
    }
  }, [rows, focus, topology])
  useFrameLayout(bus, layout)

  // Close the menu on outside clicks and on Escape (which hands focus back to the kebab).
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof PointerEvent && (event.target as Element | null)?.closest?.('.gc-lane-menu')) return
      if (event instanceof KeyboardEvent) event.stopPropagation()
      // A pointer press elsewhere moves focus itself; Escape and wheel would leave it on <body>.
      if (!(event instanceof PointerEvent) && menuRef.current?.contains(document.activeElement)) restoreTo.current = menu.lane
      setMenu(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close, true)
    window.addEventListener('wheel', close, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('wheel', close, true)
    }
  }, [menu])

  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (menu) {
      menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      return
    }
    // Closing unmounts the focused item: focus returns to the lane's kebab (or the graph region
    // when the lane is gone or off screen), never to <body>.
    const lane = restoreTo.current
    restoreTo.current = null
    if (lane === null) return
    const kebab = kebabEls.current.get(lane)
    if (kebab?.isConnected && kebab.getClientRects().length) kebab.focus({ preventScroll: true })
    else containerRef.current?.closest<HTMLElement>('.gc-root')?.focus({ preventScroll: true })
  }, [menu])

  const openMenu = (lane: number, button: HTMLElement) => {
    const host = containerRef.current?.parentElement
    if (!host) return
    const b = button.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    setMenu({ lane, x: b.right - h.left + 4, y: b.top - h.top })
  }

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopPropagation()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const run = (action: LaneAction) => {
    if (!menu) return
    restoreTo.current = menu.lane
    onAction(action, menu.lane)
    setMenu(null)
  }

  const menuLane = menu ? topology.lanes[menu.lane] : null
  return (
    <>
      <div className="gc-lanes" ref={containerRef}>
        {rows.map(row => (
          <div
            key={row.lane}
            className={`gc-lane${row.slim ? ' is-slim' : ''}${row.divisionStart ? ' is-division-start' : ''}`}
            ref={el => {
              if (el) laneEls.current.set(row.lane, el)
              else laneEls.current.delete(row.lane)
            }}
          >
            <span className="gc-lane-bar" style={{ background: laneToneVar(topology.lanes[row.lane].division, row.tone) }} />
            <div
              className="gc-lane-label"
              data-mode="full"
              data-counts={row.meta?.needed !== undefined ? 'true' : undefined}
              ref={el => {
                if (el) labelEls.current.set(row.lane, el)
                else labelEls.current.delete(row.lane)
              }}
            >
              {row.division && <div className="gc-lane-division">{row.division}</div>}
              <div className="gc-lane-head">
                <Bullet subject={row.subject} division={topology.lanes[row.lane].division} tone={row.tone} />
                <span className="gc-lane-name" title={row.title} lang="en">{row.name}</span>
              </div>
              <div className="gc-lane-meta">
                <Bullet subject={row.subject} division={topology.lanes[row.lane].division} tone={row.tone} />
                {row.meta?.needed !== undefined ? (
                  <>
                    <span className="gc-counts gc-counts-long">
                      <span className="gc-dot gc-dot-pre" />
                      {row.meta.needed}
                      <span className="gc-sep">·</span>
                      <span className="gc-dot gc-dot-unl" />
                      {row.meta.unlocked}
                    </span>
                    <span className="gc-counts gc-counts-short" title={row.meta.text}>
                      <span className="gc-dot gc-dot-pre" />
                      {row.meta.neededN}
                      <span className="gc-sep">·</span>
                      <span className="gc-dot gc-dot-unl" />
                      {row.meta.unlockedN}
                    </span>
                  </>
                ) : (
                  <span className="gc-counts">{row.meta?.text}</span>
                )}
              </div>
              <button
                type="button"
                className="gc-lane-kebab"
                ref={el => {
                  if (el) kebabEls.current.set(row.lane, el)
                  else kebabEls.current.delete(row.lane)
                }}
                aria-label={format(strings.laneMenu, { name: row.name })}
                aria-haspopup="menu"
                aria-expanded={menu?.lane === row.lane}
                onClick={event => openMenu(row.lane, event.currentTarget)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <circle cx="8" cy="3.5" r="1.4" />
                  <circle cx="8" cy="8" r="1.4" />
                  <circle cx="8" cy="12.5" r="1.4" />
                </svg>
              </button>
            </div>
          </div>
        ))}
        <div className="gc-lane-marker" ref={markerRef} aria-hidden="true" />
      </div>
      {menu && menuLane && (
        <div
          className="gc-lane-menu"
          role="menu"
          aria-label={format(strings.laneMenu, { name: menuLane.name })}
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onMenuKey}
        >
          <button type="button" role="menuitem" onClick={() => run('jump')}>{strings.laneJump}</button>
          <button type="button" role="menuitem" onClick={() => run('home')}>{strings.laneHome}</button>
          <button type="button" role="menuitem" onClick={() => run('only')}>{strings.laneOnly}</button>
          <button type="button" role="menuitem" onClick={() => run('hide')}>{strings.laneHide}</button>
        </div>
      )}
    </>
  )
}

export function Bullet({ subject, division, tone }: { subject: string; division: string; tone: 1 | 2 }) {
  return (
    <span className="gc-bullet" lang="en" style={{ background: laneToneVar(division, tone), color: laneBulletInkVar(tone) }}>
      {subject}
    </span>
  )
}
