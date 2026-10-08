// Official-prose regressions: parser output through the rule engine, on the committed UTM catalog.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ProgramLite } from '../src/data/schema'
import { createEngine } from '../src/domain'
import type { Catalog, Program, ProgramGroup, RecordEntryLike } from '../src/domain'
import { datasetFromCatalog } from './helpers/dataset'

const catalog = JSON.parse(readFileSync('data/utm/catalog.json', 'utf8')) as Catalog
const engine = createEngine(datasetFromCatalog())
const completed = (codes: string[]) =>
  new Map(codes.map(code => [`UTM:${code}`, { status: 'completed', grade: 80 }] as [string, RecordEntryLike]))
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
    const next = engine.nextCourses(program, record)
    // CSC263H5's statistics OR is met by STA107H5, so ECO227Y5's prerequisites are never offered.
    expect(next.map(entry => entry.courseId)).not.toContain('UTM:ECO101H5')
    expect(next.length).toBeLessThanOrEqual(12)
    expect(next.every(entry => !record.has(entry.courseId))).toBe(true)
  })
})
