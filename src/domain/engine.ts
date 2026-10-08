// Rule engine over the frontend GraphDataset (contract: engine-types.ts). Indexes are built once
// per dataset; every call evaluates one student record and returns structured results only, which
// the UI words in the active language.
import type { GraphCourse, GraphDataset, ProgramLite, RequirementLite } from '../data/schema'
import type { Eligibility } from '../graph/types'
import type {
  CourseEngine, CourseEvaluation, CreateEngine, EvalNode, ExclusionCheck, NextCourse, ProgramGroupProgress,
  ProgramProgress,
} from './engine-types'
import {
  claimDisjoint, combine, counts, createEvalContext, evaluateRule, isFailed, isPassed,
  type CourseFacts, type Counting, type EvalContext, type RuleIndex,
} from './evaluate'
import { isPriorityOnly } from './restrictions'
import { containsOpaque, ruleCourseIds } from './rules'
import type { Rule } from './types'

export const NEXT_COURSES_LIMIT = 12

interface ExclusionIndex {
  rule: Rule
  /** Every excluded id in field order: parsed leaves, ids cited only by the text, codes absent from this calendar. */
  ids: string[]
  /** Ids that are parsed leaves of the rule; only these can block for certain. */
  parsed: ReadonlySet<string>
}

interface ProgramIndex {
  /** Per group, in program order: referenced ids present in the dataset, in dataset order. */
  groupCourseIds: string[][]
  /** Per group: ids cited by the official text but absent from the parsed rule. */
  textOnlyIds: string[][]
  /** Per group: the rule contains unparsed parts, so its structure is not trusted for expansion. */
  opaque: boolean[]
  courseIds: string[]
  courseSet: ReadonlySet<string>
  /** Course id → ids of the groups that reference it, in program order. */
  groupsOf: ReadonlyMap<string, string[]>
}

interface Candidate {
  id: string
  /** Index of the first group that led to the course. */
  rank: number
  /** Discovery order, the final tie-break. */
  seq: number
  /** Groups whose traversal reached the course, in program order. */
  via: string[]
}

interface Ranked extends NextCourse {
  tier: number
  rank: number
  seq: number
}

const EXCLUSION_ELIGIBILITY: Record<ExclusionCheck['status'], Eligibility> = { clear: 'met', blocked: 'unmet', unknown: 'unknown' }

const unique = (ids: Iterable<string>) => [...new Set(ids)]

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(value)
}

/**
 * Whether the parsed part of an exclusion is triggered by the record. Codes dropped by the parser
 * leave `true` behind, which never triggers; a cohort clause can only make a match uncertain.
 */
function exclusionTrigger(rule: Rule, ctx: EvalContext): Eligibility {
  switch (rule.kind) {
    case 'true': return 'unmet'
    case 'course': case 'minGrade': return counts(ctx.record.get(rule.courseId), 'current') ? 'met' : 'unmet'
    case 'credits': return evaluateRule(rule, ctx, 'current').status
    case 'all': case 'any': return combine(rule.kind, rule.items.map(item => exclusionTrigger(item, ctx)))
    case 'applicability': return exclusionTrigger(rule.rule, ctx) === 'unmet' ? 'unmet' : 'unknown'
    case 'permission': case 'program': case 'unknown': return 'unknown'
  }
}

/**
 * A requirement the record fails may still be met by a code absent from this calendar (a retired
 * course on an older record): the requirement then becomes unknown instead of unmet.
 */
function withRetired(node: EvalNode, requirement: Pick<RequirementLite, 'unresolved'>, ctx: EvalContext, counting: Counting): EvalNode {
  if (node.status !== 'unmet' || !requirement.unresolved?.some(id => counts(ctx.record.get(id), counting))) return node
  return { ...node, status: 'unknown' }
}

export const createEngine: CreateEngine = (dataset: GraphDataset): CourseEngine => {
  const position = new Map<string, number>()
  const byId = new Map<string, GraphCourse>()
  const facts = new Map<string, CourseFacts>()
  dataset.courses.forEach((course, i) => {
    position.set(course.id, i)
    byId.set(course.id, course)
    facts.set(course.id, { credits: course.credits, subject: course.subject, level: course.level })
  })

  const exclusions = new Map<string, ExclusionIndex>()
  const exclusionPeers = new Map<string, Set<string>>()
  /** Prerequisite id → courses whose prerequisites list it. */
  const dependents = new Map<string, Set<string>>()
  /** Course id → every course its prerequisite field cites (parsed, text-only and absent codes). */
  const prerequisiteRefs = new Map<string, string[]>()
  /** Courses whose restriction is only an enrolment-priority note (spec 19.9). */
  const priorityOnly = new Set<string>()
  for (const course of dataset.courses) {
    if (course.exclusion) {
      const parsed = ruleCourseIds(course.exclusion.rule)
      const ids = unique([...parsed, ...course.exclusion.ids, ...(course.exclusion.unresolved ?? [])]).filter(id => id !== course.id)
      exclusions.set(course.id, { rule: course.exclusion.rule, ids, parsed: new Set(parsed) })
      for (const id of ids) {
        addTo(exclusionPeers, course.id, id)
        addTo(exclusionPeers, id, course.id)
      }
    }
    if (course.prereq) {
      const ids = unique([...course.prereq.ids, ...ruleCourseIds(course.prereq.rule)]).filter(id => id !== course.id)
      for (const id of ids) addTo(dependents, id, course.id)
      prerequisiteRefs.set(course.id, unique([...ids, ...(course.prereq.unresolved ?? [])]))
    }
    if (course.restriction && isPriorityOnly(course.restriction.text)) priorityOnly.add(course.id)
  }
  const index: RuleIndex = { courses: facts, exclusionPeers }
  const byPosition = (a: string, b: string) => (position.get(a) ?? 0) - (position.get(b) ?? 0)

  // 'blocked' needs a parsed leaf that triggers the rule. A match among ids cited only by unparsed
  // text, or among codes absent from this calendar, "may exclude" ('unknown'), as does an
  // unparsed rule with no match at all.
  function exclusionCheck(courseId: string, ctx: EvalContext): ExclusionCheck | null {
    const exclusion = exclusions.get(courseId)
    if (!exclusion) return null
    const trigger = exclusionTrigger(exclusion.rule, ctx)
    // Passed or in-progress courses count; a failed attempt earns no credit and does not.
    const matches = exclusion.ids.filter(id => counts(ctx.record.get(id), 'current'))
    if (trigger === 'met') return { status: 'blocked', blockedBy: matches }
    const possible = trigger === 'unknown' ? matches : matches.filter(id => !exclusion.parsed.has(id))
    return possible.length || trigger === 'unknown' ? { status: 'unknown', blockedBy: possible } : { status: 'clear', blockedBy: [] }
  }

  function evaluateCourseIn(course: GraphCourse, ctx: EvalContext): CourseEvaluation {
    const prerequisites = course.prereq ? withRetired(evaluateRule(course.prereq.rule, ctx, 'current'), course.prereq, ctx, 'current') : null
    const corequisites = course.coreq ? withRetired(evaluateRule(course.coreq.rule, ctx, 'planned'), course.coreq, ctx, 'planned') : null
    const exclusionResult = exclusionCheck(course.id, ctx)
    // Restrictions are official text, often negative ("not open to …"), never evaluated as
    // requirements: unknown, except an enrolment-priority note, which never decides eligibility
    // and is reported as a met node that carries the text.
    const restrictions: EvalNode | null = !course.restriction ? null
      : priorityOnly.has(course.id) ? { kind: 'true', status: 'met', text: course.restriction.text }
      : { kind: 'unknown', status: 'unknown', text: course.restriction.text }
    const parts: Eligibility[] = []
    if (prerequisites) parts.push(prerequisites.status)
    if (corequisites) parts.push(corequisites.status)
    if (exclusionResult) parts.push(EXCLUSION_ELIGIBILITY[exclusionResult.status])
    if (restrictions) parts.push(restrictions.status)
    return { courseId: course.id, overall: combine('all', parts), prerequisites, corequisites, exclusions: exclusionResult, restrictions }
  }

  const programIndexes = new WeakMap<ProgramLite, ProgramIndex>()
  function programIndex(program: ProgramLite): ProgramIndex {
    const cached = programIndexes.get(program)
    if (cached) return cached
    const groupCourseIds = program.groups.map(group =>
      unique([...group.ids, ...ruleCourseIds(group.rule)]).filter(id => position.has(id)).sort(byPosition))
    const textOnlyIds = program.groups.map((group, i) => {
      const structured = new Set(ruleCourseIds(group.rule))
      return groupCourseIds[i].filter(id => !structured.has(id))
    })
    const groupsOf = new Map<string, string[]>()
    program.groups.forEach((group, i) => {
      for (const id of groupCourseIds[i]) {
        const list = groupsOf.get(id)
        if (!list) groupsOf.set(id, [group.id])
        else if (!list.includes(group.id)) list.push(group.id)
      }
    })
    const courseIds = [...groupsOf.keys()].sort(byPosition)
    const built: ProgramIndex = {
      groupCourseIds,
      textOnlyIds,
      opaque: program.groups.map(group => containsOpaque(group.rule)),
      courseIds,
      courseSet: new Set(courseIds),
      groupsOf,
    }
    programIndexes.set(program, built)
    return built
  }

  function completionStatus(program: ProgramLite, nodes: EvalNode[], ctx: EvalContext): Eligibility {
    const completion = program.groups.flatMap((group, i) => (group.category === 'completion' ? [nodes[i]] : []))
    if (!completion.length) return 'unknown'
    const status = combine('all', completion.map(node => node.status))
    if (status !== 'met') return status
    // Sharing rules between groups are not parsed: met only when no course serves two groups.
    return claimDisjoint(completion, ctx) ? 'met' : 'unknown'
  }

  return {
    eligibility(record) {
      const ctx = createEvalContext(index, record)
      const result = new Map<string, Eligibility>()
      for (const course of dataset.courses) {
        // A failed course is not passed: it may be retaken, so it stays in the map.
        const entry = record.get(course.id)
        if (isPassed(entry) || entry?.status === 'inProgress') continue
        result.set(course.id, evaluateCourseIn(course, ctx).overall)
      }
      return result
    },

    evaluateCourse(courseId, record) {
      const course = byId.get(courseId)
      if (!course) return { courseId, overall: 'unknown', prerequisites: null, corequisites: null, exclusions: null, restrictions: null }
      return evaluateCourseIn(course, createEvalContext(index, record))
    },

    programProgress(program, record): ProgramProgress {
      const info = programIndex(program)
      const ctx = createEvalContext(index, record)
      const nodes = program.groups.map(group => withRetired(evaluateRule(group.rule, ctx, 'completed'), group, ctx, 'completed'))
      const groups = program.groups.map((group, i): ProgramGroupProgress => {
        const ids = info.groupCourseIds[i]
        return {
          groupId: group.id,
          status: nodes[i].status,
          courseIds: ids,
          completed: ids.filter(id => isPassed(record.get(id))),
          inProgress: ids.filter(id => record.get(id)?.status === 'inProgress'),
          planned: ids.filter(id => record.get(id)?.status === 'planned'),
        }
      })
      return { programId: program.id, completion: completionStatus(program, nodes, ctx), groups, courseIds: info.courseIds }
    },

    nextCourses(program, record, limit = NEXT_COURSES_LIMIT) {
      if (limit <= 0) return []
      const info = programIndex(program)
      const ctx = createEvalContext(index, record)
      const evaluations = new Map<string, CourseEvaluation>()
      const evaluationOf = (course: GraphCourse) => {
        let evaluation = evaluations.get(course.id)
        if (!evaluation) evaluations.set(course.id, (evaluation = evaluateCourseIn(course, ctx)))
        return evaluation
      }
      const candidates = new Map<string, Candidate>()
      const expanded = new Set<string>()

      // Walks only the parts of an evaluated rule that are not met. Options of an OR are offered
      // without expanding their own prerequisites.
      const follow = (rule: Rule, node: EvalNode | undefined, rank: number, groupId: string, expand: boolean): void => {
        if (!node || node.status === 'met') return
        switch (rule.kind) {
          case 'all': rule.items.forEach((item, i) => follow(item, node.children?.[i], rank, groupId, expand)); break
          case 'any': rule.items.forEach((item, i) => follow(item, node.children?.[i], rank, groupId, false)); break
          case 'applicability': follow(rule.rule, node.children?.[0], rank, groupId, expand); break
          case 'course': case 'minGrade': offer(rule.courseId, rank, groupId, expand); break
          case 'credits': rule.courseIds?.forEach(id => offer(id, rank, groupId, false)); break
          default: break
        }
      }

      // Courses already on the record are never offered (a failed attempt may be retaken). Only a
      // course that is not yet eligible has its prerequisites and corequisites expanded.
      const offer = (id: string, rank: number, groupId: string, expand: boolean): void => {
        const course = byId.get(id)
        if (!course) return
        const entry = record.get(id)
        if (entry && !isFailed(entry)) return
        let candidate = candidates.get(id)
        if (!candidate) candidates.set(id, (candidate = { id, rank, seq: candidates.size, via: [] }))
        if (!candidate.via.includes(groupId)) candidate.via.push(groupId)
        if (!expand || expanded.has(id)) return
        expanded.add(id)
        const evaluation = evaluationOf(course)
        if (evaluation.overall === 'met' || evaluation.exclusions?.status === 'blocked') return
        if (course.prereq) follow(course.prereq.rule, evaluation.prerequisites ?? undefined, rank, groupId, true)
        if (course.coreq) follow(course.coreq.rule, evaluation.corequisites ?? undefined, rank, groupId, true)
      }

      program.groups.forEach((group, rank) => {
        // Planned and in-progress courses already fill a requirement for planning purposes.
        const node = withRetired(evaluateRule(group.rule, ctx, 'planned'), group, ctx, 'planned')
        if (node.status === 'met') return
        follow(group.rule, node, rank, group.id, !info.opaque[rank])
        for (const id of info.textOnlyIds[rank]) offer(id, rank, group.id, false)
      })

      const unlocksOf = (id: string) => {
        let count = 0
        for (const dependent of dependents.get(id) ?? []) if (info.courseSet.has(dependent)) count++
        return count
      }
      // Tiers: ready; unknown with a cited prerequisite taken (or none cited); unknown with none
      // of them taken; unmet.
      const tierOf = (course: GraphCourse, evaluation: CourseEvaluation): number => {
        if (evaluation.overall === 'met') return 0
        if (evaluation.overall === 'unmet') return 3
        if (!evaluation.prerequisites || evaluation.prerequisites.status === 'met') return 1
        const cited = prerequisiteRefs.get(course.id) ?? []
        return !cited.length || cited.some(id => counts(record.get(id), 'current')) ? 1 : 2
      }
      const reasonOf = (evaluation: CourseEvaluation): NextCourse['reason'] => {
        if (evaluation.overall === 'met') return 'ready'
        if (evaluation.overall === 'unknown') return 'check-requirements'
        return evaluation.prerequisites?.status !== 'unmet' && evaluation.corequisites?.status === 'unmet'
          ? 'needs-corequisites' : 'needs-prerequisites'
      }

      const ranked: Ranked[] = []
      for (const candidate of candidates.values()) {
        const course = byId.get(candidate.id)
        if (!course) continue
        const evaluation = evaluationOf(course)
        if (evaluation.exclusions?.status === 'blocked') continue
        ranked.push({
          courseId: candidate.id,
          eligibility: evaluation.overall,
          groups: info.groupsOf.get(candidate.id) ?? candidate.via,
          unlocks: unlocksOf(candidate.id),
          reason: reasonOf(evaluation),
          tier: tierOf(course, evaluation),
          rank: candidate.rank,
          seq: candidate.seq,
        })
      }
      ranked.sort((a, b) => a.tier - b.tier || b.unlocks - a.unlocks || a.rank - b.rank || a.seq - b.seq)

      // Prerequisites the course still needs: courses in the parts of its prerequisite tree that
      // are not met, and transitively theirs. Met parts (an OR already satisfied) impose nothing.
      const needs = new Map<string, ReadonlySet<string>>()
      const needsOf = (id: string): ReadonlySet<string> => {
        const known = needs.get(id)
        if (known) return known
        const found = new Set<string>()
        needs.set(id, found) // A prerequisite cycle stops here instead of recursing forever.
        const course = byId.get(id)
        const node = course?.prereq ? evaluationOf(course).prerequisites : null
        if (!course?.prereq || !node || node.status === 'met') return found
        const direct = new Set<string>()
        const collect = (rule: Rule, evaluated: EvalNode | undefined): void => {
          if (!evaluated || evaluated.status === 'met') return
          switch (rule.kind) {
            case 'all': case 'any': rule.items.forEach((item, i) => collect(item, evaluated.children?.[i])); break
            case 'applicability': collect(rule.rule, evaluated.children?.[0]); break
            case 'course': case 'minGrade': direct.add(rule.courseId); break
            case 'credits': rule.courseIds?.forEach(courseId => direct.add(courseId)); break
            default: break
          }
        }
        collect(course.prereq.rule, node)
        for (const prerequisite of direct) {
          if (prerequisite === id) continue
          found.add(prerequisite)
          if (!isPassed(record.get(prerequisite))) needsOf(prerequisite).forEach(more => found.add(more))
        }
        return found
      }

      // Best first, except that a course never precedes a listed prerequisite it still needs. On a
      // prerequisite cycle the best remaining course goes next.
      const listed = new Set(ranked.map(entry => entry.courseId))
      const pending = ranked.map(entry => ({ entry, before: [...needsOf(entry.courseId)].filter(id => id !== entry.courseId && listed.has(id)) }))
      const placed = new Set<string>()
      const ordered: NextCourse[] = []
      while (pending.length && ordered.length < limit) {
        const next = Math.max(0, pending.findIndex(item => item.before.every(id => placed.has(id))))
        const [{ entry }] = pending.splice(next, 1)
        placed.add(entry.courseId)
        ordered.push({ courseId: entry.courseId, eligibility: entry.eligibility, groups: entry.groups, unlocks: entry.unlocks, reason: entry.reason })
      }
      return ordered
    },
  }
}
