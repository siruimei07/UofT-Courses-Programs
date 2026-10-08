// The graph pipeline for the current app state, memoised stage by stage (design-spec 16.1):
//   record → statuses (a failed course counts as not taken) + eligibility (memo shared with the
//   panels) → presentation + geometry (chain titles auto, 8.2) → routes.
// Topology, engine and the label measurer are built by the caller once per dataset.
import { useMemo } from 'react'
import type { GraphCourse, GraphDataset } from '../data/schema'
import type { CourseEngine } from '../domain/engine-types'
import type { PlotSize } from '../graph/canvas-types'
import { computeRoutes } from '../graph/routes'
import type { LabelMeasurer } from '../graph/text'
import type { Eligibility, Geometry, Presentation, Routes, Topology } from '../graph/types'
import { chainTitlesAuto, resolveChainTitles, type ChainTitles, type ChainTitlesBase } from './chainTitles'
import { anyGroupsOf } from './readout'
import { presentationRecord, recordEligibility } from './record'
import { useApp } from './store'

export interface GraphModel {
  presentation: Presentation
  geometry: Geometry
  routes: Routes
  /** Focus node index, or -1. */
  focusIndex: number
  focusCourse: GraphCourse | null
  chainTitles: ChainTitles
  /** Eligibility per course id for the current record (null when the record is empty). */
  eligibility: ReadonlyMap<string, Eligibility> | null
}

export function useCourseById(dataset: GraphDataset): ReadonlyMap<string, GraphCourse> {
  return useMemo(() => new Map(dataset.courses.map(course => [course.id, course])), [dataset])
}

export function useGraphModel(
  topology: Topology,
  courseById: ReadonlyMap<string, GraphCourse>,
  engine: CourseEngine,
  measure: LabelMeasurer,
  programIds: ReadonlySet<string> | null,
  plot: PlotSize | null,
): GraphModel {
  const focusId = useApp(state => state.focusId)
  const depth = useApp(state => state.depth)
  const hideUnrelated = useApp(state => state.hideUnrelated)
  const hideCompleted = useApp(state => state.hideCompleted)
  const showAllEdges = useApp(state => state.showAllEdges)
  const titles = useApp(state => state.titles)
  const levels = useApp(state => state.levels)
  const subjects = useApp(state => state.subjects)
  const record = useApp(state => state.record)

  // A failed course is drawn as not taken; eligibility is shared with the panels (one engine pass
  // per record change).
  const statuses = useMemo(() => presentationRecord(record), [record])
  const eligibility = useMemo(() => recordEligibility(engine, record), [engine, record])

  const base = useMemo<ChainTitlesBase>(() => ({
    focusId, depth, hideUnrelated, hideCompleted, showAllEdges, levels, subjects, programIds,
    record: statuses, eligibility, titles,
  }), [focusId, depth, hideUnrelated, hideCompleted, showAllEdges, levels, subjects, programIds, statuses, eligibility, titles])

  const focusIndex = focusId ? topology.indexById.get(focusId) ?? -1 : -1
  // The focus row height follows the plate's wrapped title lines, which only the text module knows.
  const extras = useMemo(() => (focusIndex >= 0 ? { focusLines: measure.plate(focusIndex, 'world').lines.length } : {}), [measure, focusIndex])
  // The plot size only matters while chain titles are automatic: resizing the overview never
  // rebuilds the presentation.
  const titlesPlot = chainTitlesAuto(base, focusIndex) ? plot : null
  const resolved = useMemo(
    () => resolveChainTitles(topology, base, focusIndex, measure, titlesPlot, extras),
    [topology, base, focusIndex, measure, titlesPlot, extras],
  )
  const { presentation, geometry, chainTitles } = resolved
  const focusCourse = focusId ? courseById.get(focusId) ?? null : null

  const anyGroups = useMemo(
    () => (focusCourse && focusIndex >= 0 ? anyGroupsOf(focusCourse.prereq?.rule, topology, focusIndex) : []),
    [focusCourse, focusIndex, topology],
  )
  const routes = useMemo(() => computeRoutes(topology, presentation, geometry, { anyGroups }), [topology, presentation, geometry, anyGroups])

  return { presentation, geometry, routes, focusIndex, focusCourse, eligibility, chainTitles }
}
