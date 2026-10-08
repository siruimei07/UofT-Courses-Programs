// "Chain titles: auto" (design-spec 8.2): during a selection with depth 'all' and Titles off, the
// transitive chain courses keep their titles only when the chain box still fits the plot at the
// framing floor; otherwise they drop to codes ('direct'). Pure: the label measure is injected, so
// the decision is testable without a canvas.
import type { PlotSize } from '../graph/canvas-types'
import { computeGeometry, type GeometryExtras } from '../graph/geometry'
import { computePresentation } from '../graph/presentation'
import type { Geometry, LabelMeasure, Presentation, PresentationInput, Topology } from '../graph/types'
import { boxFitsPlot, chainBox } from './framing'

export type ChainTitles = PresentationInput['chainTitles']
export type ChainTitlesBase = Omit<PresentationInput, 'chainTitles'>

export interface ChainTitlesResult {
  chainTitles: ChainTitles
  presentation: Presentation
  geometry: Geometry
}

/** Chain titles only matter for transitive chain nodes: a focus on the map, depth 'all', Titles off. */
export function chainTitlesAuto(base: ChainTitlesBase, focusIndex: number): boolean {
  return focusIndex >= 0 && base.depth === 'all' && !base.titles
}

/**
 * Presentation and geometry for the current state with chain titles resolved. The 'direct' pass
 * runs only when the 'all' chain does not fit; without a plot size the titles stay.
 */
export function resolveChainTitles(
  topology: Topology,
  base: ChainTitlesBase,
  focusIndex: number,
  measure: LabelMeasure,
  plot: PlotSize | null,
  extras: GeometryExtras = {},
): ChainTitlesResult {
  const presentation = computePresentation(topology, { ...base, chainTitles: 'all' })
  const geometry = computeGeometry(topology, presentation, measure, extras)
  if (!chainTitlesAuto(base, focusIndex) || boxFitsPlot(chainBox(presentation, geometry), plot)) {
    return { chainTitles: 'all', presentation, geometry }
  }
  const direct = computePresentation(topology, { ...base, chainTitles: 'direct' })
  return { chainTitles: 'direct', presentation: direct, geometry: computeGeometry(topology, direct, measure, extras) }
}
