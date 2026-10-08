// Per-lane and per-band counts for the sticky headers (design-spec 7.5, 9.1-9.3). Pure.
import type { Geometry, Presentation, Topology } from '../types'

export interface Counts {
  /** Courses in the lane / band. */
  total: number
  /** Not hidden by filters. */
  visible: number
  /** Visible prerequisites (direct and earlier) and unlocks (direct and later) of the focus. */
  needed: number
  unlocked: number
  /** Visible program courses. */
  program: number
  /** Contains the focus. */
  focus: boolean
}

const empty = (): Counts => ({ total: 0, visible: 0, needed: 0, unlocked: 0, program: 0, focus: false })

function add(counts: Counts, presentation: Presentation, v: number): void {
  counts.total++
  if (presentation.cls[v] === 'hidden') return
  counts.visible++
  const role = presentation.role[v]
  if (role === 'prereq-direct' || role === 'prereq') counts.needed++
  else if (role === 'unlock-direct' || role === 'unlock') counts.unlocked++
  else if (role === 'focus') counts.focus = true
  if (presentation.inProgram[v]) counts.program++
}

export function laneCounts(topology: Topology, presentation: Presentation): Counts[] {
  return topology.lanes.map(lane => {
    const counts = empty()
    for (const v of lane.nodes) add(counts, presentation, v)
    return counts
  })
}

export interface BandCounts extends Counts {
  /** Visible sub-columns of the band. */
  columns: number
}

export function bandCounts(topology: Topology, presentation: Presentation, geometry: Geometry): BandCounts[] {
  const bands = topology.bands.map((): BandCounts => ({ ...empty(), columns: 0 }))
  for (const node of topology.nodes) {
    const band = bands[node.band]
    if (band) add(band, presentation, node.index)
  }
  topology.bands.forEach((band, b) => {
    for (let col = band.startCol; col <= band.endCol; col++) if ((geometry.columns[col]?.w ?? 0) > 0) bands[b].columns++
  })
  return bands
}

/** Lanes that hold chain courses (focus included) — the corner's "3 with chain courses". */
export function chainLaneCount(counts: readonly Counts[]): number {
  return counts.filter(c => c.needed + c.unlocked > 0 || c.focus).length
}
