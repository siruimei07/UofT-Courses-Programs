// Scrollbars with the overview ruler (design-spec 9.4): a vertical track with division marks and,
// during a selection or program, per-lane relation marks; a horizontal track with band marks.
// Thumbs drag, tracks jump, marks scroll their lane to plot top + 24. Bars hide when content fits.
import { useCallback, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { laneToneVar } from '../tokens'
import type { Geometry, Topology } from '../types'
import { scrollThumb, viewFromThumb, type World } from '../viewport'
import type { Counts } from './counts'
import { px, setShown, useFrameLayout, type FrameBus, type FrameInfo } from './frame'

/** Track geometry (CSS px), see graph.css. */
const TRACK = 10
const V_BOTTOM_GAP = 12
const H_RIGHT_GAP = 12

interface Mark {
  key: string
  pos: number
  kind: 'division' | 'pre' | 'unl' | 'both' | 'prog'
  color?: string
  lane: number
}

export interface ScrollbarsProps {
  bus: FrameBus
  topology: Topology
  geometry: Geometry
  counts: readonly Counts[]
  world: World
  focus: number
  programActive: boolean
  onScrollTo(axis: 'x' | 'y', value: number): void
  onLaneMark(lane: number): void
}

interface Drag {
  axis: 'x' | 'y'
  pointer: number
  start: number
  thumb: number
  track: number
}

export function Scrollbars(props: ScrollbarsProps) {
  const { bus, topology, geometry, counts, world, focus, programActive, onScrollTo, onLaneMark } = props
  const vTrack = useRef<HTMLDivElement>(null)
  const hTrack = useRef<HTMLDivElement>(null)
  const vThumb = useRef<HTMLDivElement>(null)
  const hThumb = useRef<HTMLDivElement>(null)
  const frameRef = useRef<FrameInfo | null>(null)
  const thumbs = useRef({ x: { start: 0, length: 0 }, y: { start: 0, length: 0 } })
  const drag = useRef<Drag | null>(null)

  const marks = useMemo<Mark[]>(() => {
    const out: Mark[] = []
    const span = Math.max(1, world.height - world.originY)
    let previous: string | null = null
    topology.lanes.forEach((lane, i) => {
      const box = geometry.lanes[i]
      if (!box || box.collapsed || box.h <= 0) return
      if (lane.division !== previous) {
        out.push({ key: `d${i}`, pos: ((box.y - world.originY) / span) * 100, kind: 'division', color: laneToneVar(lane.division, 1), lane: i })
        previous = lane.division
      }
      const c = counts[i]
      let kind: Mark['kind'] | null = null
      if (focus >= 0) {
        if (c.needed && c.unlocked) kind = 'both'
        else if (c.needed) kind = 'pre'
        else if (c.unlocked) kind = 'unl'
      } else if (programActive && c.program) {
        kind = 'prog'
      }
      if (kind) out.push({ key: `l${i}`, pos: ((box.y + box.h / 2 - world.originY) / span) * 100, kind, lane: i })
    })
    return out
  }, [topology, geometry, counts, world, focus, programActive])

  const bandMarks = useMemo(() => {
    const span = Math.max(1, world.width - world.originX)
    return geometry.bands
      .map((band, b) => ({ b, band }))
      .filter(({ band, b }) => band.visible && b > 0 && band.x > world.originX)
      .map(({ band, b }) => ({ key: b, pos: ((band.x - world.originX) / span) * 100 }))
  }, [geometry, world])

  const layout = useCallback((frame: FrameInfo) => {
    frameRef.current = frame
    const { view, plot } = frame
    const vLen = Math.max(0, frame.height - plot.top - V_BOTTOM_GAP)
    const hLen = Math.max(0, frame.width - plot.left - H_RIGHT_GAP)
    const v = scrollThumb(world.originY, frame.geometry.height, view.y, plot.height / view.zoom, vLen)
    const h = scrollThumb(world.originX, frame.geometry.width, view.x, plot.width / view.zoom, hLen)
    setShown(vTrack.current, v.scrollable)
    setShown(hTrack.current, h.scrollable)
    thumbs.current = { x: { start: h.thumbStart, length: h.thumbLength }, y: { start: v.thumbStart, length: v.thumbLength } }
    if (vThumb.current && v.scrollable) {
      vThumb.current.style.transform = `translateY(${px(v.thumbStart)})`
      vThumb.current.style.height = px(v.thumbLength)
    }
    if (hThumb.current && h.scrollable) {
      hThumb.current.style.transform = `translateX(${px(h.thumbStart)})`
      hThumb.current.style.width = px(h.thumbLength)
    }
  }, [world])
  useFrameLayout(bus, layout)

  const trackLength = (axis: 'x' | 'y') => {
    const frame = frameRef.current
    if (!frame) return 0
    return axis === 'y' ? frame.height - frame.plot.top - V_BOTTOM_GAP : frame.width - frame.plot.left - H_RIGHT_GAP
  }

  const scrollToThumb = (axis: 'x' | 'y', thumbStart: number) => {
    const frame = frameRef.current
    if (!frame) return
    const z = frame.view.zoom
    const track = trackLength(axis)
    const length = thumbs.current[axis].length
    const value = axis === 'y'
      ? viewFromThumb(world.originY, frame.geometry.height, frame.plot.height / z, track, length, thumbStart)
      : viewFromThumb(world.originX, frame.geometry.width, frame.plot.width / z, track, length, thumbStart)
    onScrollTo(axis, value)
  }

  const onThumbDown = (axis: 'x' | 'y') => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { axis, pointer: axis === 'y' ? event.clientY : event.clientX, start: thumbs.current[axis].start, thumb: thumbs.current[axis].length, track: trackLength(axis) }
    event.currentTarget.dataset.dragging = 'true'
  }
  const onThumbMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const delta = (d.axis === 'y' ? event.clientY : event.clientX) - d.pointer
    scrollToThumb(d.axis, d.start + delta)
  }
  const onThumbUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    delete event.currentTarget.dataset.dragging
  }

  const onTrackDown = (axis: 'x' | 'y') => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const at = axis === 'y' ? event.clientY - rect.top : event.clientX - rect.left
    scrollToThumb(axis, at - thumbs.current[axis].length / 2)
  }

  const onMark = (lane: number) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    onLaneMark(lane)
  }

  return (
    <>
      <div className="gc-vscroll" ref={vTrack} aria-hidden="true" onPointerDown={onTrackDown('y')} style={{ width: TRACK }}>
        {marks.map(mark => (
          <span
            key={mark.key}
            className={`gc-mark gc-mark-${mark.kind}`}
            style={{ top: `${mark.pos}%`, background: mark.color }}
            onPointerDown={onMark(mark.lane)}
          />
        ))}
        <div className="gc-thumb" ref={vThumb} onPointerDown={onThumbDown('y')} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp} />
      </div>
      <div className="gc-hscroll" ref={hTrack} aria-hidden="true" onPointerDown={onTrackDown('x')} style={{ height: TRACK }}>
        {bandMarks.map(mark => <span key={mark.key} className="gc-mark gc-mark-band" style={{ left: `${mark.pos}%` }} />)}
        <div className="gc-thumb" ref={hThumb} onPointerDown={onThumbDown('x')} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp} />
      </div>
    </>
  )
}
