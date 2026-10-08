// Contract between the canvas graph view (src/graph/GraphCanvas.tsx) and the app shell.
// GraphCanvas owns everything inside the graph area: the canvas, the sticky lane column, band bar
// and corner (DOM overlays), scrollbars + overview ruler, edge-of-view pills, tooltip, the
// keyboard cursor and the live region. It keeps its own localised strings (defineStrings).
import type { Ref } from 'react'
import type { GraphDataset } from '../data/schema'
import type { Geometry, LabelMeasure, Presentation, Routes, Topology } from './types'

export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  /** Zoom factor where 1 = 100 %. Clamped to the renderer's limits (0.35-2.0). */
  setZoom(zoom: number): void
  /** Fit the full graph width (lane header included) into the viewport. */
  fitWidth(): void
  /** Frame the selected chain or the program courses (design-spec 10.2). */
  frame(target: 'chain' | 'program'): void
  /** Scroll so the node is visible (centred when it was off-screen); zoom unchanged. */
  centerOn(courseId: string): void
  /** Scroll a subject's lane to the top of the plot (landing, "Jump"). */
  scrollToLane(subject: string): void
  getZoom(): number
}

export interface PlotSize {
  /** Plot area in CSS px: canvas minus lane header column and band header row. */
  width: number
  height: number
}

export interface GraphCanvasProps {
  dataset: GraphDataset
  topology: Topology
  presentation: Presentation
  geometry: Geometry
  /** Highlighted (chain / program) edges, already routed. Hover previews are routed internally. */
  routes: Routes
  /** The same measurer geometry was computed with (labels are drawn with matching truncation). */
  measure: LabelMeasure
  /** Resolved theme; the renderer re-reads CSS custom properties when it changes. */
  theme: 'light' | 'dark'
  selectedId: string | null
  programActive: boolean
  /** Click on a node selects it; click on empty plot or Escape (ladder step) passes null. */
  onSelect(courseId: string | null, via: 'click' | 'double-click' | 'keyboard'): void
  onHover?(courseId: string | null): void
  onZoomChange?(zoom: number): void
  /** Reported on mount and on every resize; the app uses it to resolve chain titles (8.2). */
  onPlotSize?(size: PlotSize): void
  /** Animate geometry changes (motion phase); must honour prefers-reduced-motion. */
  motion?: boolean
  ref?: Ref<GraphCanvasHandle>
}
