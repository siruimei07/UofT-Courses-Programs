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
  /** Credits nodes → the records whose credits certainly count towards them (program overlap checks). */
  creditUse: WeakMap<EvalNode, CreditEntry[]>
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
 * never both count, and which one keeps the credit is not known, so each exclusion-connected
 * group contributes only its smallest credit value to the confirmed total (a lower bound); the
 * upper bound counts every course. Courses outside the dataset count when the rule lists them or
 * has no scope; under a subject or level scope they stay uncertain.
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
  const smallest = new Map<number, number>()
  let potential = uncertainCredits
  certain.forEach((entry, i) => {
    const r = root(i)
    smallest.set(r, Math.min(smallest.get(r) ?? Number.POSITIVE_INFINITY, entry.credits))
    potential += entry.credits
  })
  let earned = 0
  for (const credits of smallest.values()) earned += credits
  const status: Eligibility = earned + EPSILON >= rule.minimum ? 'met'
    : unknownAmount || potential + EPSILON >= rule.minimum ? 'unknown' : 'unmet'
  return { status, earned, certain }
}

/**
 * A cohort clause ("For students entering in 2027-28: …") cannot be checked: the record has no
 * cohort. Where the clause stands alone or inside an AND, a clause that does not apply holds
 * vacuously, so a met rule is met either way and anything else is unknown. Inside an OR, a clause
 * that does not apply is no option at all, so a met rule only makes the branch unknown, while an
 * unmet rule fails either way.
 */
function applicabilityStatus(inner: Eligibility, inAny: boolean): Eligibility {
  if (inAny) return inner === 'met' ? 'unknown' : inner
  return inner === 'met' ? 'met' : 'unknown'
}

function evaluateNode(rule: Rule, ctx: EvalContext, counting: Counting, inAny: boolean): EvalNode {
  switch (rule.kind) {
    case 'true': return { kind: 'true', status: 'met' }
    case 'all': case 'any': {
      const children = rule.items.map(item => evaluateNode(item, ctx, counting, rule.kind === 'any'))
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
      const { status, earned, certain } = evaluateCredits(rule, ctx, counting)
      const node: EvalNode = { kind: 'credits', status, minimum: rule.minimum, earned }
      ctx.creditUse.set(node, certain)
      return node
    }
    case 'permission': return { kind: 'permission', status: 'unknown', text: rule.text }
    case 'program': return { kind: 'program', status: 'unknown', text: rule.programId }
    case 'unknown': return { kind: 'unknown', status: 'unknown', text: rule.text }
    case 'applicability': {
      const inner = evaluateNode(rule.rule, ctx, counting, false)
      return { kind: 'applicability', status: applicabilityStatus(inner.status, inAny), text: rule.cohort, children: [inner] }
    }
  }
}

export function evaluateRule(rule: Rule, ctx: EvalContext, counting: Counting): EvalNode {
  return evaluateNode(rule, ctx, counting, false)
}

/**
 * Picks the records a met credits node uses: smallest credit values first, skipping courses
 * already claimed and courses excluded by one already picked, until the minimum is reached.
 * Null when the remaining records cannot reach it.
 */
function pickCredits(node: EvalNode, ctx: EvalContext, claimed: ReadonlySet<string>): string[] | null {
  const minimum = node.minimum ?? 0
  const entries = (ctx.creditUse.get(node) ?? []).filter(entry => !claimed.has(entry.id)).sort((a, b) => a.credits - b.credits)
  const picked: string[] = []
  let total = 0
  for (const entry of entries) {
    if (total + EPSILON >= minimum) break
    const peers = ctx.index.exclusionPeers.get(entry.id)
    if (peers && picked.some(id => peers.has(id))) continue
    picked.push(entry.id)
    total += entry.credits
  }
  return total + EPSILON >= minimum ? picked : null
}

/**
 * Claims the course leaves of a met node (every child of `all`). Credits nodes are deferred to
 * `credits`; `any` nodes are deferred to `choices` when given, otherwise decided on the spot.
 * False when a course is already claimed.
 */
function walk(node: EvalNode, claimed: Set<string>, choices: EvalNode[] | null, credits: EvalNode[]): boolean {
  if (node.status !== 'met') return true
  switch (node.kind) {
    case 'course': case 'minGrade':
      if (!node.courseId) return true
      if (claimed.has(node.courseId)) return false
      claimed.add(node.courseId)
      return true
    case 'credits':
      credits.push(node)
      return true
    case 'all': case 'applicability':
      return (node.children ?? []).every(child => walk(child, claimed, choices, credits))
    case 'any':
      if (choices) {
        choices.push(node)
        return true
      }
      return choose(node, claimed, credits)
    default: return true
  }
}

/** Takes the first met option of an OR whose courses are not claimed yet. */
function choose(node: EvalNode, claimed: Set<string>, credits: EvalNode[]): boolean {
  for (const child of node.children ?? []) {
    if (child.status !== 'met') continue
    const trial = new Set(claimed)
    const trialCredits: EvalNode[] = []
    if (!walk(child, trial, null, trialCredits)) continue
    trial.forEach(id => claimed.add(id))
    credits.push(...trialCredits)
    return true
  }
  return false
}

/**
 * Finds courses that satisfy every one of several met nodes with no course used twice (program
 * groups share no course unless the calendar says so). Required courses are claimed first, then
 * the options of each OR, then credit amounts from the records left. Returns the courses used,
 * or null when this greedy search finds no disjoint assignment (the caller then reports unknown,
 * never a false "met").
 */
export function claimDisjoint(nodes: readonly EvalNode[], ctx: EvalContext): string[] | null {
  const claimed = new Set<string>()
  const choices: EvalNode[] = []
  const credits: EvalNode[] = []
  if (!nodes.every(node => walk(node, claimed, choices, credits))) return null
  if (!choices.every(node => choose(node, claimed, credits))) return null
  for (const node of credits) {
    const picked = pickCredits(node, ctx, claimed)
    if (!picked) return null
    picked.forEach(id => claimed.add(id))
  }
  return [...claimed]
}
