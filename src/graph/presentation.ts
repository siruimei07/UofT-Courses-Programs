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
  cls: readonly DisplayClass[]
  dimming: boolean
}

export function computePresentation(topology: Topology, input: PresentationInput): Presentation {
  const focus = input.focusId === null ? -1 : topology.indexById.get(input.focusId) ?? -1
  const hasFocus = focus >= 0
  const dimming = hasFocus || input.programIds !== null
  const inProgram = topology.nodes.map(node => input.programIds?.has(node.id) ?? false)
  const ctx: Omit<Context, 'cls'> = {
    input,
    focus,
    ancestors: hasFocus ? collectAncestors(topology, focus, input.depth) : EMPTY,
    descendants: hasFocus ? collectDescendants(topology, focus, input.depth) : EMPTY,
    directPreds: hasFocus ? new Set(topology.preds[focus]) : EMPTY,
    directSuccs: hasFocus ? new Set(topology.succs[focus]) : EMPTY,
    inProgram,
    dimming,
  }

  const role = topology.nodes.map(node => roleOf(node.index, ctx))
  const record = topology.nodes.map(node => input.record.get(node.id) ?? null)
  const eligibility = topology.nodes.map((node, i) =>
    record[i] === 'completed' || record[i] === 'inProgress' ? null : input.eligibility?.get(node.id) ?? null)
  const cls = topology.nodes.map((node, i): DisplayClass => {
    if (i !== focus && filteredOut(node.level, node.subject, record[i], input)) return 'hidden'
    if (!dimming) return 'compact'
    if (role[i] !== 'none') return 'full'
    return input.hideUnrelated ? 'hidden' : 'mini'
  })
  const edgeCtx: Context = { ...ctx, cls }
  const edgeRole = topology.edges.map(edge => edgeRoleOf(edge, edgeCtx))

  return { cls, role, record, eligibility, inProgram, edgeRole, dimming }
}

function roleOf(v: number, ctx: Omit<Context, 'cls'>): NodeRole {
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

function edgeRoleOf({ from, to }: LayoutEdge, ctx: Context): EdgeRole {
  if (ctx.cls[from] === 'hidden' || ctx.cls[to] === 'hidden') return 'hidden'
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
  } else if (ctx.inProgram[from] && ctx.inProgram[to]) {
    return 'program'
  }
  return !ctx.dimming || ctx.input.showAllEdges ? 'faint' : 'hidden'
}
