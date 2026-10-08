// Rule engine over the frontend GraphDataset (contract: engine-types.ts). Indexes are built once
// per dataset; every call evaluates one student record and returns structured results only, which
// the UI words in the active language.
import type { GraphCourse, GraphDataset, ProgramLite } from '../data/schema'
import type { Eligibility } from '../graph/types'
import type {
  CourseEngine, CourseEvaluation, CreateEngine, EvalNode, ExclusionCheck, NextCourse, ProgramGroupProgress,
  ProgramProgress, StudentRecord,
} from './engine-types'
import {
  combine, counts, createEvalContext, evaluateRule, isFailed, isPassed, usedCourses,
  type CourseFacts, type EvalContext, type RuleIndex,
} from './evaluate'
import { containsOpaque, ruleCourseIds } from './rules'
import type { Rule } from './types'

export const NEXT_COURSES_LIMIT = 12

interface ExclusionIndex {
  /** Excluded course ids (the course itself removed). */
  ids: string[]
  /** Part of the official wording is not parsed, so a clear record cannot be confirmed. */
  opaque: boolean
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

const EXCLUSION_ELIGIBILITY: Record<ExclusionCheck['status'], Eligibility> = { clear: 'met', blocked: 'unmet', unknown: 'unknown' }
const REASON: Record<Eligibility, NextCourse['reason']> = { met: 'ready', unmet: 'needs-prerequisites', unknown: 'check-requirements' }

const unique = (ids: Iterable<string>) => [...new Set(ids)]

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(value)
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
  for (const course of dataset.courses) {
    if (course.exclusion) {
      const ids = unique([...course.exclusion.ids, ...ruleCourseIds(course.exclusion.rule)]).filter(id => id !== course.id)
      exclusions.set(course.id, { ids, opaque: containsOpaque(course.exclusion.rule) })
      for (const id of ids) {
        addTo(exclusionPeers, course.id, id)
        addTo(exclusionPeers, id, course.id)
      }
    }
    if (course.prereq) {
      for (const id of [...course.prereq.ids, ...ruleCourseIds(course.prereq.rule)]) {
        if (id !== course.id) addTo(dependents, id, course.id)
      }
    }
  }
  const index: RuleIndex = { courses: facts, exclusionPeers }
  const byPosition = (a: string, b: string) => (position.get(a) ?? 0) - (position.get(b) ?? 0)

  function exclusionCheck(courseId: string, record: StudentRecord): ExclusionCheck | null {
    const exclusion = exclusions.get(courseId)
    if (!exclusion) return null
    // Passed or in-progress courses block; a failed attempt earns no credit and does not.
    const blockedBy = exclusion.ids.filter(id => counts(record.get(id), 'current'))
    return { status: blockedBy.length ? 'blocked' : exclusion.opaque ? 'unknown' : 'clear', blockedBy }
  }

  function evaluateCourseIn(course: GraphCourse, ctx: EvalContext): CourseEvaluation {
    const prerequisites = course.prereq ? evaluateRule(course.prereq.rule, ctx, 'current') : null
    const corequisites = course.coreq ? evaluateRule(course.coreq.rule, ctx, 'planned') : null
    const exclusionResult = exclusionCheck(course.id, ctx.record)
    // Restrictions are opaque official text (often negative: "not open to …"), never requirements.
    const restrictions: EvalNode | null = course.restriction
      ? { kind: 'unknown', status: 'unknown', text: course.restriction.text }
      : null
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
    // Each group may be met by the same course; sharing rules between groups are not parsed.
    const used = new Set<string>()
    for (const node of completion) {
      for (const id of new Set(usedCourses(node, ctx))) {
        if (used.has(id)) return 'unknown'
        used.add(id)
      }
    }
    return 'met'
  }

  return {
    eligibility(record) {
      const ctx = createEvalContext(index, record)
      const result = new Map<string, Eligibility>()
      for (const course of dataset.courses) {
        const status = record.get(course.id)?.status
        if (status === 'completed' || status === 'inProgress') continue
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
      const nodes = program.groups.map(group => evaluateRule(group.rule, ctx, 'completed'))
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
        const node = evaluateRule(group.rule, ctx, 'planned')
        if (node.status === 'met') return
        follow(group.rule, node, rank, group.id, !info.opaque[rank])
        for (const id of info.textOnlyIds[rank]) offer(id, rank, group.id, false)
      })

      const unlocksOf = (id: string) => {
        let count = 0
        for (const dependent of dependents.get(id) ?? []) if (info.courseSet.has(dependent)) count++
        return count
      }
      const ranked: (NextCourse & { rank: number; seq: number })[] = []
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
          reason: REASON[evaluation.overall],
          rank: candidate.rank,
          seq: candidate.seq,
        })
      }
      ranked.sort((a, b) =>
        Number(b.eligibility === 'met') - Number(a.eligibility === 'met') || b.unlocks - a.unlocks || a.rank - b.rank || a.seq - b.seq)
      return ranked.slice(0, limit).map(({ courseId, eligibility, groups, unlocks, reason }) => ({ courseId, eligibility, groups, unlocks, reason }))
    },
  }
}
