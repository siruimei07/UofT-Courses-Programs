// createEngine (src/domain/engine.ts) against the contract in src/domain/engine-types.ts.
// Synthetic datasets use TST codes; the performance budget runs on the real UTM dataset.
import { describe, expect, it } from 'vitest'
import type { GraphCourse, GraphDataset, ProgramGroupLite, ProgramLite, RequirementLite } from '../src/data/schema'
import { createEngine, NEXT_COURSES_LIMIT, ruleCourseIds } from '../src/domain'
import type { RecordEntryLike, Rule } from '../src/domain'
import { loadGraphDataset } from './helpers/dataset'

const id = (code: string) => (code.includes(':') ? code : `UTM:${code}`)
const course = (code: string): Rule => ({ kind: 'course', courseId: id(code) })
const all = (...items: Rule[]): Rule => ({ kind: 'all', items })
const any = (...items: Rule[]): Rule => ({ kind: 'any', items })
const unknown = (text = 'Unparsed wording'): Rule => ({ kind: 'unknown', text, reason: 'test' })
/** A requirement field; `extra` lists ids cited only by the text, `unresolved` codes absent from the calendar. */
interface Field {
  rule: Rule
  extra?: string[]
  unresolved?: string[]
}
const requirement = (field: Rule | Field): RequirementLite => {
  const { rule, extra = [], unresolved } = 'kind' in field ? { rule: field } as Field : field
  return { text: 'Official text', rule, ids: [...ruleCourseIds(rule), ...extra.map(id)], ...(unresolved ? { unresolved: unresolved.map(id) } : {}) }
}

interface Spec {
  code: string
  prereq?: Rule | Field
  coreq?: Rule | Field
  exclusion?: Rule | Field
  /** Official restriction wording (the rule is always unparsed). */
  restriction?: string
}
function dataset(specs: Spec[]): GraphDataset {
  const courses = specs.map((spec): GraphCourse => ({
    id: id(spec.code), code: spec.code, title: `Synthetic ${spec.code}`, subject: spec.code.slice(0, 3),
    level: Number(spec.code[3]) * 100, credits: spec.code[6] === 'Y' ? 1 : 0.5,
    ...(spec.prereq ? { prereq: requirement(spec.prereq) } : {}),
    ...(spec.coreq ? { coreq: requirement(spec.coreq) } : {}),
    ...(spec.exclusion ? { exclusion: requirement(spec.exclusion) } : {}),
    ...(spec.restriction ? { restriction: { text: spec.restriction, rule: unknown(spec.restriction), ids: [] } } : {}),
  })).sort((a, b) => (a.id < b.id ? -1 : 1))
  return {
    schemaVersion: 1, campus: 'UTM', academicYear: 'synthetic', fetchedAt: '', generatedAt: '',
    sources: { calendar: '', courseSearch: '', programSearch: '', coursePageTemplate: '', programPageTemplate: '' },
    divisions: [], subjects: [], courses,
  }
}
interface GroupSpec {
  rule: Rule
  /** Extra ids cited only by the text. */
  textIds?: string[]
  /** Codes absent from the calendar. */
  unresolved?: string[]
  category?: ProgramGroupLite['category']
}
function program(groups: GroupSpec[]): ProgramLite {
  return {
    id: 'UTM:ERMAJ9999', code: 'ERMAJ9999', title: 'Synthetic Major', type: 'Major', sourceUrl: '', description: '',
    admissionText: '', completionText: '',
    groups: groups.map((group, i) => ({
      id: `g${i + 1}`, label: `Group ${i + 1}`, category: group.category ?? 'completion', text: 'Official text',
      rule: group.rule, ids: [...ruleCourseIds(group.rule), ...(group.textIds ?? []).map(id)],
      ...(group.unresolved ? { unresolved: group.unresolved.map(id) } : {}),
    })),
  }
}
type Row = [string, RecordEntryLike['status'], number?]
const record = (...rows: Row[]) => new Map(rows.map(([code, status, grade]) =>
  [id(code), grade === undefined ? { status } : { status, grade }] as [string, RecordEntryLike]))
const ids = (...codes: string[]) => codes.map(id)
const nextIds = (engine: ReturnType<typeof createEngine>, target: ProgramLite, rows: Row[], limit?: number) =>
  engine.nextCourses(target, record(...rows), limit).map(next => next.courseId)

describe('eligibility', () => {
  const data = dataset([
    { code: 'TST100H5' }, { code: 'TST101H5' }, { code: 'TST102H5' },
    { code: 'TST200H5', prereq: course('TST100H5') },
    { code: 'TST201H5', prereq: { kind: 'minGrade', courseId: id('TST100H5'), minimum: 70 } },
    { code: 'TST202H5', prereq: course('TST100H5'), coreq: course('TST101H5') },
  ])
  const engine = createEngine(data)

  it('covers every course that is not completed or in progress, planned ones included', () => {
    const result = engine.eligibility(record(['TST100H5', 'completed'], ['TST101H5', 'inProgress'], ['TST102H5', 'planned']))
    expect([...result.keys()]).toEqual(ids('TST102H5', 'TST200H5', 'TST201H5', 'TST202H5'))
  })

  it('keeps a failed course in the map: it is not passed and may be retaken', () => {
    const rows = record(['TST100H5', 'completed'], ['TST200H5', 'completed', 42], ['TST202H5', 'completed', 49])
    const result = engine.eligibility(rows)
    expect(result.get(id('TST200H5'))).toBe('met')
    expect(result.get(id('TST202H5'))).toBe('unmet')
    expect(result.has(id('TST100H5'))).toBe(false)
    expect(engine.eligibility(record(['TST200H5', 'completed', 50])).has(id('TST200H5'))).toBe(false)
  })

  it('counts an in-progress prerequisite: available once current courses are finished', () => {
    const result = engine.eligibility(record(['TST100H5', 'inProgress']))
    expect(result.get(id('TST200H5'))).toBe('met')
    // Minimum-grade checks stay unknown until the final grade is in.
    expect(result.get(id('TST201H5'))).toBe('unknown')
    expect(engine.eligibility(record(['TST100H5', 'planned'])).get(id('TST200H5'))).toBe('unmet')
  })

  it('accepts a planned corequisite as taken together, never a planned prerequisite', () => {
    expect(engine.eligibility(record(['TST100H5', 'completed'], ['TST101H5', 'planned'])).get(id('TST202H5'))).toBe('met')
    expect(engine.eligibility(record(['TST100H5', 'completed'])).get(id('TST202H5'))).toBe('unmet')
    expect(engine.eligibility(record(['TST100H5', 'planned'], ['TST101H5', 'planned'])).get(id('TST202H5'))).toBe('unmet')
  })

  it('checks minimum grades with and without a recorded grade', () => {
    expect(engine.eligibility(record(['TST100H5', 'completed', 70])).get(id('TST201H5'))).toBe('met')
    expect(engine.eligibility(record(['TST100H5', 'completed', 69])).get(id('TST201H5'))).toBe('unmet')
    expect(engine.eligibility(record(['TST100H5', 'completed'])).get(id('TST201H5'))).toBe('unknown')
    expect(engine.eligibility(record(['TST100H5', 'completed', 40])).get(id('TST200H5'))).toBe('unmet')
  })

  it('agrees with evaluateCourse for every course', () => {
    const rows = record(['TST100H5', 'completed', 75], ['TST101H5', 'planned'])
    for (const [courseId, status] of engine.eligibility(rows)) expect(engine.evaluateCourse(courseId, rows).overall).toBe(status)
  })
})

describe('evaluateCourse', () => {
  const data = dataset([
    { code: 'TST100H5' }, { code: 'TST101H5' }, { code: 'TST102H5' },
    { code: 'TST200H5', exclusion: any(course('TST100H5'), course('TST101H5'), course('UTSG:TST200H1')) },
    { code: 'TST201H5', exclusion: any(course('TST100H5'), unknown('Any equivalent course')) },
    { code: 'TST202H5', prereq: course('TST100H5'), restriction: 'Not open to students in program X.' },
    { code: 'TST203H5', prereq: all(course('TST100H5'), any(course('TST101H5'), course('TST102H5'))), coreq: course('TST102H5') },
    { code: 'TST204H5', prereq: course('TST100H5'), restriction: 'Priority is given to students enrolled in the Synthetic Major.' },
    // "TST101H5 (Winter 2025)": a dated special-topics offering, kept unparsed by the pipeline.
    { code: 'TST300H5', exclusion: { rule: unknown('TST101H5 (Winter 2025)'), extra: ['TST101H5'] } },
    { code: 'TST301H5', exclusion: { rule: any(course('TST100H5'), unknown('TST102H5 (Fall 2023)')), extra: ['TST102H5'] } },
    // "TST100H5 or TST190Y5", where TST190Y5 is retired: the parser keeps only TST100H5.
    { code: 'TST302H5', exclusion: { rule: course('TST100H5'), unresolved: ['TST190Y5'] } },
    { code: 'TST303H5', exclusion: { rule: { kind: 'true' }, unresolved: ['TST190Y5'] } },
    { code: 'TST304H5', exclusion: any(all(course('TST100H5'), course('TST101H5')), course('TST102H5')) },
    { code: 'TST305H5', prereq: { rule: course('TST101H5'), unresolved: ['TST190Y5'] }, coreq: { rule: course('TST102H5'), unresolved: ['TST191H5'] } },
  ])
  const engine = createEngine(data)

  it('reports null parts for a course without requirements and unknown for a missing id', () => {
    expect(engine.evaluateCourse(id('TST100H5'), record())).toEqual({
      courseId: id('TST100H5'), overall: 'met', prerequisites: null, corequisites: null, exclusions: null, restrictions: null,
    })
    expect(engine.evaluateCourse('UTM:NOP100H5', record()).overall).toBe('unknown')
  })

  it('returns prerequisite and corequisite trees evaluated with their own record semantics', () => {
    const result = engine.evaluateCourse(id('TST203H5'), record(['TST100H5', 'inProgress'], ['TST102H5', 'planned']))
    expect(result.prerequisites).toEqual({
      kind: 'all', status: 'unmet', children: [
        { kind: 'course', status: 'met', courseId: id('TST100H5') },
        { kind: 'any', status: 'unmet', children: [
          { kind: 'course', status: 'unmet', courseId: id('TST101H5') },
          { kind: 'course', status: 'unmet', courseId: id('TST102H5') },
        ] },
      ],
    })
    expect(result.corequisites).toEqual({ kind: 'course', status: 'met', courseId: id('TST102H5') })
    expect(result.overall).toBe('unmet')
  })

  it('blocks on completed or in-progress exclusions only', () => {
    const blocked = engine.evaluateCourse(id('TST200H5'), record(['TST100H5', 'completed'], ['TST101H5', 'inProgress']))
    expect(blocked.exclusions).toEqual({ status: 'blocked', blockedBy: ids('TST100H5', 'TST101H5') })
    expect(blocked.overall).toBe('unmet')
    expect(engine.evaluateCourse(id('TST200H5'), record(['UTSG:TST200H1', 'completed'])).exclusions?.blockedBy).toEqual(['UTSG:TST200H1'])
    for (const rows of [record(['TST100H5', 'planned']), record(['TST100H5', 'completed', 35]), record()]) {
      expect(engine.evaluateCourse(id('TST200H5'), rows).exclusions).toEqual({ status: 'clear', blockedBy: [] })
    }
  })

  it('keeps an unparsed exclusion unknown unless a listed course blocks it', () => {
    expect(engine.evaluateCourse(id('TST201H5'), record()).exclusions).toEqual({ status: 'unknown', blockedBy: [] })
    expect(engine.evaluateCourse(id('TST201H5'), record()).overall).toBe('unknown')
    expect(engine.evaluateCourse(id('TST201H5'), record(['TST100H5', 'completed'])).exclusions?.status).toBe('blocked')
  })

  it('treats restrictions as opaque text, never as positive requirements', () => {
    const result = engine.evaluateCourse(id('TST202H5'), record(['TST100H5', 'completed']))
    expect(result.prerequisites?.status).toBe('met')
    expect(result.restrictions).toEqual({ kind: 'unknown', status: 'unknown', text: 'Not open to students in program X.' })
    expect(result.overall).toBe('unknown')
    expect(engine.evaluateCourse(id('TST202H5'), record(['TST100H5', 'completed'], ['TST102H5', 'completed'])).overall).toBe('unknown')
  })

  it('reports an enrolment-priority restriction as a met note that never decides eligibility (spec 19.9)', () => {
    const rows = record(['TST100H5', 'completed'])
    const result = engine.evaluateCourse(id('TST204H5'), rows)
    expect(result.restrictions).toEqual({ kind: 'true', status: 'met', text: 'Priority is given to students enrolled in the Synthetic Major.' })
    expect(result.overall).toBe('met')
    expect(engine.eligibility(rows).get(id('TST204H5'))).toBe('met')
    expect(engine.evaluateCourse(id('TST204H5'), record()).overall).toBe('unmet')
  })

  it('only "may exclude" when the match is in unparsed text', () => {
    const rows = record(['TST101H5', 'completed'])
    expect(engine.evaluateCourse(id('TST300H5'), rows).exclusions).toEqual({ status: 'unknown', blockedBy: ids('TST101H5') })
    expect(engine.evaluateCourse(id('TST300H5'), rows).overall).toBe('unknown')
    expect(engine.evaluateCourse(id('TST300H5'), record(['TST101H5', 'completed', 30])).exclusions).toEqual({ status: 'unknown', blockedBy: [] })
    // A parsed leaf still blocks; the text-only match is listed with it.
    expect(engine.evaluateCourse(id('TST301H5'), record(['TST100H5', 'inProgress'], ['TST102H5', 'completed'])).exclusions)
      .toEqual({ status: 'blocked', blockedBy: ids('TST100H5', 'TST102H5') })
    expect(engine.evaluateCourse(id('TST301H5'), record(['TST102H5', 'completed'])).exclusions).toEqual({ status: 'unknown', blockedBy: ids('TST102H5') })
  })

  it('only "may exclude" when the match is a code absent from this calendar (older records)', () => {
    const rows = record(['TST190Y5', 'completed'])
    expect(engine.evaluateCourse(id('TST302H5'), rows).exclusions).toEqual({ status: 'unknown', blockedBy: ids('TST190Y5') })
    expect(engine.evaluateCourse(id('TST302H5'), record()).exclusions).toEqual({ status: 'clear', blockedBy: [] })
    expect(engine.evaluateCourse(id('TST302H5'), record(['TST100H5', 'completed'])).exclusions?.status).toBe('blocked')
    expect(engine.evaluateCourse(id('TST303H5'), rows).exclusions).toEqual({ status: 'unknown', blockedBy: ids('TST190Y5') })
    expect(engine.evaluateCourse(id('TST303H5'), record(['TST100H5', 'completed'])).exclusions).toEqual({ status: 'clear', blockedBy: [] })
  })

  it('blocks on a parsed AND only when every member is on the record', () => {
    expect(engine.evaluateCourse(id('TST304H5'), record(['TST100H5', 'completed'])).exclusions).toEqual({ status: 'clear', blockedBy: [] })
    expect(engine.evaluateCourse(id('TST304H5'), record(['TST100H5', 'completed'], ['TST101H5', 'completed'])).exclusions)
      .toEqual({ status: 'blocked', blockedBy: ids('TST100H5', 'TST101H5') })
  })

  it('turns an unmet requirement unknown when the record holds one of its codes absent from this calendar', () => {
    const result = engine.evaluateCourse(id('TST305H5'), record(['TST190Y5', 'completed'], ['TST191H5', 'planned']))
    expect(result.prerequisites).toMatchObject({ kind: 'course', status: 'unknown', courseId: id('TST101H5') })
    expect(result.corequisites).toMatchObject({ kind: 'course', status: 'unknown', courseId: id('TST102H5') })
    expect(result.overall).toBe('unknown')
    // Same semantics as any other course: a planned code is no prerequisite, a failed one never counts.
    expect(engine.evaluateCourse(id('TST305H5'), record(['TST190Y5', 'planned'])).prerequisites?.status).toBe('unmet')
    expect(engine.evaluateCourse(id('TST305H5'), record(['TST190Y5', 'completed', 20])).prerequisites?.status).toBe('unmet')
    expect(engine.evaluateCourse(id('TST305H5'), record(['TST101H5', 'completed'], ['TST190Y5', 'completed'])).prerequisites?.status).toBe('met')
  })

  it('evaluates an already-passed course without hiding it from details', () => {
    const rows = record(['TST100H5', 'completed'], ['TST200H5', 'completed'])
    expect(engine.eligibility(rows).has(id('TST200H5'))).toBe(false)
    expect(engine.evaluateCourse(id('TST200H5'), rows).exclusions?.status).toBe('blocked')
  })
})

describe('programProgress', () => {
  const data = dataset([{ code: 'TST100H5' }, { code: 'TST101H5' }, { code: 'TST102H5' }, { code: 'TST200H5' }, { code: 'TST201H5' }])
  const engine = createEngine(data)

  it('reports each group with its dataset courses and record subsets', () => {
    const target = program([
      { rule: all(course('TST200H5'), course('TST100H5')), textIds: ['UTSG:TST100H1', 'TST999H5'] },
      { rule: any(course('TST101H5'), course('TST102H5')) },
      { rule: { kind: 'credits', minimum: 1, courseIds: ids('TST100H5', 'TST201H5') }, category: 'admission' },
    ])
    const progress = engine.programProgress(target, record(['TST100H5', 'completed'], ['TST200H5', 'inProgress'], ['TST101H5', 'planned'], ['TST102H5', 'completed', 20]))
    expect(progress.programId).toBe('UTM:ERMAJ9999')
    expect(progress.groups).toEqual([
      { groupId: 'g1', status: 'unmet', courseIds: ids('TST100H5', 'TST200H5'), completed: ids('TST100H5'), inProgress: ids('TST200H5'), planned: [] },
      { groupId: 'g2', status: 'unmet', courseIds: ids('TST101H5', 'TST102H5'), completed: [], inProgress: [], planned: ids('TST101H5') },
      { groupId: 'g3', status: 'unmet', courseIds: ids('TST100H5', 'TST201H5'), completed: ids('TST100H5'), inProgress: [], planned: [] },
    ])
    expect(progress.courseIds).toEqual(ids('TST100H5', 'TST101H5', 'TST102H5', 'TST200H5', 'TST201H5'))
    expect(progress.completion).toBe('unmet')
  })

  it('is unknown without completion groups and when unparsed clauses remain', () => {
    const rows = record(['TST100H5', 'completed'])
    expect(engine.programProgress(program([{ rule: course('TST100H5'), category: 'admission' }]), rows).completion).toBe('unknown')
    expect(engine.programProgress(program([{ rule: course('TST100H5') }, { rule: unknown() }]), rows).completion).toBe('unknown')
  })

  it('does not treat a listed but unused OR option as shared between groups', () => {
    const target = program([{ rule: any(course('TST100H5'), course('TST101H5')) }, { rule: course('TST101H5') }])
    const progress = engine.programProgress(target, record(['TST100H5', 'completed'], ['TST101H5', 'completed']))
    expect(progress.groups.map(group => group.status)).toEqual(['met', 'met'])
    expect(progress.completion).toBe('met')
  })

  it('stays unknown when one course satisfies two groups', () => {
    const credits: Rule = { kind: 'credits', minimum: 0.5, courseIds: ids('TST100H5', 'TST101H5') }
    const target = program([{ rule: credits }, { rule: course('TST100H5') }])
    const progress = engine.programProgress(target, record(['TST100H5', 'completed']))
    expect(progress.groups.every(group => group.status === 'met')).toBe(true)
    expect(progress.completion).toBe('unknown')
  })

  it('is met when a credit pool can use a course no other group needs', () => {
    const credits: Rule = { kind: 'credits', minimum: 0.5, courseIds: ids('TST100H5', 'TST101H5') }
    for (const second of ['TST100H5', 'TST101H5']) {
      const progress = engine.programProgress(program([{ rule: credits }, { rule: course(second) }]), record(['TST100H5', 'completed'], ['TST101H5', 'completed']))
      expect(progress.completion, second).toBe('met')
    }
  })

  it('turns an unmet group unknown when the record holds one of its codes absent from this calendar', () => {
    const target = program([{ rule: course('TST100H5'), unresolved: ['TST190Y5'] }])
    expect(engine.programProgress(target, record(['TST190Y5', 'completed'])).groups[0].status).toBe('unknown')
    expect(engine.programProgress(target, record(['TST190Y5', 'inProgress'])).groups[0].status).toBe('unmet')
    expect(engine.programProgress(target, record()).groups[0].status).toBe('unmet')
  })
})

describe('nextCourses', () => {
  it('skips an OR already met by another course and the prerequisites of passed courses', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5' }, { code: 'TST102H5' }, { code: 'TST103H5' },
      { code: 'TST200H5', prereq: course('TST103H5') },
      { code: 'TST201H5', prereq: any(course('TST101H5'), course('TST102H5')) },
    ])
    const target = program([{ rule: all(course('TST200H5'), course('TST201H5')) }])
    const next = createEngine(data).nextCourses(target, record(['TST200H5', 'completed'], ['TST101H5', 'completed']))
    expect(next).toEqual([{ courseId: id('TST201H5'), eligibility: 'met', groups: ['g1'], unlocks: 0, reason: 'ready' }])
  })

  it('lets in-progress and planned courses fill requirements and never offers record courses', () => {
    const data = dataset([{ code: 'TST100H5' }, { code: 'TST101H5' }, { code: 'TST102H5' }, { code: 'TST103H5' }])
    const engine = createEngine(data)
    const target = program([{ rule: any(course('TST100H5'), course('TST101H5')) }, { rule: all(course('TST102H5'), course('TST103H5')) }])
    expect(nextIds(engine, target, [['TST100H5', 'inProgress'], ['TST102H5', 'planned']])).toEqual(ids('TST103H5'))
    expect(nextIds(engine, target, [['TST100H5', 'completed', 30]])).toEqual(ids('TST100H5', 'TST101H5', 'TST102H5', 'TST103H5'))
  })

  it('expands required courses that are not eligible, but only offers the options of an unmet OR', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5', prereq: course('TST105H5') }, { code: 'TST102H5' }, { code: 'TST105H5' },
      { code: 'TST300H5', prereq: all(course('TST100H5'), any(course('TST101H5'), course('TST102H5'))) },
      { code: 'TST301H5', prereq: course('TST105H5') },
    ])
    const engine = createEngine(data)
    const required = engine.nextCourses(program([{ rule: course('TST300H5') }]), record())
    expect(required.map(next => next.courseId).sort()).toEqual(ids('TST100H5', 'TST101H5', 'TST102H5', 'TST300H5'))
    // Bridges that no group references report the group that led to them.
    expect(required.find(next => next.courseId === id('TST100H5'))?.groups).toEqual(['g1'])
    expect(nextIds(engine, program([{ rule: any(course('TST300H5'), course('TST301H5')) }]), []).sort()).toEqual(ids('TST300H5', 'TST301H5'))
  })

  it('offers parsed and text-only references of unparsed groups without expanding them', () => {
    const data = dataset([{ code: 'TST100H5' }, { code: 'TST300H5', prereq: course('TST100H5') }, { code: 'TST301H5', prereq: course('TST100H5') }])
    const target = program([{ rule: all(unknown('One of the following'), course('TST300H5')), textIds: ['TST301H5', 'TST999H5', 'UTSG:TST100H1'] }])
    const next = createEngine(data).nextCourses(target, record())
    expect(next.map(entry => entry.courseId)).toEqual(ids('TST300H5', 'TST301H5'))
    expect(next.every(entry => entry.reason === 'needs-prerequisites')).toBe(true)
  })

  it('drops courses blocked by an exclusion, but keeps one that only may be excluded', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5', exclusion: course('TST100H5') }, { code: 'TST102H5' },
      { code: 'TST103H5', exclusion: { rule: unknown('TST100H5 (Winter 2025)'), extra: ['TST100H5'] } },
      { code: 'TST104H5', exclusion: { rule: { kind: 'true' }, unresolved: ['TST190Y5'] } },
    ])
    const target = program([{ rule: all(course('TST101H5'), course('TST102H5'), course('TST103H5'), course('TST104H5')) }])
    const next = createEngine(data).nextCourses(target, record(['TST100H5', 'completed'], ['TST190Y5', 'completed']))
    expect(next.map(entry => [entry.courseId, entry.eligibility])).toEqual([[id('TST102H5'), 'met'], [id('TST103H5'), 'unknown'], [id('TST104H5'), 'unknown']])
  })

  it('ranks ready courses first, then by program courses unlocked, then by group order (one per tier)', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5' },
      { code: 'TST200H5', prereq: unknown('Grade 12 Calculus') },
      { code: 'TST300H5', prereq: course('TST101H5') },
    ])
    const target = program([
      { rule: any(course('TST100H5'), course('TST101H5')) },
      { rule: course('TST200H5') },
      { rule: course('TST300H5') },
    ])
    expect(createEngine(data).nextCourses(target, record())).toEqual([
      { courseId: id('TST101H5'), eligibility: 'met', groups: ['g1'], unlocks: 1, reason: 'ready' },
      { courseId: id('TST100H5'), eligibility: 'met', groups: ['g1'], unlocks: 0, reason: 'ready' },
      { courseId: id('TST200H5'), eligibility: 'unknown', groups: ['g2'], unlocks: 0, reason: 'check-requirements' },
      { courseId: id('TST300H5'), eligibility: 'unmet', groups: ['g3'], unlocks: 0, reason: 'needs-prerequisites' },
    ])
  })

  it('ranks unknown before unmet, and unknown with a cited prerequisite taken before unknown with none taken', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5' },
      // Unknown, cites TST100H5, which is taken.
      { code: 'TST200H5', prereq: any(course('TST100H5'), unknown('Grade 12 Calculus')), restriction: 'Not open to students in program X.' },
      // Unknown, cites nothing (high-school wording only).
      { code: 'TST201H5', prereq: unknown('Grade 12 Advanced Functions') },
      // Unknown, cites TST101H5, which is not taken.
      { code: 'TST202H5', prereq: any(course('TST101H5'), unknown('or equivalent')) },
      // Unknown only because of a restriction; nothing cited.
      { code: 'TST203H5', restriction: 'Not open to students in program X.' },
      // Unmet, the best unlocker of all.
      { code: 'TST300H5', prereq: course('TST101H5') },
      { code: 'TST400H5', prereq: all(course('TST300H5'), course('TST202H5'), course('TST201H5')) },
      { code: 'TST401H5', prereq: course('TST300H5') },
    ])
    const target = program([
      { rule: any(course('TST300H5'), course('TST202H5'), course('TST201H5'), course('TST200H5'), course('TST203H5')) },
      { rule: any(course('TST400H5'), course('TST401H5')) },
    ])
    const next = createEngine(data).nextCourses(target, record(['TST100H5', 'completed']), 4)
    expect(next.map(entry => [entry.courseId, entry.eligibility, entry.unlocks])).toEqual([
      [id('TST201H5'), 'unknown', 1],
      [id('TST200H5'), 'unknown', 0],
      [id('TST203H5'), 'unknown', 0],
      [id('TST202H5'), 'unknown', 1],
    ])
    // The unmet course comes last although it unlocks the most.
    expect(createEngine(data).nextCourses(target, record(['TST100H5', 'completed'])).slice(4).map(entry => entry.courseId)).toEqual(ids('TST300H5', 'TST400H5', 'TST401H5'))
  })

  it('never lists a course before a listed prerequisite it still needs, directly or through another course', () => {
    const data = dataset([
      // TST300H5 is one option of TST400H5's prerequisite; TST300H5 itself needs an absent course.
      { code: 'TST300H5', prereq: course('TST290H5') },
      { code: 'TST400H5', prereq: any(course('TST300H5'), unknown('or equivalent')) },
      { code: 'TST410H5', prereq: course('TST400H5') },
      { code: 'TST411H5', prereq: course('TST400H5') },
      // TST200H5 needs TST150H5 (not offered), which needs TST100H5.
      { code: 'TST100H5', prereq: course('TST050H5') },
      { code: 'TST150H5', prereq: course('TST100H5') },
      { code: 'TST200H5', prereq: course('TST150H5') },
      { code: 'TST250H5', prereq: course('TST200H5') },
    ])
    // Unparsed groups: their courses are offered without expanding prerequisites.
    const opaque = (code: string) => ({ rule: all(unknown(), course(code)) })
    const target = program([opaque('TST400H5'), opaque('TST410H5'), opaque('TST411H5'), opaque('TST300H5'), opaque('TST200H5'), opaque('TST250H5'), opaque('TST100H5')])
    const next = createEngine(data).nextCourses(target, record())
    const order = next.map(entry => entry.courseId)
    // By tier and unlocks alone, TST400H5 (unknown, unlocks 2) would lead and TST200H5 (unlocks 1) would beat TST100H5 (unlocks 0).
    expect(next.find(entry => entry.courseId === id('TST400H5'))).toMatchObject({ eligibility: 'unknown', unlocks: 2 })
    expect(order.indexOf(id('TST300H5'))).toBeLessThan(order.indexOf(id('TST400H5')))
    expect(order.indexOf(id('TST100H5'))).toBeLessThan(order.indexOf(id('TST200H5')))
    expect(order.indexOf(id('TST200H5'))).toBeLessThan(order.indexOf(id('TST250H5')))
    // A truncated list keeps the prerequisite with its dependent.
    const top = nextIds(createEngine(data), target, [], 2)
    expect(top).toEqual(ids('TST300H5', 'TST400H5'))
  })

  it('imposes no order through a prerequisite option that is already satisfied', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5', prereq: course('TST050H5') },
      { code: 'TST200H5', prereq: any(course('TST100H5'), course('TST101H5')) },
      // Unknown overall, but its OR is met by TST100H5: TST101H5 is not needed.
      { code: 'TST201H5', prereq: all(any(course('TST100H5'), course('TST101H5')), unknown('Grade 12 Calculus')) },
    ])
    const target = program([{ rule: course('TST200H5') }, { rule: course('TST201H5') }, { rule: all(unknown(), course('TST101H5')) }])
    expect(createEngine(data).nextCourses(target, record(['TST100H5', 'completed'])).map(entry => [entry.courseId, entry.eligibility]))
      .toEqual([[id('TST200H5'), 'met'], [id('TST201H5'), 'unknown'], [id('TST101H5'), 'unmet']])
  })

  it('explains what is missing: prerequisites, or only corequisites', () => {
    const data = dataset([
      { code: 'TST100H5' }, { code: 'TST101H5' },
      { code: 'TST200H5', prereq: course('TST100H5'), coreq: course('TST101H5') },
      { code: 'TST201H5', coreq: course('TST101H5') },
      { code: 'TST202H5', prereq: unknown(), coreq: course('TST101H5') },
    ])
    const target = program([{ rule: all(unknown(), course('TST200H5'), course('TST201H5'), course('TST202H5')) }])
    const reasons = (rows: Row[]) => Object.fromEntries(createEngine(data).nextCourses(target, record(...rows)).map(entry => [entry.courseId, entry.reason]))
    expect(reasons([])).toEqual({ [id('TST200H5')]: 'needs-prerequisites', [id('TST201H5')]: 'needs-corequisites', [id('TST202H5')]: 'needs-corequisites' })
    expect(reasons([['TST100H5', 'completed']])[id('TST200H5')]).toBe('needs-corequisites')
    expect(reasons([['TST100H5', 'completed'], ['TST101H5', 'planned']])).toEqual({
      [id('TST200H5')]: 'ready', [id('TST201H5')]: 'ready', [id('TST202H5')]: 'check-requirements',
    })
  })

  it('returns at most 12 by default and honours an explicit limit', () => {
    const codes = Array.from({ length: 15 }, (_, i) => `TST${100 + i}H5`)
    const engine = createEngine(dataset(codes.map(code => ({ code }))))
    const target = program([{ rule: any(...codes.map(course)) }])
    expect(NEXT_COURSES_LIMIT).toBe(12)
    expect(nextIds(engine, target, [])).toEqual(ids(...codes.slice(0, 12)))
    expect(nextIds(engine, target, [], 3)).toEqual(ids(...codes.slice(0, 3)))
    expect(nextIds(engine, target, [], 0)).toEqual([])
  })
})

describe('whole-catalog performance', () => {
  const { dataset: real } = loadGraphDataset()
  const engine = createEngine(real)
  const taken = ['CSC108H5', 'CSC148H5', 'MAT102H5', 'MAT132H5', 'MAT134H5', 'STA107H5', 'ECO101H5', 'PSY100Y5', 'ISP100H5']
  const rows = record(...taken.map((code): Row => [code, 'completed', 78]), ['CSC207H5', 'inProgress'], ['CSC236H5', 'inProgress'], ['MAT223H5', 'planned'])

  it('evaluates every course not completed or in progress in under 50 ms', () => {
    engine.eligibility(rows)
    const times: number[] = []
    let size = 0
    for (let run = 0; run < 5; run++) {
      const start = performance.now()
      size = engine.eligibility(rows).size
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    expect(size).toBe(real.courses.length - taken.length - 2)
    expect(times[2]).toBeLessThan(50)
  })

  it('builds the indexes once in well under a frame budget', () => {
    const start = performance.now()
    createEngine(real)
    expect(performance.now() - start).toBeLessThan(100)
  })
})
