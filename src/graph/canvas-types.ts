// Contract between the canvas graph view (src/graph/GraphCanvas.tsx) and the app shell.
import type { Ref } from 'react'
import type { Band, Geometry, Lane, Presentation, Topology } from './types'

export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  /** Zoom factor where 1 = 100 %. Clamped to the renderer's limits. */
  setZoom(zoom: number): void
  /** Fit the full graph width (lane header included) into the viewport. */
  fitWidth(): void
  /** Scroll so the node is visible (centred when it was off-screen). */
  centerOn(courseId: string): void
  getZoom(): number
}

export interface BandLabel {
  title: string
  subtitle: string
}

export interface LaneLabel {
  title: string
  subtitle: string
}

export interface GraphCanvasProps {
  topology: Topology
  presentation: Presentation
  geometry: Geometry
  /** Resolved theme; the renderer re-reads CSS custom properties when it changes. */
  theme: 'light' | 'dark'
  selectedId: string | null
  /** Localised band header text (e.g. "100-level" / "139 courses"). */
  bandLabel(band: Band): BandLabel
  /** Localised lane header text (subject code + name / department · count). */
  laneLabel(lane: Lane): LaneLabel
  /** Click on a node selects it; click on empty canvas or Escape passes null. */
  onSelect(courseId: string | null): void
  onHover?(courseId: string | null): void
  onZoomChange?(zoom: number): void
  /** Animate geometry changes (motion phase); must honour prefers-reduced-motion. */
  motion?: boolean
  /** Accessible name for the canvas region. */
  ariaLabel: string
  ref?: Ref<GraphCanvasHandle>
}
