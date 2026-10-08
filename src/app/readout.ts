// Plain-language chain readout for the card head (design-spec 6.3) and the parsed "any one of"
// groups that routes.ts draws as fork junctions (7.4). Pure; counts come from the topology the
// presentation roles are built from, so the readout and the map always agree.
//
// "Needs" counts prerequisite edges only. Corequisites (taken together) are summarised separately
// ("+ 1 of 5 corequisites"), and "any one of" groups are detected in both rules. The Course panel
// imports `classifyRequirements` so the panel and the card head always say the same thing.
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

/** Direct corequisites on the map; never counted in "Needs". */
export type CoreqReadout =
  | { kind: 'none' }
  | { kind: 'plain'; count: number }
  | { kind: 'oneOf'; of: number }
  | { kind: 'alternatives'; count: number }
  | { kind: 'unknown'; count: number }

export type UnlocksReadout = { kind: 'none' } | { kind: 'plain'; direct: number; total: number }

/** What a course needs, as the card head and the Course panel word it. */
export interface RequirementReadout {
  needs: NeedsReadout
  coreqs: CoreqReadout
}

export interface Readout extends RequirementReadout {
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
 * Parsed `any` nodes (top-level or nested) of a requirement rule, as groups of node indices of
 * their course / minGrade leaves that are direct layout predecessors of the focus (or members of
 * `among` when given). Groups with fewer than 2 such leaves are dropped. A top-level `unknown`
 * rule has no groups.
 */
export function anyGroupsOf(rule: Rule | undefined, topology: Topology, focus: number, among?: Iterable<number>): number[][] {
  if (!rule || focus < 0 || unwrapRule(rule).kind === 'unknown') return []
  const preds = new Set(among ?? topology.preds[focus])
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
  return reachFrom(adjacency, adjacency[start], start)
}

/** Size of everything reachable from `seeds` through `adjacency` (seeds included), never `exclude`. */
function reachFrom(adjacency: readonly (readonly number[])[], seeds: Iterable<number>, exclude: number): number {
  const seen = new Set<number>([exclude])
  const queue: number[] = []
  const add = (next: number) => {
    if (seen.has(next)) return
    seen.add(next)
    queue.push(next)
  }
  for (const seed of seeds) add(seed)
  for (let head = 0; head < queue.length; head++) for (const next of adjacency[queue[head]]) add(next)
  return seen.size - 1
}

export interface DirectPreds {
  /** Prerequisite layout edges into the focus (a course named in both rules counts here). */
  prereq: number[]
  /** Corequisite layout edges into the focus. */
  coreq: number[]
}

/** Direct layout predecessors of `focus`, split by edge kind. */
export function directPreds(topology: Topology, focus: number): DirectPreds {
  const result: DirectPreds = { prereq: [], coreq: [] }
  if (focus < 0) return result
  for (const edge of topology.edges) {
    if (edge.to === focus) result[edge.kind].push(edge.from)
  }
  return result
}

/**
 * Classifies what a course needs (design-spec 6.3): prerequisite edges for "Needs", with the
 * total reached through them, and the corequisite edges as a separate summary. Shared by the card
 * head and the Course panel.
 */
export function classifyRequirements(course: GraphCourse, topology: Topology, focus: number): RequirementReadout {
  const direct = directPreds(topology, focus)
  return {
    needs: needsReadout(course, topology, focus, new Set(direct.prereq)),
    coreqs: coreqReadout(course, topology, focus, new Set(direct.coreq)),
  }
}

function needsReadout(course: GraphCourse, topology: Topology, focus: number, prereqs: ReadonlySet<number>): NeedsReadout {
  const rule = course.prereq ? unwrapRule(course.prereq.rule) : null
  const direct = prereqs.size
  if (!direct) return rule && rule.kind !== 'true' ? { kind: 'offMap' } : { kind: 'none' }
  // Everything the prerequisites need in turn (their own corequisites included).
  const total = reachFrom(topology.preds, prereqs, focus)
  if (rule?.kind === 'unknown') return { kind: 'unknown', direct, total }
  const groups = anyGroupsOf(course.prereq?.rule, topology, focus, prereqs)
  if (!groups.length) return { kind: 'plain', direct, total }
  // "Needs 1 of N" only when one top-level `any` group accounts for every direct prerequisite.
  if (groups.length === 1 && rule?.kind === 'any' && groups[0].length === direct) return { kind: 'oneOf', of: direct, total }
  return { kind: 'alternatives', direct, total }
}

function coreqReadout(course: GraphCourse, topology: Topology, focus: number, coreqs: ReadonlySet<number>): CoreqReadout {
  const count = coreqs.size
  if (!count) return { kind: 'none' }
  const rule = course.coreq ? unwrapRule(course.coreq.rule) : null
  if (rule?.kind === 'unknown') return { kind: 'unknown', count }
  const groups = anyGroupsOf(course.coreq?.rule, topology, focus, coreqs)
  if (!groups.length) return { kind: 'plain', count }
  if (groups.length === 1 && rule?.kind === 'any' && groups[0].length === count) return { kind: 'oneOf', of: count }
  return { kind: 'alternatives', count }
}

const CHAIN_ROLES = new Set(['prereq-direct', 'prereq', 'unlock-direct', 'unlock'])

export function computeReadout(topology: Topology, presentation: Presentation, focus: number, course: GraphCourse): Readout {
  const directSuccs = new Set(topology.succs[focus]).size
  const unlocksTotal = reachCount(topology.succs, focus)

  let hiddenByFilters = 0
  presentation.role.forEach((role, index) => {
    if (CHAIN_ROLES.has(role) && presentation.cls[index] === 'hidden') hiddenByFilters++
  })

  return {
    ...classifyRequirements(course, topology, focus),
    unlocks: directSuccs ? { kind: 'plain', direct: directSuccs, total: unlocksTotal } : { kind: 'none' },
    hiddenByFilters,
  }
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
