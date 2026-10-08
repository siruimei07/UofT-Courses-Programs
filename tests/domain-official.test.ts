// Official-prose regressions: parser output through the rule engine, on the committed UTM catalog.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GraphDataset, ProgramLite, RequirementLite } from '../src/data/schema'
import { createEngine } from '../src/domain'
import type { Catalog, Program, ProgramGroup, RecordEntryLike, Requirement } from '../src/domain'
import { datasetFromCatalog } from './helpers/dataset'

const catalog = JSON.parse(readFileSync('data/utm/catalog.json', 'utf8')) as Catalog

/** The catalog projection plus the codes absent from this calendar, as scripts/build-frontend-data.ts ships them. */
function withAbsentCodes(dataset: GraphDataset): GraphDataset {
  const source = new Map(catalog.courses.map(course => [course.id, course]))
  const fields = [['prereq', 'prerequisites'], ['coreq', 'corequisites'], ['exclusion', 'exclusions']] as const
  const add = (lite: RequirementLite | undefined, full: Requirement) =>
    (lite && full.unresolvedIds?.length ? { ...lite, unresolved: full.unresolvedIds } : lite)
  return {
    ...dataset,
    courses: dataset.courses.map(course => {
      const next = { ...course }
      for (const [lite, full] of fields) {
        const field = add(next[lite], source.get(course.id)![full])
        if (field) next[lite] = field
      }
      return next
    }),
  }
}

const engine = createEngine(withAbsentCodes(datasetFromCatalog()))
type Row = [string, RecordEntryLike['status'], number?]
const record = (...rows: Row[]) =>
  new Map(rows.map(([code, status, grade]) => [`UTM:${code}`, grade === undefined ? { status } : { status, grade }] as [string, RecordEntryLike]))
const completed = (codes: string[]) => record(...codes.map((code): Row => [code, 'completed', 80]))
function programLite(program: Program, groups: ProgramGroup[] = program.groups): ProgramLite {
  return {
    id: program.id, code: program.code, title: program.title, type: program.type, sourceUrl: program.sourceUrl,
    description: '', admissionText: program.admission.rawText, completionText: program.completion.rawText,
    groups: groups.map(group => ({ id: group.id, label: group.label, category: group.category, text: group.rawText, rule: group.rule, ids: group.courseIds })),
  }
}
function programByCode(code: string): Program {
  const found = catalog.programs.find(program => program.code === code)
  if (!found) throw new Error(`Official regression program missing: ${code}`)
  return found
}
const prerequisiteStatus = (code: string, records: string[]) => {
  const evaluation = engine.evaluateCourse(`UTM:${code}`, completed(records))
  if (!evaluation.prerequisites) throw new Error(`Official regression course has no prerequisites: ${code}`)
  return evaluation.prerequisites.status
}
const groupStatus = (program: Program, group: ProgramGroup, records: string[]) =>
  engine.programProgress(programLite(program, [group]), completed(records)).groups[0].status

describe('official prose scope regression: parser through rule evaluation', () => {
  it.each([
    ['CCT371H5', ['CCT110H5']],
    ['GGR214H5', ['ENV100Y5']],
    ['ENV495H5', ['BIO205H5']],
    ['GGR315H5', ['GGR217H5']],
  ])('%s does not bypass a total-credit requirement via the second including alternative', (code, records) => {
    // The official wording scopes a total-credit minimum over the entire including list.
    expect(prerequisiteStatus(code, records)).not.toBe('met')
  })

  it.each(['JLP481H5', 'JLP483H5'])('%s does not accept one pool course in place of both its bridge and required credit amount', code => {
    expect(prerequisiteStatus(code, ['LIN328H5'])).not.toBe('met')
  })

  it.each([
    ['FRE180H5', 'FSL206H5'],
    ['FRE181H5', 'FRE180H5'],
    ['FSL106H5', 'FSL105H5'],
  ])('%s retains the independent placement-test/student-group clause', (code, record) => {
    expect(prerequisiteStatus(code, [record])).not.toBe('met')
  })

  it('keeps a co-op-only admission leaf conditional and does not expand it', () => {
    const program = programByCode('ERSPE1025')
    const group = program.groups.find(group => group.category === 'admission' && group.label.includes('UTMCIP') && group.rawText.includes('ISP100H5'))!
    expect(group).toBeDefined()
    expect(groupStatus(program, group, ['ISP100H5'])).toBe('unknown')
    const next = engine.nextCourses(programLite(program, [group]), new Map())
    expect(next.map(entry => entry.courseId)).toContain('UTM:ISP100H5')
    expect(next.every(entry => group.courseIds.includes(entry.courseId))).toBe(true)
  })

  it('does not treat one elective-list reference as meeting the full list allocation', () => {
    const program = programByCode('ERMAJ0727')
    const group = program.groups.find(group => group.category === 'completion' && group.label.includes('Group B') && group.courseIds.includes('UTM:ANT205H5'))!
    expect(group).toBeDefined()
    expect(groupStatus(program, group, ['ANT205H5'])).not.toBe('met')
  })

  it('requires the stated decimal credits before satisfying a program course pool', () => {
    const program = programByCode('ERMAJ1034')
    const group = program.groups.find(group => group.id === 'UTM:ERMAJ1034:completion:6')!
    expect(group.rawText).toContain('1.0 credit')
    expect(groupStatus(program, group, [])).toBe('unmet')
    expect(groupStatus(program, group, ['CCT200H5'])).toBe('unmet')
    expect(groupStatus(program, group, ['CCT200H5', 'CCT206H5'])).toBe('met')

    const italian = programByCode('ERMAJ1249')
    const halfCredit = italian.groups.find(group => group.id === 'UTM:ERMAJ1249:completion:5')!
    expect(halfCredit.rawText).toContain('0.5 credit')
    expect(groupStatus(italian, halfCredit, ['ITA351H5'])).toBe('met')
  })

  it('offers Neuroscience cluster references as options without expanding their prerequisites', () => {
    const program = programByCode('ERSPE2470')
    const cluster = program.groups.find(group => group.label.startsWith('Cluster A'))!
    expect(groupStatus(program, cluster, cluster.courseIds.map(id => id.slice(4)))).toBe('unknown')
    const next = engine.nextCourses(programLite(program, [cluster]), new Map(), 50)
    expect(next.some(entry => entry.courseId === 'UTM:BIO318Y5')).toBe(true)
    expect(next.every(entry => cluster.courseIds.includes(entry.courseId))).toBe(true)
  })

  it('does not reach through an OR already met by another course (CS Major take-next)', () => {
    const program = programLite(programByCode('ERMAJ1688'))
    const record = completed(['CSC108H5', 'CSC148H5', 'CSC207H5', 'CSC236H5', 'MAT102H5', 'MAT132H5', 'MAT134H5', 'MAT223H5', 'STA107H5'])
    const next = engine.nextCourses(program, record, 1000)
    expect(next.length).toBeGreaterThan(12)
    // CSC263H5's statistics OR is met by STA107H5, so ECO227Y5's prerequisites are never offered.
    expect(next.map(entry => entry.courseId)).not.toContain('UTM:ECO101H5')
    expect(next.every(entry => !record.has(entry.courseId))).toBe(true)
    expect(engine.nextCourses(program, record)).toHaveLength(12)
  })
})

describe('official data: take-next ranking (CS Major)', () => {
  const program = programLite(programByCode('ERMAJ1688'))
  const firstYear = record(['CSC108H5', 'completed', 80], ['MAT102H5', 'completed', 75], ['MAT132H5', 'completed', 70],
    ['ISP100H5', 'completed', 80], ['CSC148H5', 'inProgress'], ['MAT134H5', 'inProgress'])
  const tiers = { met: 0, unknown: 1, unmet: 2 }

  it('puts courses the student can take ahead of ones they cannot, for an empty record', () => {
    const next = engine.nextCourses(program, new Map(), 1000)
    const order = next.map(entry => entry.courseId)
    expect(next[0].reason).toBe('ready')
    expect(next.slice(0, 5).every(entry => entry.eligibility !== 'unmet')).toBe(true)
    expect(order.indexOf('UTM:CSC108H5')).toBeLessThan(order.indexOf('UTM:CSC148H5'))
    expect(order.indexOf('UTM:CSC108H5')).toBeLessThan(12)
  })

  it('ranks a prerequisite ahead of its dependent and needs-prerequisites after check-requirements (first-year record)', () => {
    const next = engine.nextCourses(program, firstYear, 1000)
    const order = next.map(entry => entry.courseId)
    expect(next[0]).toMatchObject({ eligibility: 'met', reason: 'ready' })
    expect(order.indexOf('UTM:CSC207H5')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('UTM:CSC207H5')).toBeLessThan(order.indexOf('UTM:CSC209H5'))
    const firstUnmet = next.findIndex(entry => entry.eligibility === 'unmet')
    expect(firstUnmet).toBeGreaterThan(0)
    // Tiers never go back, except where a dependent waits for its listed prerequisite.
    const moved = next.filter((entry, i) => i > 0 && tiers[entry.eligibility] < tiers[next[i - 1].eligibility])
    for (const entry of moved) {
      const prerequisites = engine.evaluateCourse(entry.courseId, firstYear).prerequisites
      expect(prerequisites?.status, entry.courseId).not.toBe('met')
    }
  })
})

describe('official data: codes absent from this calendar on older records', () => {
  it('MAT137Y5 (retired) only "may exclude" MAT137H5, and still meets nothing for certain', () => {
    const rows = completed(['MAT137Y5'])
    expect(engine.evaluateCourse('UTM:MAT137H5', rows).exclusions).toEqual({ status: 'unknown', blockedBy: ['UTM:MAT137Y5'] })
    expect(engine.evaluateCourse('UTM:MAT137H5', completed(['MAT135H5'])).exclusions?.status).toBe('blocked')
  })

  it('ECO200Y5 whose corequisite cites MAT137Y5 becomes unknown, not unmet', () => {
    const rows = record(['ECO101H5', 'completed', 80], ['ECO102H5', 'completed', 80], ['MAT137Y5', 'completed'])
    const result = engine.evaluateCourse('UTM:ECO200Y5', rows)
    expect(result.prerequisites?.status).toBe('met')
    expect(result.corequisites?.status).toBe('unknown')
    expect(result.overall).toBe('unknown')
    expect(engine.evaluateCourse('UTM:ECO200Y5', completed(['ECO101H5', 'ECO102H5'])).corequisites?.status).toBe('unmet')
  })

  it('a dated special-topics exclusion (ANT450H5: "ANT433H5 (Winter 2025)") only may exclude', () => {
    const result = engine.evaluateCourse('UTM:ANT450H5', completed(['ANT204H5', 'ANT433H5']))
    expect(result.exclusions).toEqual({ status: 'unknown', blockedBy: ['UTM:ANT433H5'] })
    expect(result.overall).toBe('unknown')
  })
})

describe('official data: enrolment-priority restrictions (spec 19.9)', () => {
  it('CSC258H5 is available once CSC148H5 is done: its restriction only gives enrolment priority', () => {
    const result = engine.evaluateCourse('UTM:CSC258H5', record(['CSC108H5', 'completed', 80], ['CSC148H5', 'inProgress']))
    expect(result.restrictions).toMatchObject({ kind: 'true', status: 'met' })
    expect(result.restrictions?.text).toMatch(/^Priority is given to students enrolled in/)
    expect(result.overall).toBe('met')
  })

  it('a restriction that limits enrolment keeps the course unknown', () => {
    const restricted = catalog.courses.find(course => /^Restricted to students enrolled in/.test(course.restrictions.rawText))!
    expect(restricted).toBeDefined()
    expect(engine.evaluateCourse(restricted.id, new Map()).restrictions).toMatchObject({ kind: 'unknown', status: 'unknown' })
  })
})
