// Per-frame layout channel between the canvas loop and the DOM overlays. React renders overlay
// content when data changes; on every canvas frame the overlays reposition themselves through
// `transform` (and rewrite sizes only when the zoom or geometry changed), without re-rendering.
import { useLayoutEffect } from 'react'
import type { Geometry } from '../types'
import type { Plot, View } from '../viewport'

export interface FrameInfo {
  view: View
  plot: Plot
  /** Graph area (canvas) size in CSS px. */
  width: number
  height: number
  geometry: Geometry
  /** Zoom, size or geometry changed since the previous frame: sizes must be rewritten. */
  scaleChanged: boolean
  /** World → graph-area CSS px. */
  toX(wx: number): number
  toY(wy: number): number
}

export type FrameListener = (frame: FrameInfo) => void

export interface FrameBus {
  subscribe(listener: FrameListener): () => void
  emit(frame: FrameInfo): void
  last(): FrameInfo | null
}

export function createFrameBus(): FrameBus {
  const listeners = new Set<FrameListener>()
  let last: FrameInfo | null = null
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(frame) {
      last = frame
      listeners.forEach(listener => listener(frame))
    },
    last: () => last,
  }
}

/** Runs `layout` on every frame, and once immediately (with sizes) when it changes. */
export function useFrameLayout(bus: FrameBus, layout: FrameListener): void {
  useLayoutEffect(() => {
    const off = bus.subscribe(layout)
    const last = bus.last()
    if (last) layout({ ...last, scaleChanged: true })
    return off
  }, [bus, layout])
}

export const px = (value: number) => `${Math.round(value * 100) / 100}px`

export function setTransform(el: HTMLElement | null, x: number, y: number): void {
  if (!el) return
  const value = `translate(${px(x)}, ${px(y)})`
  if (el.style.transform !== value) el.style.transform = value
}

export function setShown(el: HTMLElement | null, shown: boolean): void {
  if (!el) return
  const value = shown ? '' : 'none'
  if (el.style.display !== value) el.style.display = value
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
