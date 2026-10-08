// What every node and edge means for the current app state (focus, program, filters, record).
import type { DisplayClass, EdgeRole, LayoutEdge, NodeRole, Presentation, PresentationInput, Topology } from './types'

type Depth = PresentationInput['depth']

const EMPTY: ReadonlySet<number> = new Set()

/** Level used by the level filter: 000-level courses count as 100-level. */
export function levelGroup(level: number): number {
  return Math.max(100, Math.floor(level / 100) * 100)
}

/** Every node that must come before `index` (only immediate ones for 'direct'); excludes `index`. */
export function collectAncestors(topology: Topology, index: number, depth: Depth = 'all'): Set<number> {
  return reach(topology.preds, index, depth)
}

/** Every node that `index` unlocks (only immediate ones for 'direct'); excludes `index`. */
export function collectDescendants(topology: Topology, index: number, depth: Depth = 'all'): Set<number> {
  return reach(topology.succs, index, depth)
}

function reach(adjacency: readonly number[][], start: number, depth: Depth): Set<number> {
  const seen = new Set<number>()
  const queue = [start]
  for (let head = 0; head < queue.length; head++) {
    for (const next of adjacency[queue[head]]) {
      if (next === start || seen.has(next)) continue
      seen.add(next)
      if (depth === 'all') queue.push(next)
    }
  }
  return seen
}

interface Context {
  input: PresentationInput
  focus: number
  ancestors: ReadonlySet<number>
  descendants: ReadonlySet<number>
  directPreds: ReadonlySet<number>
  directSuccs: ReadonlySet<number>
  inProgram: readonly boolean[]
  /** A program with at least one course is active (an empty program set behaves like none). */
  program: boolean
  dimming: boolean
}

/**
 * Display classes follow design-spec 8.2:
 * - overview: `compact`, or `full` with the Titles toggle;
 * - course selected: focus, direct prerequisites and direct unlocks `full`; transitive chain nodes
 *   `full` when chain titles resolve to 'all' (or Titles is on), `compact` otherwise;
 * - program only: program courses `full`;
 * - course selected while a program is active (7.3, owner decision 19.7): program courses outside
 *   the chain are `compact` (role `program`, `inProgram`), or `hidden` with Hide unrelated;
 * - everything else while dimming: `mini`, or `hidden` with Hide unrelated;
 * - level, subject and Hide completed filters hide nodes by their own level / subject / record,
 *   but never the focus.
 */
export function computePresentation(topology: Topology, input: PresentationInput): Presentation {
  const focus = input.focusId === null ? -1 : topology.indexById.get(input.focusId) ?? -1
  const hasFocus = focus >= 0
  const programIds = input.programIds && input.programIds.size > 0 ? input.programIds : null
  const program = programIds !== null
  const dimming = hasFocus || program
  const inProgram = topology.nodes.map(node => programIds?.has(node.id) ?? false)
  const ctx: Context = {
    input,
    focus,
    ancestors: hasFocus ? collectAncestors(topology, focus, input.depth) : EMPTY,
    descendants: hasFocus ? collectDescendants(topology, focus, input.depth) : EMPTY,
    directPreds: hasFocus ? new Set(topology.preds[focus]) : EMPTY,
    directSuccs: hasFocus ? new Set(topology.succs[focus]) : EMPTY,
    inProgram,
    program,
    dimming,
  }

  const role = topology.nodes.map(node => roleOf(node.index, ctx))
  const record = topology.nodes.map(node => input.record.get(node.id) ?? null)
  const eligibility = topology.nodes.map((node, i) =>
    record[i] === 'completed' || record[i] === 'inProgress' ? null : input.eligibility?.get(node.id) ?? null)
  const transitive: DisplayClass = input.chainTitles === 'all' || input.titles ? 'full' : 'compact'
  const cls = topology.nodes.map((node, i): DisplayClass => {
    if (i !== focus && filteredOut(node.level, node.subject, record[i], input)) return 'hidden'
    if (!dimming) return input.titles ? 'full' : 'compact'
    switch (role[i]) {
      case 'focus':
      case 'prereq-direct':
      case 'unlock-direct':
        return 'full'
      case 'prereq':
      case 'unlock':
        return transitive
      case 'program':
        if (!hasFocus) return 'full'
        return input.hideUnrelated ? 'hidden' : 'compact'
    }
    return input.hideUnrelated ? 'hidden' : 'mini'
  })
  const edgeRole = topology.edges.map(edge => edgeRoleOf(edge, cls, ctx))

  return { cls, role, record, eligibility, inProgram, edgeRole, dimming }
}

function roleOf(v: number, ctx: Context): NodeRole {
  if (v === ctx.focus) return 'focus'
  if (ctx.ancestors.has(v)) return ctx.directPreds.has(v) ? 'prereq-direct' : 'prereq'
  if (ctx.descendants.has(v)) return ctx.directSuccs.has(v) ? 'unlock-direct' : 'unlock'
  return ctx.inProgram[v] ? 'program' : 'none'
}

function filteredOut(level: number, subject: string, record: string | null, input: PresentationInput): boolean {
  if (input.levels && !input.levels.has(levelGroup(level))) return true
  if (input.subjects && !input.subjects.has(subject)) return true
  return input.hideCompleted && record === 'completed'
}

/** Chain edges while a course is selected, program edges in program mode, faint otherwise. */
function edgeRoleOf({ from, to }: LayoutEdge, cls: readonly DisplayClass[], ctx: Context): EdgeRole {
  if (cls[from] === 'hidden' || cls[to] === 'hidden') return 'hidden'
  const all = ctx.input.depth === 'all'
  if (ctx.focus >= 0) {
    const upstream = (v: number) => v === ctx.focus || ctx.ancestors.has(v)
    if (upstream(from) && upstream(to)) {
      if (to === ctx.focus) return 'prereq-direct'
      if (all) return 'prereq'
    }
    if ((from === ctx.focus || ctx.descendants.has(from)) && ctx.descendants.has(to)) {
      if (from === ctx.focus) return 'unlock-direct'
      if (all) return 'unlock'
    }
  } else if (ctx.program && ctx.inProgram[from] && ctx.inProgram[to]) {
    return 'program'
  }
  // No unrelated curve is drawn while something is focused, unless "Show all connections".
  return !ctx.dimming || ctx.input.showAllEdges ? 'faint' : 'hidden'
}
