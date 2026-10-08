import { describe, expect, it } from 'vitest'
import {
  createEmptyProfile, EMPTY_PROFILE, evaluateEligibility, evaluateProgram, evaluateRule,
  findDependencyCycles, getPossibleUnlocks, getRelatedCourses, parseStudentProfile,
  recommendCourses, ruleCourseIds, serializeStudentProfile,
} from '../src/domain'
import type { Catalog, Course, Program, Requirement, Rule, StudentProfile } from '../src/domain'

// Synthetic fixtures deliberately use non-catalogue IDs. Official data integration is separate.
const ref = (code: string): Rule => ({ kind: 'course', courseId: `UTM:${code}` })
const req = (rule: Rule = { kind: 'true' }, rawText = ''): Requirement => ({ rule, rawText, courseIds: ruleCourseIds(rule), sourceUrl: 'https://utm.calendar.utoronto.ca/' })
const course = (code: string, options: Partial<Course> = {}): Course => ({
  id: `UTM:${code}`, campus: 'UTM', code, title: `Synthetic ${code}`, subject: code.slice(0, 3), level: Number(code[3]) * 100,
  credits: code.includes('Y') ? 1 : 0.5, description: '', sourceUrl: `https://utm.calendar.utoronto.ca/course/${code.toLowerCase()}`,
  contentHash: 'synthetic', fetchedAt: '2026-01-01', prerequisites: req(), corequisites: req(), exclusions: req(),
  recommended: req(), restrictions: req(), notes: '', ...options,
})
const A = course('TST100H5'), B = course('TST101H5'), C = course('TST200H5'), D = course('TST300H5')
const courses = [A, B, C, D]
const profile = (ids: string[] = [], options: Partial<StudentProfile> = {}): StudentProfile => ({
  schemaVersion: 1, courses: ids.map(courseId => ({ courseId, status: 'completed' })), recordComplete: true, admittedPrograms: [], ...options,
})
const program = (rule: Rule, options: Partial<Program> = {}): Program => ({
  id: 'UTM:TEST', campus: 'UTM', code: 'TEST', title: 'Synthetic Test Major', type: 'Major', description: '',
  sourceUrl: 'https://utm.calendar.utoronto.ca/program/test', contentHash: 'synthetic', fetchedAt: '2026-01-01',
  admission: req(), completion: req(rule), groups: [{ ...req(rule), id: 'test-group', category: 'completion', label: 'Synthetic requirement' }], notes: '', ...options,
})
const catalog = (allCourses: Course[], programs: Program[]): Catalog => ({
  schemaVersion: 1, metadata: { campus: 'UTM', academicYear: 'synthetic', academicYearSource: '', fetchedAt: '', parserVersion: 'test', sources: [], complete: true }, courses: allCourses, programs,
})

describe('three-state rule semantics', () => {
  it('(A OR B) AND C requires both groups', () => {
    const rule: Rule = { kind: 'all', items: [{ kind: 'any', items: [ref(A.code), ref(B.code)] }, ref(C.code)] }
    expect(evaluateRule(rule, profile([A.id]), courses).status).toBe('unmet')
    expect(evaluateRule(rule, profile([A.id, C.id]), courses).status).toBe('met')
    expect(evaluateRule(rule, createEmptyProfile(), courses).status).toBe('unknown')
  })
  it('propagates unknown through AND / OR without replacing it with no requirement', () => {
    const unknown: Rule = { kind: 'unknown', text: 'Selection process', reason: 'Requires review' }
    expect(evaluateRule({ kind: 'all', items: [ref(A.code), unknown] }, profile(), courses).status).toBe('unmet')
    expect(evaluateRule({ kind: 'all', items: [ref(A.code), unknown] }, profile([A.id]), courses).status).toBe('unknown')
    expect(evaluateRule({ kind: 'any', items: [ref(A.code), unknown] }, profile([A.id]), courses).status).toBe('met')
    expect(evaluateRule({ kind: 'any', items: [ref(A.code), unknown] }, profile(), courses).status).toBe('unknown')
  })
  it('distinguishes absent records from a complete empty transcript', () => {
    expect(evaluateRule(ref(A.code), EMPTY_PROFILE, courses).status).toBe('unknown')
    expect(evaluateRule(ref(A.code), profile(), courses).status).toBe('unmet')
  })
  it('never counts planned records and only allows in-progress records for explicit concurrent evaluation', () => {
    for (const status of ['planned', 'inProgress'] as const) {
      const student = profile([], { courses: [{ courseId: A.id, status }] })
      expect(evaluateRule(ref(A.code), student, courses).status).toBe('unmet')
      expect(evaluateRule(ref(A.code), student, courses, { allowInProgress: true }).status).toBe(status === 'inProgress' ? 'met' : 'unmet')
    }
  })
  it('requires the final grade when a minimum is specified', () => {
    const rule: Rule = { kind: 'minGrade', courseId: A.id, minimum: 73 }
    expect(evaluateRule(rule, profile([A.id]), courses).status).toBe('unknown')
    expect(evaluateRule(rule, profile([], { courses: [{ courseId: A.id, status: 'completed', grade: 72 }] }), courses).status).toBe('unmet')
    expect(evaluateRule(rule, profile([], { courses: [{ courseId: A.id, status: 'completed', grade: 73 }] }), courses).status).toBe('met')
    expect(evaluateRule(rule, profile([], { courses: [{ courseId: A.id, status: 'inProgress', grade: 95 }] }), courses, { allowInProgress: true }).status).toBe('unknown')
  })
  it('keeps a failed grade in the transcript without treating it as passing or earned credit', () => {
    const student = profile([], { courses: [{ courseId: A.id, status: 'completed', grade: 49 }] })
    expect(evaluateRule(ref(A.code), student, courses).status).toBe('unmet')
    expect(evaluateRule({ kind: 'credits', minimum: 0.5 }, student, courses).status).toBe('unmet')
    expect(evaluateRule(ref(A.code), profile([], { courses: [{ courseId: A.id, status: 'completed', grade: 50 }] }), courses).status).toBe('met')
    const target = course(B.code, { prerequisites: req(ref(A.code)) })
    const graded = course(C.code, { prerequisites: req({ kind: 'minGrade', courseId: A.id, minimum: 70 }) })
    expect(getPossibleUnlocks(A.id, [A, target, graded], student).newlyEligible).toEqual([B.id])
    expect(student.courses[0].grade).toBe(49)
    const degree = program(ref(A.code))
    expect(recommendCourses(degree, catalog(courses, [degree]), student).map(r => r.courseId)).toContain(A.id)
  })
  it('counts credit sets uniquely and preserves unknown external credit values', () => {
    const student = profile([A.id, A.id, B.id])
    expect(evaluateRule({ kind: 'credits', minimum: 1.5, courseIds: [A.id, A.id, B.id] }, student, courses).status).toBe('unmet')
    expect(evaluateRule({ kind: 'credits', minimum: 1, courseIds: [A.id, A.id, B.id] }, student, courses).status).toBe('met')
    expect(evaluateRule({ kind: 'credits', minimum: 1, courseIds: [] }, student, courses).status).toBe('unmet')
    expect(evaluateRule({ kind: 'credits', minimum: 1 }, profile(['UTSG:TST100H1']), courses).status).toBe('unknown')
    expect(evaluateRule({ kind: 'credits', minimum: 1, level: 200 }, profile([A.id, C.id]), courses).status).toBe('unmet')
    expect(evaluateRule({ kind: 'credits', minimum: 5 }, profile([], { completedCredits: 5 }), courses).status).toBe('met')
  })
  it('requires recorded admission and an exactly matching cohort', () => {
    expect(evaluateRule({ kind: 'program', programId: 'UTM:TEST' }, profile(), courses).status).toBe('unknown')
    expect(evaluateRule({ kind: 'program', programId: 'UTM:TEST' }, profile([], { admittedPrograms: ['UTM:TEST'] }), courses).status).toBe('met')
    const rule: Rule = { kind: 'applicability', cohort: '2026', rule: ref(A.code) }
    expect(evaluateRule(rule, profile([A.id]), courses).status).toBe('unknown')
    expect(evaluateRule(rule, profile([A.id], { cohort: '2025' }), courses).status).toBe('unknown')
    expect(evaluateRule(rule, profile([A.id], { cohort: '2026' }), courses).status).toBe('met')
  })
  it('does not double count credits when completed records include an exclusion pair', () => {
    const conflicting = course(A.code, { exclusions: req(ref(B.code), B.code) })
    const all = [conflicting, B, C]
    const student = profile([A.id, B.id, C.id])
    expect(evaluateRule({ kind: 'credits', minimum: 1 }, student, all).status).toBe('unknown')
    expect(evaluateRule({ kind: 'credits', minimum: 0.5 }, student, all).status).toBe('met')
    expect(evaluateRule({ kind: 'credits', minimum: 1 }, { ...student, completedCredits: 1 }, all).status).toBe('met')
    expect(evaluateRule({ kind: 'credits', minimum: 1, courseIds: [A.id, B.id] }, { ...student, completedCredits: 10 }, all).status).toBe('unknown')
  })
  it('keeps full campus identities distinct and accepts exact explicit external completions', () => {
    const external: Rule = { kind: 'course', courseId: 'UTSG:TST100H1' }
    expect(evaluateRule(external, profile([A.id]), courses).status).toBe('unmet')
    expect(evaluateRule(external, profile(['UTSG:TST100H1']), courses).status).toBe('met')
  })
})

describe('eligibility, relation traversal and independent hypothetical completion', () => {
  it('combines mandatory concurrent, exclusion and permission conditions but not recommendations', () => {
    const target = course(D.code, { prerequisites: req(ref(A.code)), corequisites: req(ref(B.code)), recommended: req(ref(C.code)) })
    const student = profile([A.id], { courses: [{ courseId: A.id, status: 'completed' }, { courseId: B.id, status: 'inProgress' }] })
    expect(evaluateEligibility(target, student, courses).status).toBe('met')
    expect(evaluateEligibility(target, student, courses).recommended.status).toBe('unmet')
    expect(evaluateEligibility({ ...target, exclusions: req(ref(A.code), A.code) }, student, courses).status).toBe('unmet')
    expect(evaluateEligibility({ ...target, restrictions: req({ kind: 'permission', text: 'Instructor permission' }) }, student, courses).status).toBe('unknown')
    expect(evaluateEligibility({ ...target, exclusions: req(ref(C.code), C.code) }, { ...student, recordComplete: false }, courses).status).toBe('unknown')
  })
  it('does not silently discard an unparsed exclusion with no course references', () => {
    const target = course(D.code, { exclusions: req({ kind: 'unknown', text: 'Equivalent credit', reason: 'Cannot verify' }, 'Equivalent credit') })
    expect(evaluateEligibility(target, profile(), courses).status).toBe('unknown')
  })
  it('terminates cycles, excludes the selected node from its neighborhood and retains external nodes', () => {
    const cycle = [course(A.code, { prerequisites: req(ref(B.code)) }), course(B.code, { prerequisites: req({ kind: 'any', items: [ref(A.code), { kind: 'course', courseId: 'UTSG:TST100H1' }] }) }), C]
    expect(findDependencyCycles(cycle)).toEqual([[A.id, B.id]])
    expect(getRelatedCourses(A.id, cycle).transitivePrerequisites).toEqual([B.id, 'UTSG:TST100H1'].sort())
    expect(getRelatedCourses(C.id, cycle).dependents).toEqual([])
  })
  it('does not confuse an OR participation edge with unconditional unlock', () => {
    const target = course(D.code, { prerequisites: req({ kind: 'all', items: [{ kind: 'any', items: [ref(A.code), ref(B.code)] }, ref(C.code)] }) })
    const all = [...courses.filter(c => c.id !== D.id), target]
    const student = profile()
    const saved = JSON.stringify(student)
    expect(getPossibleUnlocks(A.id, all, student).newlyEligible).toEqual([])
    expect(getPossibleUnlocks(A.id, all, student).potential).toContain(D.id)
    expect(getPossibleUnlocks(A.id, all, profile([C.id])).newlyEligible).toContain(D.id)
    expect(JSON.stringify(student)).toBe(saved)
  })
  it('counts simulated credits once and does not invent hypothetical grades', () => {
    const target = course(D.code, { prerequisites: req({ kind: 'credits', minimum: 1 }) })
    const graded = course(C.code, { prerequisites: req({ kind: 'minGrade', minimum: 70, courseId: A.id }) })
    const all = [A, B, target, graded]
    const student = profile([B.id], { completedCredits: 0.5 })
    expect(getPossibleUnlocks(A.id, all, student).newlyEligible).toContain(D.id)
    expect(getPossibleUnlocks(A.id, all, student).newlyEligible).not.toContain(C.id)
    expect(student.completedCredits).toBe(0.5)
    expect(getPossibleUnlocks(B.id, all, student).newlyEligible).toEqual([])
    const excludesA = course(B.code, { exclusions: req(ref(A.code), A.code) })
    expect(getPossibleUnlocks(A.id, [A, excludesA, target], student).newlyEligible).not.toContain(D.id)
  })
})

describe('program recommendations and completion', () => {
  it('ranks direct requirements, options and prerequisite bridges deterministically', () => {
    const option = course(C.code, { prerequisites: req(ref(B.code)) })
    const all = [A, B, option, D]
    const target = program({ kind: 'all', items: [ref(A.code), { kind: 'any', items: [ref(C.code), ref(D.code)] }] })
    const recommendations = recommendCourses(target, catalog(all, [target]), profile())
    expect(recommendations.map(r => r.courseId)).toEqual([A.id, D.id, C.id, B.id])
    expect(recommendations.find(r => r.courseId === C.id)?.category).toBe('planning')
    expect(recommendations.find(r => r.courseId === B.id)?.possibleUnlocks).toContain(C.id)
  })
  it('omits completed, planned, in-progress and excluded courses', () => {
    const excluded = course(D.code, { exclusions: req(ref(A.code), A.code) })
    const target = program({ kind: 'all', items: [ref(A.code), ref(B.code), ref(C.code), ref(D.code)] })
    const student = profile([], { courses: [{ courseId: A.id, status: 'completed' }, { courseId: B.id, status: 'planned' }, { courseId: C.id, status: 'inProgress' }] })
    expect(recommendCourses(target, catalog([A, B, C, excluded], [target]), student)).toEqual([])
  })
  it('shows unknown clause references only as planning candidates', () => {
    const unknown = { ...req({ kind: 'unknown', text: 'Additional selection conditions', reason: 'Not parsed' }), courseIds: [A.id, B.id] }
    const target = program(unknown.rule, { groups: [{ ...unknown, id: 'unknown', label: 'Unparsed group', category: 'completion' }] })
    const recommendations = recommendCourses(target, catalog(courses, [target]), profile())
    expect(recommendations).toHaveLength(2)
    expect(recommendations.every(r => r.category === 'planning' && r.reasons[0].includes('不代表全部必修'))).toBe(true)
    expect(evaluateProgram(target, profile([A.id, B.id]), courses).status).toBe('unknown')
  })
  it('does not infer completion from reusing credits across requirement groups', () => {
    const creditRule: Rule = { kind: 'credits', minimum: 0.5, courseIds: [A.id] }
    const target = program({ kind: 'all', items: [creditRule, creditRule] }, {
      groups: ['one', 'two'].map(id => ({ ...req(creditRule), id, category: 'completion' as const, label: id })),
    })
    const checked = evaluateProgram(target, profile([A.id]), courses)
    expect(checked.groups.every(g => g.evaluation.status === 'met')).toBe(true)
    expect(checked.completion.status).toBe('unknown')
  })
  it('does not treat selected target program as recorded admission', () => {
    const restricted = course(A.code, { restrictions: req({ kind: 'program', programId: 'UTM:TEST' }) })
    const target = program(ref(A.code))
    const data = catalog([restricted], [target])
    expect(recommendCourses(target, data, profile())[0].category).toBe('planning')
    expect(recommendCourses(target, data, profile([], { admittedPrograms: [target.id] }))[0].category).toBe('ready')
  })
})

describe('private local profile imports', () => {
  it('round-trips a schema-versioned profile and drops unrecognized data', () => {
    const input = { ...profile([A.id], { cohort: '2026', completedCredits: 0.5 }), script: '<script>alert(1)</script>' }
    const restored = parseStudentProfile(serializeStudentProfile(input))
    expect(restored).toEqual(profile([A.id], { cohort: '2026', completedCredits: 0.5 }))
    expect(restored).not.toHaveProperty('script')
  })
  it('rejects malformed data, duplicate IDs, bad grades and unsupported versions', () => {
    expect(() => parseStudentProfile('{')).toThrow('JSON')
    expect(() => parseStudentProfile({ ...profile(), schemaVersion: 2 })).toThrow('版本')
    expect(() => parseStudentProfile(profile([A.id, A.id]))).toThrow('重复')
    expect(() => parseStudentProfile(profile(['TST100H5']))).toThrow('校区')
    expect(() => parseStudentProfile(profile([], { courses: [{ courseId: A.id, status: 'completed', grade: 101 }] }))).toThrow('成绩')
    expect(() => parseStudentProfile({ ...profile(), completedCredits: Infinity })).toThrow('有限数值')
    expect(() => parseStudentProfile({ ...profile(), recordComplete: 'true' })).toThrow('recordComplete')
    expect(() => parseStudentProfile({ ...profile(), courses: [{ courseId: A.id, status: 'passed' }] })).toThrow('状态')
  })
  it('creates independent blank profiles with incomplete records', () => {
    const one = createEmptyProfile(), two = createEmptyProfile()
    one.courses.push({ courseId: A.id, status: 'completed' })
    expect(two.courses).toEqual([])
    expect(EMPTY_PROFILE.courses).toEqual([])
    expect(two.recordComplete).toBe(false)
  })
})
