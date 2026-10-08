// Rule evaluator core: three-valued AND / OR over the Rule AST with the record semantics of
// engine-types.ts. Returns EvalNode trees that mirror the AST node for node; never prose.
import type { Eligibility } from '../graph/types'
import type { EvalNode, RecordEntryLike, StudentRecord } from './engine-types'
import type { Rule } from './types'

/**
 * Which record statuses satisfy a course reference:
 *   completed  passed courses only (program progress);
 *   current    plus courses in progress (prerequisites: "once current courses are finished");
 *   planned    plus planned courses (corequisites, and the plan behind "take next").
 */
export type Counting = 'completed' | 'current' | 'planned'

export interface CourseFacts {
  credits: number
  subject: string
  level: number
}

/** Dataset facts the evaluator needs; built once per dataset by the engine. */
export interface RuleIndex {
  courses: ReadonlyMap<string, CourseFacts>
  /** Symmetric exclusion pairs: two members never both earn credit. */
  exclusionPeers: ReadonlyMap<string, ReadonlySet<string>>
}

interface CreditEntry {
  id: string
  /** NaN when the code of a course outside the dataset cannot be read. */
  credits: number
  /** Absent for courses outside the loaded dataset. */
  facts?: CourseFacts
}

export interface EvalContext {
  index: RuleIndex
  record: StudentRecord
  pools: Partial<Record<Counting, CreditEntry[]>>
  /** Credits nodes → the course ids counted as earned (program overlap checks). */
  creditUse: WeakMap<EvalNode, string[]>
}

export function createEvalContext(index: RuleIndex, record: StudentRecord): EvalContext {
  return { index, record, pools: {}, creditUse: new WeakMap() }
}

/** UTM Calendar: 0–49 is F. A completed course without a grade is a declared pass. */
export const PASS_GRADE = 50
const EPSILON = 1e-9

export const isFailed = (entry: RecordEntryLike): boolean =>
  entry.status === 'completed' && entry.grade !== undefined && entry.grade < PASS_GRADE

export const isPassed = (entry: RecordEntryLike | undefined): boolean =>
  entry?.status === 'completed' && !isFailed(entry)

export function counts(entry: RecordEntryLike | undefined, counting: Counting): boolean {
  if (!entry) return false
  switch (entry.status) {
    case 'completed': return !isFailed(entry)
    case 'inProgress': return counting !== 'completed'
    case 'planned': return counting === 'planned'
  }
}

export function combine(kind: 'all' | 'any', statuses: readonly Eligibility[]): Eligibility {
  if (kind === 'all') {
    if (statuses.includes('unmet')) return 'unmet'
    return statuses.every(status => status === 'met') ? 'met' : 'unknown'
  }
  if (statuses.includes('met')) return 'met'
  return statuses.every(status => status === 'unmet') ? 'unmet' : 'unknown'
}

function minGradeStatus(entry: RecordEntryLike | undefined, minimum: number, counting: Counting): Eligibility {
  if (!entry || !counts(entry, counting)) return 'unmet'
  // In progress or planned: the final grade is not known yet.
  if (entry.status !== 'completed' || entry.grade === undefined) return 'unknown'
  return entry.grade >= minimum ? 'met' : 'unmet'
}

const EXTERNAL_CODE = /^[A-Z]{3}[A-Z0-9]\d{2}([HY])\d$/

/** H = half credit, Y = full credit, the same on every U of T campus. */
function externalCredits(id: string): number {
  const match = EXTERNAL_CODE.exec(id.slice(id.indexOf(':') + 1))
  return match ? (match[1] === 'Y' ? 1 : 0.5) : Number.NaN
}

function creditPool(ctx: EvalContext, counting: Counting): CreditEntry[] {
  let pool = ctx.pools[counting]
  if (!pool) {
    pool = []
    for (const [id, entry] of ctx.record) {
      if (!counts(entry, counting)) continue
      const facts = ctx.index.courses.get(id)
      pool.push(facts ? { id, credits: facts.credits, facts } : { id, credits: externalCredits(id) })
    }
    ctx.pools[counting] = pool
  }
  return pool
}

/**
 * Credits earned towards a minimum, each course counted once. Courses that exclude each other
 * never both count, so each exclusion-connected group contributes only its largest credit value
 * to the confirmed total (a lower bound). Courses outside the dataset count when the rule lists
 * them or has no scope; under a subject or level scope they stay uncertain.
 */
function evaluateCredits(rule: Extract<Rule, { kind: 'credits' }>, ctx: EvalContext, counting: Counting) {
  const listed = rule.courseIds ? new Set(rule.courseIds) : undefined
  const scoped = rule.subject !== undefined || rule.level !== undefined
  const certain: CreditEntry[] = []
  let uncertainCredits = 0
  let unknownAmount = false
  for (const entry of creditPool(ctx, counting)) {
    if (listed && !listed.has(entry.id)) continue
    if (entry.facts) {
      if (rule.subject !== undefined && entry.facts.subject !== rule.subject) continue
      if (rule.level !== undefined && entry.facts.level < rule.level) continue
    } else if (Number.isNaN(entry.credits)) {
      unknownAmount = true
      continue
    } else if (!listed && scoped) {
      uncertainCredits += entry.credits
      continue
    }
    certain.push(entry)
  }
  const component = certain.map((_, i) => i)
  const root = (i: number): number => (component[i] === i ? i : (component[i] = root(component[i])))
  for (let i = 0; i < certain.length; i++) {
    const peers = ctx.index.exclusionPeers.get(certain[i].id)
    if (!peers) continue
    for (let j = 0; j < certain.length; j++) {
      if (j !== i && peers.has(certain[j].id)) component[root(j)] = root(i)
    }
  }
  const largest = new Map<number, number>()
  let potential = uncertainCredits
  certain.forEach((entry, i) => {
    const r = root(i)
    largest.set(r, Math.max(largest.get(r) ?? 0, entry.credits))
    potential += entry.credits
  })
  let earned = 0
  for (const credits of largest.values()) earned += credits
  const status: Eligibility = earned + EPSILON >= rule.minimum ? 'met'
    : unknownAmount || potential + EPSILON >= rule.minimum ? 'unknown' : 'unmet'
  return { status, earned, used: certain.map(entry => entry.id) }
}

export function evaluateRule(rule: Rule, ctx: EvalContext, counting: Counting): EvalNode {
  switch (rule.kind) {
    case 'true': return { kind: 'true', status: 'met' }
    case 'all': case 'any': {
      const children = rule.items.map(item => evaluateRule(item, ctx, counting))
      return { kind: rule.kind, status: combine(rule.kind, children.map(child => child.status)), children }
    }
    case 'course':
      return { kind: 'course', status: counts(ctx.record.get(rule.courseId), counting) ? 'met' : 'unmet', courseId: rule.courseId }
    case 'minGrade':
      return {
        kind: 'minGrade', status: minGradeStatus(ctx.record.get(rule.courseId), rule.minimum, counting),
        courseId: rule.courseId, minimum: rule.minimum,
      }
    case 'credits': {
      const { status, earned, used } = evaluateCredits(rule, ctx, counting)
      const node: EvalNode = { kind: 'credits', status, minimum: rule.minimum, earned }
      ctx.creditUse.set(node, used)
      return node
    }
    case 'permission': return { kind: 'permission', status: 'unknown', text: rule.text }
    case 'program': return { kind: 'program', status: 'unknown', text: rule.programId }
    case 'unknown': return { kind: 'unknown', status: 'unknown', text: rule.text }
    case 'applicability': {
      const inner = evaluateRule(rule.rule, ctx, counting)
      // The record carries no cohort. A met clause holds either way (it applies and is met, or it
      // does not apply); otherwise it depends on whether the student belongs to the cohort.
      return { kind: 'applicability', status: inner.status === 'met' ? 'met' : 'unknown', text: rule.cohort, children: [inner] }
    }
  }
}

/**
 * Courses that actually satisfy a met node: every child of `all`, the first met option of `any`,
 * the counted records of `credits`. Empty for nodes that are not met.
 */
export function usedCourses(node: EvalNode, ctx: EvalContext): string[] {
  if (node.status !== 'met') return []
  switch (node.kind) {
    case 'course': case 'minGrade': return node.courseId ? [node.courseId] : []
    case 'credits': return ctx.creditUse.get(node) ?? []
    case 'all': case 'applicability': return (node.children ?? []).flatMap(child => usedCourses(child, ctx))
    case 'any': {
      const first = node.children?.find(child => child.status === 'met')
      return first ? usedCourses(first, ctx) : []
    }
    default: return []
  }
}
