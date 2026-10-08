// Chain summary of the selected course: the chain lists, each course's relation to the focus and
// the "Needs …" reasons of evaluated requirements. Pure; no React. What a course needs is
// classified by src/app/readout.ts (`classifyRequirements`), shared with the card head.
import { directPreds as directPredsOf, unwrapRule } from '../../app/readout'
import type { GraphCourse, RequirementLite } from '../../data/schema'
import type { CourseEvaluation, EvalNode, ExclusionCheck, NextCourse } from '../../domain/engine-types'
import type { Rule } from '../../domain/types'
import { collectAncestors, collectDescendants } from '../../graph/presentation'
import type { ExcludedEdge, Topology } from '../../graph/types'
import { format } from '../../i18n'
import { codeList } from './format'
import type { PanelStrings } from './strings'

export type Relation = 'prereq-direct' | 'prereq' | 'unlock-direct' | 'unlock' | 'program' | 'none'

export interface Chain {
  focus: number
  /** Node indices sorted by course code. Prerequisite edges into the focus. */
  directPreds: number[]
  /** Corequisite edges into the focus (taken together) that are not also prerequisites. */
  directCoreqs: number[]
  earlierPreds: number[]
  directSuccs: number[]
  laterSuccs: number[]
}

export function chainOf(topology: Topology, focus: number): Chain {
  const byCode = (a: number, b: number) => topology.nodes[a].code.localeCompare(topology.nodes[b].code)
  const direct = directPredsOf(topology, focus)
  const prereqs = new Set(direct.prereq)
  const coreqs = new Set(direct.coreq.filter(v => !prereqs.has(v)))
  const directSuccs = new Set(topology.succs[focus])
  const ancestors = collectAncestors(topology, focus)
  const descendants = collectDescendants(topology, focus)
  return {
    focus,
    directPreds: [...prereqs].sort(byCode),
    directCoreqs: [...coreqs].sort(byCode),
    earlierPreds: [...ancestors].filter(v => !prereqs.has(v) && !coreqs.has(v)).sort(byCode),
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
  for (const v of chain.directCoreqs) relations.set(v, 'prereq-direct')
  for (const v of chain.directPreds) relations.set(v, 'prereq-direct')
  return relations
}

/** A top-level `unknown` rule: the panel shows the neutral "could not read" state instead of a tree. */
export function isUnparsed(rule: Rule | undefined): boolean {
  return rule !== undefined && unwrapRule(rule).kind === 'unknown'
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

export interface MissingCourses {
  /** Unmet courses that are each required, in document order. */
  required: string[]
  /** Unmet "one of" groups (top-level or nested), each listing its unmet options. */
  choices: string[][]
}

const courseLeafId = (node: EvalNode): string | null =>
  (node.kind === 'course' || node.kind === 'minGrade') && node.courseId ? node.courseId : null

/**
 * Unmet course leaves of an evaluated requirement for "Needs MAT135H5" reasons. Every unmet `any`
 * node becomes one choice (its options flattened), wherever it sits, so `all(any(A, B), C)` reads
 * "C; one of A, B" and never as if A and B were both required.
 */
export function missingCourses(node: EvalNode | null): MissingCourses {
  const required: string[] = []
  const choices: string[][] = []
  const optionsOf = (current: EvalNode, out: string[]) => {
    if (current.status === 'met') return
    const id = courseLeafId(current)
    if (id) {
      if (!out.includes(id)) out.push(id)
      return
    }
    current.children?.forEach(child => optionsOf(child, out))
  }
  const walk = (current: EvalNode) => {
    if (current.status === 'met') return
    const id = courseLeafId(current)
    if (id) {
      if (!required.includes(id)) required.push(id)
    } else if (current.kind === 'any') {
      const options: string[] = []
      optionsOf(current, options)
      if (options.length > 1) choices.push(options)
      else if (options.length === 1 && !required.includes(options[0])) required.push(options[0])
    } else {
      current.children?.forEach(walk)
    }
  }
  if (node) walk(node)
  return { required, choices }
}

/**
 * One-line list of what is missing: "CSC108H5; one of MAT135H5, MAT137Y5" (Chinese:
 * "CSC108H5；MAT135H5、MAT137Y5 中任一门"), at most `max` codes per part and two parts.
 * Null when no course is listed.
 */
export function missingText(missing: MissingCourses, s: PanelStrings, max = 2): string | null {
  const parts: string[] = []
  if (missing.required.length) parts.push(codeList(missing.required, max, s))
  for (const options of missing.choices) parts.push(format(s.oneOfCodes, { codes: codeList(options, max, s) }))
  if (!parts.length) return null
  const shown = parts.slice(0, 2).join(s.partSep)
  return parts.length > 2 ? format(s.codesMore, { codes: shown, n: parts.length - 2 }) : shown
}

/**
 * The exclusion row under the official text: a parsed exclusion matched by the record blocks the
 * course (red); a possible match ('unknown': unparsed text, codes absent from this calendar) is a
 * soft "May exclude" note. Null when nothing on the record is involved.
 */
export function exclusionNote(check: ExclusionCheck | null | undefined): { tone: 'blocked' | 'maybe'; ids: string[] } | null {
  if (!check || check.status === 'clear' || !check.blockedBy.length) return null
  return { tone: check.status === 'blocked' ? 'blocked' : 'maybe', ids: check.blockedBy }
}

/**
 * One-line reason of a "Take next" row: the engine's reason plus what the evaluation still misses
 * ("Needs CSC108H5; one of MAT135H5, MAT137Y5", "Take with CSC108H5").
 */
export function nextReason(reason: NextCourse['reason'], evaluation: CourseEvaluation | null, s: PanelStrings): string {
  if (reason === 'ready') return s.reasonReady
  if (reason === 'check-requirements') return s.reasonCheck
  const prereqs = missingText(missingCourses(evaluation?.prerequisites ?? null), s)
  const coreqs = missingText(missingCourses(evaluation?.corequisites ?? null), s)
  if (reason === 'needs-prerequisites') {
    if (prereqs) return format(s.reasonNeeds, { codes: prereqs })
    // An engine that reports an unmet corequisite as 'needs-prerequisites' still says why.
    return coreqs ? format(s.reasonCoreq, { codes: coreqs }) : s.reasonNeedsSome
  }
  return coreqs ? format(s.reasonCoreq, { codes: coreqs }) : s.reasonCoreqSome
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
