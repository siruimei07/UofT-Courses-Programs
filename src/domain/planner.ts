import type { Catalog, Course, Evaluation, Program, Recommendation, Rule, Status, StudentCourse, StudentProfile } from './types'

export interface EvaluationOptions { allowInProgress?: boolean }
export interface Eligibility extends Evaluation {
  prerequisite: Evaluation
  corequisite: Evaluation
  exclusion: Evaluation
  restrictions: Evaluation
  recommended: Evaluation
}
export interface ProgramEvaluation extends Evaluation {
  admission: Evaluation
  completion: Evaluation
  groups: Array<{ id: string; label: string; category: 'admission' | 'completion'; evaluation: Evaluation }>
}

interface Context {
  profile: StudentProfile
  courses: ReadonlyMap<string, Course>
  records: ReadonlyMap<string, StudentCourse>
  creditConflictIds?: Set<string>
}
const unique = (values: string[]) => [...new Set(values)]
const result = (status: Status, reason: string, missing: string[] = []): Evaluation => ({ status, reasons: reason ? [reason] : [], missing })
const courseCode = (id: string) => id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
// UTM Calendar: 0–49 is F; no numeric grade means the user explicitly declares a pass.
const passed = (record: StudentCourse | undefined) => record?.status === 'completed' && (record.grade === undefined || record.grade >= 50)

function context(profile: StudentProfile, courses: readonly Course[]): Context {
  const records = new Map<string, StudentCourse>()
  const order = { completed: 3, inProgress: 2, planned: 1 }
  for (const record of profile.courses) {
    const existing = records.get(record.courseId)
    if (!existing || order[record.status] > order[existing.status] ||
      (record.status === existing.status && (record.grade ?? -1) > (existing.grade ?? -1))) records.set(record.courseId, record)
  }
  return { profile, courses: new Map(courses.map(course => [course.id, course])), records }
}

function combine(evaluations: Evaluation[], kind: 'all' | 'any'): Evaluation {
  const status: Status = kind === 'all'
    ? evaluations.some(e => e.status === 'unmet') ? 'unmet' : evaluations.every(e => e.status === 'met') ? 'met' : 'unknown'
    : evaluations.some(e => e.status === 'met') ? 'met' : evaluations.every(e => e.status === 'unmet') ? 'unmet' : 'unknown'
  const relevant = kind === 'any' && status === 'met' ? evaluations.filter(e => e.status === 'met') : evaluations
  return {
    status,
    reasons: unique(relevant.flatMap(e => e.reasons)),
    missing: status === 'met' ? [] : unique(relevant.filter(e => e.status !== 'met').flatMap(e => e.missing)),
  }
}

function courseEvaluation(id: string, ctx: Context, allowInProgress: boolean): Evaluation {
  const record = ctx.records.get(id)
  const name = courseCode(id)
  if (passed(record)) return result('met', `已记录通过 ${name}。`)
  if (record?.status === 'completed') return result('unmet', `${name} 已记录 ${record.grade}%，低于通过要求 50%。`, [name])
  if (record?.status === 'inProgress' && allowInProgress) return result('met', `${name} 正在修读，可用于此并修条件。`)
  if (record) return result('unmet', `${name} ${record.status === 'planned' ? '仅在计划中' : '正在修读'}，尚未完成。`, [name])
  return ctx.profile.recordComplete
    ? result('unmet', `完整修课记录中未完成 ${name}。`, [name])
    : result('unknown', `尚未确认是否完成 ${name}；修课记录未声明完整。`, [name])
}

function creditConflicts(ctx: Context): Set<string> {
  if (ctx.creditConflictIds) return ctx.creditConflictIds
  const conflicts = new Set<string>()
  for (const [id, record] of ctx.records) {
    if (!passed(record)) continue
    const course = ctx.courses.get(id)
    if (!course || course.exclusions.rule.kind === 'true') continue
    for (const excluded of unique([...course.exclusions.courseIds, ...ruleCourseIds(course.exclusions.rule)])) {
      if (excluded !== id && passed(ctx.records.get(excluded))) {
        // Credit allocation between excluded courses is not the same as course identity.
        // Keep both records, but require the accepted-credit allocation to be confirmed.
        conflicts.add(id)
        conflicts.add(excluded)
      }
    }
  }
  ctx.creditConflictIds = conflicts
  return conflicts
}

function evaluate(rule: Rule, ctx: Context, options: EvaluationOptions = {}): Evaluation {
  switch (rule.kind) {
    case 'true': return result('met', '')
    case 'all': case 'any': return combine(rule.items.map(item => evaluate(item, ctx, options)), rule.kind)
    case 'course': return courseEvaluation(rule.courseId, ctx, options.allowInProgress ?? false)
    case 'minGrade': {
      const completion = courseEvaluation(rule.courseId, ctx, options.allowInProgress ?? false)
      if (completion.status !== 'met') return completion
      const record = ctx.records.get(rule.courseId)
      const label = `${courseCode(rule.courseId)} ≥ ${rule.minimum}%`
      if (record?.grade === undefined || record.status !== 'completed') return result('unknown', `${label}：尚未提供已完成课程的最终成绩。`, [label])
      return record.grade >= rule.minimum ? result('met', `${label}，已记录 ${record.grade}%。`) : result('unmet', `${label}，已记录 ${record.grade}%。`, [label])
    }
    case 'credits': {
      const selectedIds = rule.courseIds === undefined ? undefined : new Set(rule.courseIds)
      const conflicts = creditConflicts(ctx)
      let confirmed = 0
      let uncertain = false
      for (const [id, record] of ctx.records) {
        if (!passed(record) || (selectedIds && !selectedIds.has(id))) continue
        const course = ctx.courses.get(id)
        if (!course) { uncertain = true; continue }
        if (rule.subject && course.subject !== rule.subject) continue
        if (rule.level !== undefined && course.level < rule.level) continue
        if (conflicts.has(id)) { uncertain = true; continue }
        confirmed += course.credits
      }
      const unscoped = selectedIds === undefined && !rule.subject && rule.level === undefined
      if (unscoped && ctx.profile.completedCredits !== undefined) confirmed = Math.max(confirmed, ctx.profile.completedCredits)
      const scope = [rule.subject, rule.level === undefined ? undefined : `${rule.level} 级及以上`, selectedIds ? '指定课程集合' : undefined].filter(Boolean).join(' / ')
      const label = `${scope ? scope + '：' : ''}至少 ${rule.minimum} 学分`
      if (confirmed + 1e-9 >= rule.minimum) return result('met', `${label}；可确认 ${confirmed} 学分（每门课只计一次）。`)
      if (!ctx.profile.recordComplete || uncertain) return result('unknown', `${label}；目前可确认 ${confirmed} 学分，尚有未完整、无法核实或排除课程之间待分配的学分。`, [label])
      return result('unmet', `${label}；已确认 ${confirmed} 学分。`, [label])
    }
    case 'permission': return result('unknown', `需要人工确认许可：${rule.text}`, [rule.text])
    case 'program': return ctx.profile.admittedPrograms.includes(rule.programId)
      ? result('met', `已记录正式录取至 ${rule.programId}。`)
      : result('unknown', `未确认已正式录取至 ${rule.programId}；选择目标专业不代表已录取。`, [rule.programId])
    case 'unknown': return result('unknown', `需人工核对：${rule.text || rule.reason}${rule.text && rule.reason ? `（${rule.reason}）` : ''}`, [rule.text || rule.reason])
    case 'applicability': {
      if (!ctx.profile.cohort) return result('unknown', `尚未提供适用 cohort；此条款适用于 ${rule.cohort}。`, [`cohort: ${rule.cohort}`])
      if (ctx.profile.cohort.trim().toLowerCase() !== rule.cohort.trim().toLowerCase()) return result('unknown', `已填写 cohort ${ctx.profile.cohort} 与条款 ${rule.cohort} 不一致，需核对适用规则。`, [`cohort: ${rule.cohort}`])
      return evaluate(rule.rule, ctx, options)
    }
  }
}

export function evaluateRule(rule: Rule, profile: StudentProfile, courses: readonly Course[], options: EvaluationOptions = {}): Evaluation {
  return evaluate(rule, context(profile, courses), options)
}

function eligibility(course: Course, ctx: Context): Eligibility {
  const prerequisite = evaluate(course.prerequisites.rule, ctx)
  const corequisite = evaluate(course.corequisites.rule, ctx, { allowInProgress: true })
  const restrictions = evaluate(course.restrictions.rule, ctx)
  const recommended = evaluate(course.recommended.rule, ctx)
  const excluded = course.exclusions.rule.kind === 'true' ? undefined : evaluate(course.exclusions.rule, ctx, { allowInProgress: true })
  const exclusion = !excluded ? result('met', '') : excluded.status === 'met'
    ? result('unmet', `存在已完成或正在修读的排除课程：${course.exclusions.rawText}`, [course.exclusions.rawText])
    : excluded.status === 'unknown'
      ? result('unknown', `排除条件尚未核实：${course.exclusions.rawText}`, excluded.missing)
      : result('met', '已核实的修课记录未触发此排除条件。')
  return { ...combine([prerequisite, corequisite, exclusion, restrictions], 'all'), prerequisite, corequisite, exclusion, restrictions, recommended }
}

export function evaluateEligibility(course: Course, profile: StudentProfile, courses: readonly Course[]): Eligibility {
  return eligibility(course, context(profile, courses))
}

/** Structured references only; opaque text is retained separately by Requirement.courseIds. */
export function ruleCourseIds(rule: Rule): string[] {
  switch (rule.kind) {
    case 'course': case 'minGrade': return [rule.courseId]
    case 'credits': return unique(rule.courseIds ?? [])
    case 'all': case 'any': return unique(rule.items.flatMap(ruleCourseIds))
    case 'applicability': return ruleCourseIds(rule.rule)
    default: return []
  }
}

function mandatoryCourseIds(rule: Rule): string[] {
  switch (rule.kind) {
    case 'course': case 'minGrade': return [rule.courseId]
    case 'all': return unique(rule.items.flatMap(mandatoryCourseIds))
    case 'any': {
      const children = rule.items.map(mandatoryCourseIds)
      return children.length ? children[0].filter(id => children.every(ids => ids.includes(id))) : []
    }
    case 'applicability': return mandatoryCourseIds(rule.rule)
    default: return []
  }
}

function containsUnknown(rule: Rule): boolean {
  return rule.kind === 'unknown' || rule.kind === 'permission' || rule.kind === 'applicability' ||
    ((rule.kind === 'all' || rule.kind === 'any') && rule.items.some(containsUnknown))
}

interface Adjacency { prerequisites: Map<string, Set<string>>; dependents: Map<string, Set<string>> }
interface ImpactIndex { courseReferences: Map<string, Set<string>>; creditTargets: Set<string> }
function adjacency(courses: readonly Course[]): Adjacency {
  const prerequisites = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const course of courses) {
    const refs = new Set([...course.prerequisites.courseIds, ...ruleCourseIds(course.prerequisites.rule), ...course.corequisites.courseIds, ...ruleCourseIds(course.corequisites.rule)])
    prerequisites.set(course.id, refs)
    for (const ref of refs) {
      if (!dependents.has(ref)) dependents.set(ref, new Set())
      dependents.get(ref)!.add(course.id)
    }
  }
  return { prerequisites, dependents }
}

function reachable(start: string, edges: Map<string, Set<string>>): string[] {
  const visited = new Set([start])
  const queue = [...(edges.get(start) ?? [])]
  for (let index = 0; index < queue.length; index++) {
    const next = queue[index]
    if (visited.has(next)) continue
    visited.add(next)
    queue.push(...(edges.get(next) ?? []))
  }
  visited.delete(start)
  return [...visited].sort()
}

export function getRelatedCourses(courseId: string, courses: readonly Course[]) {
  const graph = adjacency(courses)
  return {
    prerequisites: [...(graph.prerequisites.get(courseId) ?? [])].filter(id => id !== courseId).sort(),
    dependents: [...(graph.dependents.get(courseId) ?? [])].filter(id => id !== courseId).sort(),
    transitivePrerequisites: reachable(courseId, graph.prerequisites),
    transitiveDependents: reachable(courseId, graph.dependents),
  }
}

function hypotheticalProfile(courseId: string, ctx: Context): StudentProfile {
  const existing = ctx.records.get(courseId)
  const courses: StudentCourse[] = [...ctx.profile.courses.filter(row => row.courseId !== courseId), { courseId, status: 'completed', ...(passed(existing) && existing?.grade !== undefined ? { grade: existing.grade } : {}) }]
  const hypotheticalContext: Context = { ...ctx, records: new Map(courses.map(record => [record.courseId, record])), creditConflictIds: undefined }
  const additionalCredits = passed(existing) || creditConflicts(hypotheticalContext).has(courseId) ? 0 : ctx.courses.get(courseId)?.credits ?? 0
  return {
    ...ctx.profile,
    courses,
    ...(ctx.profile.completedCredits !== undefined ? { completedCredits: ctx.profile.completedCredits + additionalCredits } : {}),
  }
}

function impactIndex(courses: readonly Course[]): ImpactIndex {
  const courseReferences = new Map<string, Set<string>>()
  const creditTargets = new Set<string>()
  function visit(rule: Rule, target: string) {
    if (rule.kind === 'credits') creditTargets.add(target)
    else if (rule.kind === 'course' || rule.kind === 'minGrade') {
      if (!courseReferences.has(rule.courseId)) courseReferences.set(rule.courseId, new Set())
      courseReferences.get(rule.courseId)!.add(target)
    } else if (rule.kind === 'all' || rule.kind === 'any') rule.items.forEach(item => visit(item, target))
    else if (rule.kind === 'applicability') visit(rule.rule, target)
  }
  for (const course of courses) {
    for (const requirement of [course.prerequisites, course.corequisites, course.exclusions, course.restrictions]) visit(requirement.rule, course.id)
  }
  return { courseReferences, creditTargets }
}

function possibleUnlocks(courseId: string, ctx: Context, graph: Adjacency, before: ReadonlyMap<string, Status>, impact: ImpactIndex) {
  // Only this one completion and its credit value change; unrelated rules retain their baseline.
  // Include all credit rules, including unscoped credit thresholds without course reference edges.
  const affected = new Set([...(impact.courseReferences.get(courseId) ?? []), ...impact.creditTargets])
  const hypothetical = hypotheticalProfile(courseId, ctx)
  const after: Context = { ...ctx, profile: hypothetical, records: new Map(hypothetical.courses.map(record => [record.courseId, record])), creditConflictIds: undefined }
  const newlyEligible = [...affected].filter(id => id !== courseId && !passed(ctx.records.get(id)) && before.get(id) !== 'met' && eligibility(ctx.courses.get(id)!, after).status === 'met').sort()
  const newly = new Set(newlyEligible)
  const potential = reachable(courseId, graph.dependents).filter(id => !newly.has(id) && !passed(ctx.records.get(id)) && before.get(id) !== 'met')
  return { newlyEligible, potential }
}

/** Each simulation starts from the actual profile and never assumes a minimum grade. */
export function getPossibleUnlocks(courseId: string, courses: readonly Course[], profile: StudentProfile) {
  const ctx = context(profile, courses)
  const before = new Map(courses.map(course => [course.id, eligibility(course, ctx).status]))
  return possibleUnlocks(courseId, ctx, adjacency(courses), before, impactIndex(courses))
}

export function evaluateProgram(program: Program, profile: StudentProfile, courses: readonly Course[]): ProgramEvaluation {
  const ctx = context(profile, courses)
  const groups = program.groups.map(group => ({ id: group.id, label: group.label, category: group.category, evaluation: evaluate(group.rule, ctx) }))
  const admission = combine([evaluate(program.admission.rule, ctx), ...groups.filter(group => group.category === 'admission').map(group => group.evaluation)], 'all')
  let completion = combine([evaluate(program.completion.rule, ctx), ...groups.filter(group => group.category === 'completion').map(group => group.evaluation)], 'all')
  const used = new Set<string>()
  const overlaps = new Set<string>()
  for (const group of program.groups.filter(group => group.category === 'completion')) {
    for (const id of unique([...group.courseIds, ...ruleCourseIds(group.rule)]).filter(id => passed(ctx.records.get(id)))) {
      if (used.has(id)) overlaps.add(id)
      used.add(id)
    }
  }
  if (overlaps.size && completion.status === 'met') {
    completion = result('unknown', `各组单独满足，但 ${[...overlaps].map(courseCode).join(', ')} 出现在多个完成要求组；跨组共享规则尚未结构化，不能确认专业完成。`, ['跨组课程共享与分配规则'])
  }
  return { ...completion, admission, completion, groups }
}

export function recommendCourses(program: Program, catalog: Catalog, profile: StudentProfile): Recommendation[] {
  const ctx = context(profile, catalog.courses)
  const graph = adjacency(catalog.courses)
  const impact = impactIndex(catalog.courses)
  const before = new Map(catalog.courses.map(course => [course.id, eligibility(course, ctx).status]))
  interface Candidate { rank: number; groups: string[]; reasons: string[]; sources: string[]; uncertainOnly: boolean }
  const candidates = new Map<string, Candidate>()
  function add(id: string, rank: number, group: string, reason: string, source: string, uncertain: boolean) {
    const existing = ctx.records.get(id)
    if (!ctx.courses.has(id) || passed(existing) || existing?.status === 'inProgress' || existing?.status === 'planned') return
    const current = candidates.get(id)
    if (current) {
      current.rank = Math.min(current.rank, rank)
      current.groups = unique([...current.groups, group])
      current.reasons = unique([...current.reasons, reason])
      current.sources = unique([...current.sources, source])
      current.uncertainOnly = current.uncertainOnly && uncertain
    } else candidates.set(id, { rank, groups: [group], reasons: [reason], sources: [source], uncertainOnly: uncertain })
  }
  const groups = program.groups.length ? program.groups : [
    { ...program.admission, id: `${program.id}:admission`, label: '入学要求', category: 'admission' as const },
    { ...program.completion, id: `${program.id}:completion`, label: '完成要求', category: 'completion' as const },
  ]
  for (const group of groups) {
    if (group.category === 'admission' && profile.admittedPrograms.includes(program.id)) continue
    if (evaluate(group.rule, ctx).status === 'met') continue
    const required = new Set(mandatoryCourseIds(group.rule))
    const structured = new Set(ruleCourseIds(group.rule))
    const refs = unique([...group.courseIds, ...structured])
    for (const id of refs) {
      const uncertain = !structured.has(id) || containsUnknown(group.rule)
      const kind = required.has(id) ? '必修条件' : '候选选项'
      add(id, required.has(id) && !uncertain ? 0 : 1, group.id, uncertain
        ? `出现在 ${group.label} 的待核对条款中；属于参考候选，不代表全部必修。`
        : `${group.category === 'admission' ? '专业入学' : '专业完成'}要求「${group.label}」的${kind}。`, group.sourceUrl, uncertain)
      for (const bridge of reachable(id, graph.prerequisites)) {
        if (bridge === id) continue
        add(bridge, 2, group.id, `参与 ${courseCode(id)} 的先修或并修路径，可为「${group.label}」准备；需核对完整 AND / OR 条件。`, ctx.courses.get(id)?.sourceUrl ?? group.sourceUrl, uncertain)
      }
    }
  }
  const recommendations: Recommendation[] = []
  for (const [courseId, candidate] of candidates) {
    const course = ctx.courses.get(courseId)!
    const checked = eligibility(course, ctx)
    if (checked.exclusion.status === 'unmet') continue
    const unlocks = possibleUnlocks(courseId, ctx, graph, before, impact).newlyEligible
    const ready = checked.status === 'met' && !candidate.uncertainOnly
    recommendations.push({
      courseId,
      score: (3 - candidate.rank) * 100_000 + (ready ? 10_000 : 0) + Math.min(unlocks.length, 999),
      category: ready ? 'ready' : 'planning',
      reasons: candidate.reasons,
      groups: candidate.groups,
      eligibility: checked,
      possibleUnlocks: unlocks,
      sourceUrls: unique([course.sourceUrl, program.sourceUrl, ...candidate.sources]),
    })
  }
  return recommendations.sort((a, b) => b.score - a.score || a.courseId.localeCompare(b.courseId))
}

/** Strongly connected components, including self-references; no topological assumption. */
export function findDependencyCycles(courses: readonly Course[]): string[][] {
  const edges = adjacency(courses).prerequisites
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []
  function visit(id: string) {
    index.set(id, next); low.set(id, next); next++
    stack.push(id); onStack.add(id)
    for (const neighbor of edges.get(id) ?? []) {
      if (!index.has(neighbor)) { visit(neighbor); low.set(id, Math.min(low.get(id)!, low.get(neighbor)!)) }
      else if (onStack.has(neighbor)) low.set(id, Math.min(low.get(id)!, index.get(neighbor)!))
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = []
      let member: string
      do { member = stack.pop()!; onStack.delete(member); component.push(member) } while (member !== id)
      if (component.length > 1 || edges.get(id)?.has(id)) cycles.push(component.sort())
    }
  }
  for (const id of edges.keys()) if (!index.has(id)) visit(id)
  return cycles.sort((a, b) => a[0].localeCompare(b[0]))
}
