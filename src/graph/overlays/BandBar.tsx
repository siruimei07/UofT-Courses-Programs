// Sticky band bar (design-spec 9.2): band washes, clamped "100 level" labels with a short form,
// the scale bar (one segment per visible sub-column, notches at wrapped tracks) and the focus
// column marker ▾.
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { Lang } from '../../app/store'
import { format, formatNumber } from '../../i18n'
import type { GraphStrings } from '../strings'
import type { Geometry, Topology } from '../types'
import type { BandCounts } from './counts'
import { clamp, px, setShown, setTransform, useFrameLayout, type FrameBus, type FrameInfo } from './frame'

const LABEL_INSET = 14
const LABEL_RIGHT = 10
const SHORT_SLACK = 20
const HIDE_BELOW = 40
const SEGMENT_OVERHANG = 4
const MARKER_HALF = 4
/** Used when a label cannot be measured yet (not laid out). */
const DEFAULT_WIDTH = { full: 200, short: 90, title: 30 }

interface BandRow {
  band: number
  odd: boolean
  title: string
  short: string
  year: string
  meta: { text: string; needed?: string; unlocked?: string }
}

interface Segment {
  col: number
  filled: boolean
  mini: boolean
  notches: number[]
}

export interface BandBarProps {
  bus: FrameBus
  topology: Topology
  geometry: Geometry
  counts: readonly BandCounts[]
  focus: number
  programActive: boolean
  strings: GraphStrings
  lang: Lang
  originX: number
  trackGap: number
}

function yearLabel(strings: GraphStrings, index: number, level: number): string {
  const years = [strings.year1, strings.year2, strings.year3, strings.year4]
  return years[index] ?? format(strings.yearN, { level })
}

export function BandBar(props: BandBarProps) {
  const { bus, topology, geometry, counts, focus, programActive, strings, lang, originX, trackGap } = props
  const layerRef = useRef<HTMLDivElement>(null)
  const bandEls = useRef(new Map<number, HTMLDivElement>())
  const labelEls = useRef(new Map<number, HTMLDivElement>())
  const segmentEls = useRef(new Map<number, HTMLDivElement>())
  const markerRef = useRef<HTMLDivElement>(null)
  const widths = useRef(new Map<number, { full: number; short: number; title: number }>())

  const rows = useMemo<BandRow[]>(() => topology.bands.flatMap((band, b): BandRow[] => {
    if (!geometry.bands[b]?.visible) return []
    const c = counts[b]
    const n = (value: number) => formatNumber(value, lang)
    let meta: BandRow['meta']
    if (focus >= 0) {
      meta = { text: '', needed: format(strings.countNeeded, { n: n(c.needed) }), unlocked: format(strings.countUnlocked, { n: n(c.unlocked) }) }
    } else if (programActive) {
      meta = { text: format(strings.bandInProgram, { n: n(c.program) }) }
    } else {
      const courses = c.visible < c.total ? format(strings.bandCoursesOf, { v: n(c.visible), n: n(c.total) }) : format(strings.bandCourses, { n: n(c.total) })
      const columns = c.columns === 1 ? strings.bandColumn : format(strings.bandColumns, { n: n(c.columns) })
      meta = { text: `${courses}${strings.sep}${columns}` }
    }
    return [{
      band: b,
      odd: (band.index & 1) === 1,
      title: format(strings.bandTitle, { level: band.level }),
      short: format(strings.bandShort, { level: band.level }),
      year: yearLabel(strings, band.index, band.level),
      meta,
    }]
  }), [topology, geometry, counts, focus, programActive, strings, lang])

  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = []
    for (const band of topology.bands) {
      let k = 0
      for (let col = band.startCol; col <= band.endCol; col++) {
        const box = geometry.columns[col]
        if (!box || box.w <= 0) continue
        const notches: number[] = []
        for (let t = 1; t < box.tracks; t++) notches.push(t * (box.trackW + trackGap) - trackGap / 2)
        out.push({ col, filled: box.kind === 'labelled' && k % 2 === 0, mini: box.kind === 'mini', notches })
        k++
      }
    }
    return out
  }, [topology, geometry, trackGap])

  // Label forms are measured lazily, while displayed (a hidden label measures 0).
  useLayoutEffect(() => {
    widths.current.clear()
  }, [rows])

  const measure = (band: number, el: HTMLElement) => {
    const known = widths.current.get(band)
    if (known) return known
    setShown(el, true)
    const full = el.querySelector<HTMLElement>('.gc-band-long')?.scrollWidth ?? 0
    const short = el.querySelector<HTMLElement>('.gc-band-short')?.scrollWidth ?? 0
    const title = el.querySelector<HTMLElement>('.gc-band-short .gc-band-title')?.scrollWidth ?? 0
    if (!full || !short || !title) return DEFAULT_WIDTH
    const measured = { full, short, title }
    widths.current.set(band, measured)
    return measured
  }

  const layout = useCallback((frame: FrameInfo) => {
    const { geometry: g, plot, view } = frame
    const z = view.zoom
    const layerX = frame.toX(originX) - plot.left
    setTransform(layerRef.current, layerX, 0)
    if (frame.scaleChanged) {
      for (const row of rows) {
        const el = bandEls.current.get(row.band)
        const box = g.bands[row.band]
        if (!el || !box) continue
        el.style.left = px((box.x - originX) * z)
        el.style.width = px(box.w * z)
      }
      for (const seg of segments) {
        const el = segmentEls.current.get(seg.col)
        const box = g.columns[seg.col]
        if (!el || !box) continue
        el.style.left = px((box.x - originX) * z - SEGMENT_OVERHANG)
        el.style.width = px(Math.max(2, box.w * z + 2 * SEGMENT_OVERHANG))
        seg.notches.forEach((offset, i) => {
          const notch = el.children[i] as HTMLElement | undefined
          if (notch) notch.style.left = px(SEGMENT_OVERHANG + offset * z)
        })
      }
    }
    for (const row of rows) {
      const label = labelEls.current.get(row.band)
      const box = g.bands[row.band]
      if (!label || !box) continue
      const left = frame.toX(box.x) - plot.left
      const right = left + box.w * z
      const visW = Math.min(right, plot.width) - Math.max(left, 0)
      const w = measure(row.band, label)
      let mode: 'full' | 'short' | 'title' | 'hidden' = 'full'
      if (visW < HIDE_BELOW) mode = 'hidden'
      else if (visW < w.short + SHORT_SLACK) mode = 'title'
      else if (visW < w.full + SHORT_SLACK) mode = 'short'
      const blockW = mode === 'full' ? w.full : mode === 'short' ? w.short : w.title
      const x = clamp(left + LABEL_INSET, LABEL_INSET, right - blockW - LABEL_RIGHT)
      if (label.dataset.mode !== mode) label.dataset.mode = mode
      setShown(label, mode !== 'hidden' && right > 0 && left < plot.width)
      setTransform(label, Math.max(x, left + 2), 0)
    }
    const marker = markerRef.current
    if (marker) {
      const node = focus >= 0 ? g.nodes[focus] : undefined
      const band = focus >= 0 ? g.bands[topology.nodes[focus].band] : undefined
      if (!node || !band || node.cls === 'hidden') {
        setShown(marker, false)
      } else {
        const left = frame.toX(band.x) - plot.left
        const x = clamp(frame.toX(node.cx) - plot.left, left + MARKER_HALF, left + band.w * z - MARKER_HALF)
        setShown(marker, x > -MARKER_HALF && x < plot.width + MARKER_HALF)
        setTransform(marker, x - MARKER_HALF, 0)
      }
    }
  }, [rows, segments, focus, topology, originX])
  useFrameLayout(bus, layout)

  return (
    <div className="gc-bands">
      <div className="gc-band-layer" ref={layerRef}>
        {rows.map(row => (
          <div
            key={row.band}
            className={`gc-band${row.odd ? ' is-odd' : ''}`}
            ref={el => {
              if (el) bandEls.current.set(row.band, el)
              else bandEls.current.delete(row.band)
            }}
          />
        ))}
        <div className="gc-scale" aria-hidden="true">
          {segments.map(seg => (
            <div
              key={seg.col}
              className={`gc-seg${seg.filled ? ' is-filled' : ''}${seg.mini ? ' is-mini' : ''}`}
              ref={el => {
                if (el) segmentEls.current.set(seg.col, el)
                else segmentEls.current.delete(seg.col)
              }}
            >
              {seg.notches.map((_, i) => <span key={i} className="gc-notch" />)}
            </div>
          ))}
        </div>
      </div>
      {rows.map(row => (
        <div
          key={row.band}
          className="gc-band-label"
          data-mode="full"
          ref={el => {
            if (el) labelEls.current.set(row.band, el)
            else labelEls.current.delete(row.band)
          }}
        >
          <div className="gc-band-long">
            <div className="gc-band-title">{row.title}</div>
            <div className="gc-band-meta">
              {row.year}
              {strings.sep}
              <BandMeta meta={row.meta} />
            </div>
          </div>
          <div className="gc-band-short">
            <div className="gc-band-title">{row.short}</div>
            <div className="gc-band-meta"><BandMeta meta={row.meta} /></div>
          </div>
        </div>
      ))}
      <div className="gc-band-marker" ref={markerRef} aria-hidden="true" />
    </div>
  )
}

function BandMeta({ meta }: { meta: BandRow['meta'] }) {
  if (meta.needed === undefined) return <>{meta.text}</>
  return (
    <span className="gc-counts">
      <span className="gc-dot gc-dot-pre" />
      {meta.needed}
      <span className="gc-sep">·</span>
      <span className="gc-dot gc-dot-unl" />
      {meta.unlocked}
    </span>
  )
}
