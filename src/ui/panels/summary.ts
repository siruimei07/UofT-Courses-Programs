// Chain summary of the selected course: the readout copy of design-spec 6.3 (reused by the Course
// panel), the chain lists and each course's relation to the focus. Pure; no React.
import type { GraphCourse, RequirementLite } from '../../data/schema'
import type { EvalNode } from '../../domain/engine-types'
import type { Rule } from '../../domain/types'
import { collectAncestors, collectDescendants } from '../../graph/presentation'
import type { ExcludedEdge, Topology } from '../../graph/types'

export type Relation = 'prereq-direct' | 'prereq' | 'unlock-direct' | 'unlock' | 'program' | 'none'

export interface Chain {
  focus: number
  /** Node indices sorted by course code. */
  directPreds: number[]
  earlierPreds: number[]
  directSuccs: number[]
  laterSuccs: number[]
}

export function chainOf(topology: Topology, focus: number): Chain {
  const byCode = (a: number, b: number) => topology.nodes[a].code.localeCompare(topology.nodes[b].code)
  const directPreds = new Set(topology.preds[focus])
  const directSuccs = new Set(topology.succs[focus])
  const ancestors = collectAncestors(topology, focus)
  const descendants = collectDescendants(topology, focus)
  return {
    focus,
    directPreds: [...directPreds].sort(byCode),
    earlierPreds: [...ancestors].filter(v => !directPreds.has(v)).sort(byCode),
    directSuccs: [...directSuccs].sort(byCode),
    laterSuccs: [...descendants].filter(v => !directSuccs.has(v)).sort(byCode),
  }
}

/** Relation of every chain node to the focus; nodes outside the chain are absent. */
export function relationsOf(chain: Chain): Map<number, Relation> {
  const relations = new Map<number, Relation>()
  for (const v of chain.laterSuccs) relations.set(v, 'unlock')
  for (const v of chain.directSuccs) relations.set(v, 'unlock-direct')
  for (const v of chain.earlierPreds) relations.set(v, 'prereq')
  for (const v of chain.directPreds) relations.set(v, 'prereq-direct')
  return relations
}

/** The rule below any cohort wrapper ("applicability"), which does not change its structure. */
export function unwrapRule(rule: Rule): Rule {
  let current = rule
  while (current.kind === 'applicability') current = current.rule
  return current
}

/** A top-level `unknown` rule: the panel shows the neutral "could not read" state instead of a tree. */
export function isUnparsed(rule: Rule | undefined): boolean {
  return rule !== undefined && unwrapRule(rule).kind === 'unknown'
}

/**
 * Parsed `any` nodes (top-level or nested) of a prerequisite rule, as the direct predecessors of
 * the focus among their course / minGrade leaves; groups with fewer than 2 such leaves are dropped.
 * Same rule as the card-head readout and the fork junctions (design-spec 7.4).
 */
export function anyGroups(rule: Rule | undefined, chain: Chain, indexById: ReadonlyMap<string, number>): number[][] {
  if (!rule || unwrapRule(rule).kind === 'unknown') return []
  const preds = new Set(chain.directPreds)
  const groups: number[][] = []
  const visit = (node: Rule): void => {
    if (node.kind === 'applicability') return visit(node.rule)
    if (node.kind !== 'all' && node.kind !== 'any') return
    if (node.kind === 'any') {
      const group = new Set<number>()
      for (const item of node.items) {
        if (item.kind !== 'course' && item.kind !== 'minGrade') continue
        const index = indexById.get(item.courseId)
        if (index !== undefined && preds.has(index)) group.add(index)
      }
      if (group.size >= 2) groups.push([...group].sort((a, b) => a - b))
    }
    node.items.forEach(visit)
  }
  visit(rule)
  return groups
}

export type NeedsReadout =
  | { kind: 'none' }
  | { kind: 'noCourses' }
  | { kind: 'plain' | 'someAlternatives' | 'unknown'; direct: number; total: number }
  | { kind: 'oneOf'; options: number; total: number }

/** Which readout of design-spec 6.3 describes the focus's prerequisites (same cases as the card head). */
export function needsReadout(prereq: RequirementLite | undefined, chain: Chain, indexById: ReadonlyMap<string, number>): NeedsReadout {
  const direct = chain.directPreds.length
  const total = direct + chain.earlierPreds.length
  const rule = prereq ? unwrapRule(prereq.rule) : null
  if (direct === 0) return rule && rule.kind !== 'true' ? { kind: 'noCourses' } : { kind: 'none' }
  if (rule?.kind === 'unknown') return { kind: 'unknown', direct, total }
  const groups = anyGroups(prereq?.rule, chain, indexById)
  if (!groups.length) return { kind: 'plain', direct, total }
  // "Needs 1 of N" only when one top-level `any` group accounts for every direct prerequisite.
  if (groups.length === 1 && rule?.kind === 'any' && groups[0].length === direct) return { kind: 'oneOf', options: direct, total }
  return { kind: 'someAlternatives', direct, total }
}

export type UnlocksReadout = { kind: 'none' } | { kind: 'plain'; direct: number; total: number }

export function unlocksReadout(chain: Chain): UnlocksReadout {
  const direct = chain.directSuccs.length
  return direct === 0 ? { kind: 'none' } : { kind: 'plain', direct, total: direct + chain.laterSuccs.length }
}

export interface Mention {
  id: string
  reason: ExcludedEdge['reason'] | 'mentioned'
}

/**
 * "Also mentioned, not drawn": references of the focus kept out of the layout (cycle breakers and
 * higher-level alternatives) plus codes the calendar only mentions.
 */
export function mentionsOf(course: GraphCourse, topology: Topology, focus: number, fields: readonly (RequirementLite | undefined)[]): Mention[] {
  const mentions = new Map<string, Mention>()
  for (const edge of topology.excludedEdges) {
    if (edge.to !== focus) continue
    const id = topology.nodes[edge.from].id
    if (!mentions.has(id)) mentions.set(id, { id, reason: edge.reason })
  }
  for (const field of fields) {
    for (const id of field?.mentioned ?? []) {
      if (id !== course.id && !mentions.has(id)) mentions.set(id, { id, reason: 'mentioned' })
    }
  }
  return [...mentions.values()]
}

/**
 * Same-campus references that are not in this calendar: the `unresolved` lists, plus ids that
 * point at a missing course (older datasets kept them in `ids`).
 */
export function unresolvedOf(course: GraphCourse, has: (id: string) => boolean): string[] {
  const campus = course.id.slice(0, course.id.indexOf(':') + 1)
  const ids = new Set<string>()
  for (const field of [course.prereq, course.coreq, course.exclusion, course.recommended, course.restriction]) {
    if (!field) continue
    for (const id of field.unresolved ?? []) ids.add(id)
    for (const id of [...field.ids, ...(field.mentioned ?? [])]) if (id.startsWith(campus) && !has(id)) ids.add(id)
  }
  return [...ids].sort()
}

/** Unmet course leaves of an evaluated requirement, in document order, for "Needs MAT135H5". */
export function missingCourses(node: EvalNode | null): { ids: string[]; oneOf: boolean } {
  if (!node || node.status === 'met') return { ids: [], oneOf: false }
  const ids: string[] = []
  const walk = (current: EvalNode) => {
    if (current.status === 'met') return
    if ((current.kind === 'course' || current.kind === 'minGrade') && current.courseId) {
      if (!ids.includes(current.courseId)) ids.push(current.courseId)
    }
    current.children?.forEach(walk)
  }
  walk(node)
  return { ids, oneOf: unwrapEval(node).kind === 'any' }
}

/** A rule as an unevaluated tree (every status unknown), used when no evaluation is available. */
export function ruleAsEval(rule: Rule): EvalNode {
  switch (rule.kind) {
    case 'true':
      return { kind: 'true', status: 'met' }
    case 'all':
    case 'any':
      return { kind: rule.kind, status: 'unknown', children: rule.items.map(ruleAsEval) }
    case 'course':
      return { kind: 'course', status: 'unknown', courseId: rule.courseId }
    case 'minGrade':
      return { kind: 'minGrade', status: 'unknown', courseId: rule.courseId, minimum: rule.minimum }
    case 'credits':
      return { kind: 'credits', status: 'unknown', minimum: rule.minimum }
    case 'permission':
      return { kind: 'permission', status: 'unknown', text: rule.text }
    case 'program':
      return { kind: 'program', status: 'unknown', text: rule.programId }
    case 'unknown':
      return { kind: 'unknown', status: 'unknown', text: rule.text }
    case 'applicability':
      return { kind: 'applicability', status: 'unknown', text: rule.cohort, children: [ruleAsEval(rule.rule)] }
  }
}

/** EvalNode counterpart of unwrapRule. */
export function unwrapEval(node: EvalNode): EvalNode {
  const children = node.children ?? []
  if ((node.kind === 'applicability' || node.kind === 'all' || node.kind === 'any') && children.length === 1) {
    return unwrapEval(children[0])
  }
  return node
}
