// The graph pipeline for the current app state, memoised stage by stage (design-spec 16.1):
//   record → eligibility → presentation (chain titles auto, 8.2) → geometry → routes.
// Topology, engine and the label measurer are built by the caller once per dataset.
import { useMemo } from 'react'
import type { GraphCourse, GraphDataset } from '../data/schema'
import type { CourseEngine } from '../domain/engine-types'
import type { PlotSize } from '../graph/canvas-types'
import { computeGeometry } from '../graph/geometry'
import { computePresentation } from '../graph/presentation'
import { computeRoutes } from '../graph/routes'
import type { LabelMeasurer } from '../graph/text'
import type { Eligibility, Geometry, Presentation, PresentationInput, RecordStatus, Routes, Topology } from '../graph/types'
import { boxFitsPlot, chainBox } from './framing'
import { anyGroupsOf } from './readout'
import { useApp } from './store'

export interface GraphModel {
  presentation: Presentation
  geometry: Geometry
  routes: Routes
  /** Focus node index, or -1. */
  focusIndex: number
  focusCourse: GraphCourse | null
  chainTitles: PresentationInput['chainTitles']
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

  const statuses = useMemo(() => {
    const map = new Map<string, RecordStatus>()
    for (const [id, entry] of record) map.set(id, entry.status)
    return map
  }, [record])
  const eligibility = useMemo(() => (record.size ? engine.eligibility(record) : null), [engine, record])

  const base = useMemo<Omit<PresentationInput, 'chainTitles'>>(() => ({
    focusId, depth, hideUnrelated, hideCompleted, showAllEdges, levels, subjects, programIds,
    record: statuses, eligibility, titles,
  }), [focusId, depth, hideUnrelated, hideCompleted, showAllEdges, levels, subjects, programIds, statuses, eligibility, titles])

  const focusIndex = focusId ? topology.indexById.get(focusId) ?? -1 : -1
  // The focus row height follows the plate's wrapped title lines, which only the text module knows.
  const extras = useMemo(() => (focusIndex >= 0 ? { focusLines: measure.plate(focusIndex, 'world').lines.length } : {}), [measure, focusIndex])
  // Chain titles only matter for transitive chain nodes: a focus, depth 'all' and Titles off.
  const auto = focusIndex >= 0 && depth === 'all' && !titles

  const allPresentation = useMemo(() => computePresentation(topology, { ...base, chainTitles: 'all' }), [topology, base])
  const allGeometry = useMemo(() => computeGeometry(topology, allPresentation, measure, extras), [topology, allPresentation, measure, extras])
  const fitsAll = useMemo(() => !auto || boxFitsPlot(chainBox(allPresentation, allGeometry), plot), [auto, allPresentation, allGeometry, plot])

  const directPresentation = useMemo(
    () => (fitsAll ? null : computePresentation(topology, { ...base, chainTitles: 'direct' })),
    [fitsAll, topology, base],
  )
  const directGeometry = useMemo(
    () => (directPresentation ? computeGeometry(topology, directPresentation, measure, extras) : null),
    [directPresentation, topology, measure, extras],
  )

  const presentation = directPresentation ?? allPresentation
  const geometry = directGeometry ?? allGeometry
  const focusCourse = focusId ? courseById.get(focusId) ?? null : null

  const anyGroups = useMemo(
    () => (focusCourse && focusIndex >= 0 ? anyGroupsOf(focusCourse.prereq?.rule, topology, focusIndex) : []),
    [focusCourse, focusIndex, topology],
  )
  const routes = useMemo(() => computeRoutes(topology, presentation, geometry, { anyGroups }), [topology, presentation, geometry, anyGroups])

  return {
    presentation, geometry, routes, focusIndex, focusCourse, eligibility,
    chainTitles: directPresentation ? 'direct' : 'all',
  }
}
