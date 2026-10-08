// Plain-language chain readout for the card head (design-spec 6.3) and the parsed "any one of"
// groups that routes.ts draws as fork junctions (7.4). Pure; counts come from the topology the
// presentation roles are built from, so the readout and the map always agree.
import type { GraphCourse } from '../data/schema'
import type { Rule } from '../domain/types'
import type { Presentation, Topology } from '../graph/types'

export type NeedsReadout =
  | { kind: 'none' }
  /** A prerequisite field exists but names no course on this map (permission, credits, ...). */
  | { kind: 'offMap' }
  | { kind: 'plain'; direct: number; total: number }
  | { kind: 'oneOf'; of: number; total: number }
  | { kind: 'alternatives'; direct: number; total: number }
  | { kind: 'unknown'; direct: number; total: number }

export type UnlocksReadout = { kind: 'none' } | { kind: 'plain'; direct: number; total: number }

export interface Readout {
  needs: NeedsReadout
  unlocks: UnlocksReadout
  /** Chain courses hidden by the level, subject or "Hide completed" filters. */
  hiddenByFilters: number
}

/** The rule below any cohort wrapper ("applicability"), which does not change its structure. */
export function unwrapRule(rule: Rule): Rule {
  let current = rule
  while (current.kind === 'applicability') current = current.rule
  return current
}

/**
 * Parsed `any` nodes (top-level or nested) of the focus's prerequisite rule, as groups of node
 * indices of their course / minGrade leaves that are direct layout predecessors of the focus.
 * Groups with fewer than 2 such leaves are dropped. A top-level `unknown` rule has no groups.
 */
export function anyGroupsOf(rule: Rule | undefined, topology: Topology, focus: number): number[][] {
  if (!rule || focus < 0 || unwrapRule(rule).kind === 'unknown') return []
  const preds = new Set(topology.preds[focus])
  const groups: number[][] = []
  const visit = (node: Rule) => {
    if (node.kind === 'applicability') return visit(node.rule)
    if (node.kind !== 'all' && node.kind !== 'any') return
    if (node.kind === 'any') {
      const group = new Set<number>()
      for (const item of node.items) {
        if (item.kind !== 'course' && item.kind !== 'minGrade') continue
        const index = topology.indexById.get(item.courseId)
        if (index !== undefined && preds.has(index)) group.add(index)
      }
      if (group.size >= 2) groups.push([...group].sort((a, b) => a - b))
    }
    node.items.forEach(visit)
  }
  visit(rule)
  return groups
}

/** Size of everything reachable from `start` through `adjacency`, excluding `start`. */
export function reachCount(adjacency: readonly (readonly number[])[], start: number): number {
  const seen = new Set<number>([start])
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    for (const next of adjacency[queue[head]]) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen.size - 1
}

const CHAIN_ROLES = new Set(['prereq-direct', 'prereq', 'unlock-direct', 'unlock'])

export function computeReadout(topology: Topology, presentation: Presentation, focus: number, course: GraphCourse): Readout {
  const directPreds = new Set(topology.preds[focus]).size
  const directSuccs = new Set(topology.succs[focus]).size
  const needsTotal = reachCount(topology.preds, focus)
  const unlocksTotal = reachCount(topology.succs, focus)

  let hiddenByFilters = 0
  presentation.role.forEach((role, index) => {
    if (CHAIN_ROLES.has(role) && presentation.cls[index] === 'hidden') hiddenByFilters++
  })

  return {
    needs: needsReadout(course, topology, focus, directPreds, needsTotal),
    unlocks: directSuccs ? { kind: 'plain', direct: directSuccs, total: unlocksTotal } : { kind: 'none' },
    hiddenByFilters,
  }
}

function needsReadout(course: GraphCourse, topology: Topology, focus: number, direct: number, total: number): NeedsReadout {
  const rule = course.prereq ? unwrapRule(course.prereq.rule) : null
  if (!direct) return rule && rule.kind !== 'true' ? { kind: 'offMap' } : { kind: 'none' }
  if (rule?.kind === 'unknown') return { kind: 'unknown', direct, total }
  const groups = anyGroupsOf(course.prereq?.rule, topology, focus)
  if (!groups.length) return { kind: 'plain', direct, total }
  // "Needs 1 of N" only when one top-level `any` group accounts for every direct prerequisite.
  if (groups.length === 1 && rule?.kind === 'any' && groups[0].length === direct) return { kind: 'oneOf', of: direct, total }
  return { kind: 'alternatives', direct, total }
}

/** Visible-course and visible-subject counts for the card meta (6.3, 8.4 collapsed lanes). */
export interface ShownCounts {
  courses: number
  subjects: number
}

export function shownCounts(topology: Topology, presentation: Presentation): ShownCounts {
  let courses = 0
  let subjects = 0
  for (const lane of topology.lanes) {
    let shown = 0
    for (const index of lane.nodes) if (presentation.cls[index] !== 'hidden') shown++
    courses += shown
    if (shown) subjects++
  }
  return { courses, subjects }
}
