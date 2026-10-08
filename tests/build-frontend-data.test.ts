import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildCampusDatasets, buildRegistry, compareCodeUnits, DataBuildError, generateFrontendData,
  parseCampusRegistry, parseSubjectsFile, requirementRefs, serialise, summarise, toRequirementLite,
  type CampusSource, type SubjectsInput,
} from '../scripts/build-frontend-data'
import type { GraphCourse, RequirementLite } from '../src/data/schema'
import type { Catalog, Course, Program, ProgramGroup, Requirement, Rule } from '../src/domain/types'

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const catalog = readJson('data/utm/catalog.json') as Catalog
const registrySource = parseCampusRegistry(readJson('data/campuses.json'))
const subjectsInput = existsSync('data/utm/subjects.json') ? parseSubjectsFile(readJson('data/utm/subjects.json')) : null
const utm = campus('UTM')
const built = buildCampusDatasets(catalog, subjectsInput, utm)
const { graph, details, programs } = built

const REQUIREMENTS = [
  ['prerequisites', 'prereq'],
  ['corequisites', 'coreq'],
  ['exclusions', 'exclusion'],
  ['recommended', 'recommended'],
  ['restrictions', 'restriction'],
] as const

function campus(id: string): CampusSource {
  const found = registrySource.campuses.find(entry => entry.id === id)
  if (!found) throw new Error(`Campus missing from data/campuses.json: ${id}`)
  return found
}

function graphCourse(code: string): GraphCourse {
  const found = graph.courses.find(course => course.code === code)
  if (!found) throw new Error(`Course missing from graph: ${code}`)
  return found
}

function requirements(course: GraphCourse): RequirementLite[] {
  return REQUIREMENTS.flatMap(([, key]) => course[key] ?? [])
}

const sorted = (values: readonly string[]) => [...values].sort(compareCodeUnits)

// Synthetic fixtures for validation paths; the real catalog never triggers them.
const req = (rule: Rule = { kind: 'true' }, rawText = '', courseIds: string[] = [], extra: Partial<Requirement> = {}): Requirement => ({
  rawText, sourceUrl: 'https://utm.calendar.utoronto.ca/', rule, courseIds, ...extra,
})
const catalogIds = new Set(catalog.courses.map(entry => entry.id))
const isEmpty = (raw: Requirement) => raw.rawText.trim() === '' && raw.rule.kind === 'true'
  && raw.courseIds.length + (raw.mentionedIds?.length ?? 0) + (raw.unresolvedIds?.length ?? 0) === 0
const course = (code: string, options: Partial<Course> = {}): Course => ({
  id: `UTM:${code}`, campus: 'UTM', code, title: `Synthetic ${code}`, subject: code.slice(0, 3), level: Number(code[3]) * 100,
  credits: 0.5, description: '', sourceUrl: `https://utm.calendar.utoronto.ca/course/${code.toLowerCase()}`,
  contentHash: 'synthetic', fetchedAt: '2026-01-01T00:00:00+00:00', prerequisites: req(), corequisites: req(),
  exclusions: req(), recommended: req(), restrictions: req(), notes: '', ...options,
})
const synthetic = (courses: Course[]): Catalog => ({
  schemaVersion: 1,
  metadata: {
    campus: 'UTM', academicYear: '2026-2027', academicYearSource: '', fetchedAt: '2026-01-01T00:00:00+00:00',
    parserVersion: 'test', sources: [], complete: true,
  },
  courses,
  programs: [],
})

describe('graph dataset', () => {
  it('lists every catalog course exactly once, sorted by id', () => {
    const ids = graph.courses.map(entry => entry.id)
    expect(ids).toHaveLength(catalog.courses.length)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(sorted(catalog.courses.map(entry => entry.id)))
  })

  it('omits empty requirement fields, notes and distribution', () => {
    const byId = new Map(catalog.courses.map(entry => [entry.id, entry]))
    for (const entry of graph.courses) {
      const source = byId.get(entry.id)!
      for (const [field, key] of REQUIREMENTS) {
        expect(entry[key] === undefined, `${entry.id}.${key}`).toBe(isEmpty(source[field]))
      }
      for (const lite of requirements(entry)) {
        const refs = lite.ids.length + (lite.mentioned?.length ?? 0) + (lite.unresolved?.length ?? 0)
        expect(lite.text !== '' || lite.rule.kind !== 'true' || refs > 0, entry.id).toBe(true)
        for (const list of [lite.ids, lite.mentioned ?? [], lite.unresolved ?? []]) expect(list).toEqual(sorted([...new Set(list)]))
        expect(lite.mentioned).not.toEqual([])
        expect(lite.unresolved).not.toEqual([])
      }
      expect(entry.notes).not.toBe('')
      expect(entry.distribution).not.toBe('')
    }
  })

  it('keeps text-only requirements such as a recommended corequisite', () => {
    const coreq = graphCourse('CHM110H5').coreq
    expect(coreq?.text).toMatch(/^Recommended Corequisite/)
    expect(coreq?.rule).toEqual({ kind: 'true' })
    expect(coreq?.ids).toEqual([])
    expect(coreq?.mentioned).toContain('UTM:MAT135H5')
  })

  it('never draws an edge to a same-campus course that is not in the catalog', () => {
    for (const entry of graph.courses) {
      for (const lite of requirements(entry)) {
        for (const id of lite.ids) if (id.startsWith('UTM:')) expect(catalogIds.has(id), `${entry.id} -> ${id}`).toBe(true)
        for (const id of lite.unresolved ?? []) expect(catalogIds.has(id), `${entry.id} unresolved ${id}`).toBe(false)
        const edges = new Set(lite.ids)
        for (const id of lite.mentioned ?? []) expect(edges.has(id), `${entry.id} mentioned ${id}`).toBe(false)
      }
    }
    expect(graphCourse('HIN412Y5').prereq).toMatchObject({ ids: [], unresolved: ['UTM:HIN312Y5'] })
  })

  it('carries the parser roles: recovered edges, mentions and no self references', () => {
    expect(graphCourse('CSC236H5').prereq?.ids).toContain('UTM:CSC148H5')
    expect(graphCourse('ENG201Y5').prereq).toMatchObject({ ids: [], mentioned: ['UTM:ENG100H5'] })
    expect(graphCourse('LIN104H5').prereq).toMatchObject({ rule: { kind: 'true' }, ids: [], mentioned: ['UTM:LIN105H5'] })
    expect(graphCourse('PHL299Y5').coreq?.ids).toContain('UTM:PHL105Y5')
    for (const entry of graph.courses) {
      expect(entry.prereq?.ids ?? [], entry.id).not.toContain(entry.id)
      expect(entry.coreq?.ids ?? [], entry.id).not.toContain(entry.id)
    }
  })

  it('passes the delivery campus through', () => {
    expect(graphCourse('DRS121H5').deliveryCampus).toBe('Sheridan')
    expect(graph.courses.filter(entry => entry.deliveryCampus !== undefined)).toHaveLength(
      catalog.courses.filter(entry => entry.deliveryCampus).length)
    expect(graphCourse('CSC148H5')).not.toHaveProperty('deliveryCampus')
  })

  it('normalises requirement text', () => {
    for (const entry of graph.courses) {
      for (const lite of requirements(entry)) expect(lite.text).toBe(lite.text.replace(/\s+/g, ' ').trim())
    }
  })

  it('keeps the prerequisite reference CSC108H5 -> CSC148H5', () => {
    const prereq = graphCourse('CSC148H5').prereq
    expect(prereq?.ids).toContain('UTM:CSC108H5')
    expect(prereq?.rule).toEqual({ kind: 'course', courseId: 'UTM:CSC108H5' })
  })

  it('preserves references to other campuses as external ids', () => {
    const exclusion = graphCourse('CSC148H5').exclusion
    expect(exclusion?.ids).toEqual(expect.arrayContaining(['UTSG:CSC148H1', 'UTSC:CSCA48H3', 'UTM:CSC111H5']))
    const catalogRefs = new Set(catalog.courses.flatMap(entry => REQUIREMENTS.flatMap(([field]) => entry[field].courseIds)))
    const graphRefs = new Set(graph.courses.flatMap(entry => requirements(entry).flatMap(lite => lite.ids)))
    expect(sorted([...graphRefs])).toEqual(sorted([...catalogRefs]))
    expect([...graphRefs].some(id => id.startsWith('UTSG:'))).toBe(true)
  })

  it('takes metadata, sources and timestamps from the snapshot', () => {
    expect(graph.campus).toBe('UTM')
    expect(graph.academicYear).toBe(catalog.metadata.academicYear)
    expect(graph.fetchedAt).toBe(catalog.metadata.fetchedAt)
    expect(graph.generatedAt).toBe(catalog.metadata.fetchedAt)
    expect(graph.sources).toEqual({
      calendar: utm.calendarUrl,
      courseSearch: utm.courseSearchUrl,
      programSearch: utm.programSearchUrl,
      coursePageTemplate: utm.coursePageTemplate,
      programPageTemplate: utm.programPageTemplate,
    })
  })

  it('derives subjects and divisions from the courses present', () => {
    const codes = graph.subjects.map(subject => subject.code)
    expect(codes).toEqual(sorted([...new Set(catalog.courses.map(entry => entry.subject))]))
    expect(graph.subjects.reduce((sum, subject) => sum + subject.courseCount, 0)).toBe(catalog.courses.length)
    expect(graphCourse('CSC148H5').subject).toBe('CSC')
    expect(graph.subjects.find(subject => subject.code === 'CSC')?.courseCount)
      .toBe(catalog.courses.filter(entry => entry.subject === 'CSC').length)
    const divisionIds = graph.divisions.map(division => division.id)
    expect(new Set(divisionIds).size).toBe(divisionIds.length)
    expect(sorted([...new Set(graph.subjects.map(subject => subject.division))])).toEqual(sorted(divisionIds))
    for (const subject of graph.subjects) expect(subject.name).not.toBe('')
  })

  it.skipIf(subjectsInput === null)('describes every subject from subjects.json without fallbacks', () => {
    expect(built.warnings).toEqual([])
    for (const subject of graph.subjects) expect(subject.name, subject.code).not.toBe(subject.code)
  })

  it('stays under the 2.5 MB raw budget', () => {
    expect(Buffer.byteLength(serialise(graph))).toBeLessThan(2_500_000)
  })
})

describe('details dataset', () => {
  it('maps course ids to non-empty descriptions in id order', () => {
    const keys = Object.keys(details.descriptions)
    expect(keys).toEqual(sorted(keys))
    const withDescription = catalog.courses.filter(entry => entry.description.trim() !== '')
    expect(keys).toHaveLength(withDescription.length)
    for (const value of Object.values(details.descriptions)) expect(value).not.toBe('')
    expect(details.descriptions['UTM:CSC148H5']).toMatch(/^Abstract data types/)
  })
})

describe('programs dataset', () => {
  it('keeps all 168 programs, ordered by type then title', () => {
    expect(programs.programs).toHaveLength(168)
    expect(programs.programs).toHaveLength(catalog.programs.length)
    expect(new Set(programs.programs.map(program => program.id)).size).toBe(168)
    const order = ['Specialist', 'Major', 'Minor', 'Certificate', 'Focus']
    const rank = (type: string) => (order.includes(type) ? order.indexOf(type) : order.length)
    for (let i = 1; i < programs.programs.length; i++) {
      const [a, b] = [programs.programs[i - 1], programs.programs[i]]
      const byType = rank(a.type) - rank(b.type)
      expect(byType < 0 || (byType === 0 && compareCodeUnits(a.title, b.title) <= 0), `${a.id} before ${b.id}`).toBe(true)
    }
  })

  it('carries requirement groups with course ids for the Computer Science Major', () => {
    const major = programs.programs.find(program => program.code === 'ERMAJ1688')
    expect(major?.type).toBe('Major')
    expect(major?.groups.some(group => group.ids.length > 0)).toBe(true)
    expect(major?.groups.flatMap(group => group.ids)).toContain('UTM:CSC148H5')
    expect(major?.admissionText).not.toBe('')
    expect(major?.completionText).not.toBe('')
    const source = catalog.programs.find(program => program.code === 'ERMAJ1688')
    expect(major?.groups.map(group => group.id)).toEqual(source?.groups.map(group => group.id))
  })

  it('keeps excluded and retired codes out of program group ids', () => {
    const groups = new Map(catalog.programs.flatMap(program => program.groups).map(group => [group.id, group]))
    for (const program of programs.programs) {
      for (const group of program.groups) {
        const source = groups.get(group.id)!
        for (const id of source.mentionedIds ?? []) expect(group.ids, group.id).not.toContain(id)
        for (const id of source.unresolvedIds ?? []) expect(group.ids, group.id).not.toContain(id)
      }
    }
    const minor = programs.programs.find(program => program.code === 'ERMIN1688')
    const excepted = minor?.groups.find(group => group.text.includes('except for CSC392H5'))
    expect(excepted?.ids).toContain('UTM:GGR335H5')
    expect(excepted?.ids).not.toContain('UTM:CSC392H5')
  })

  it('carries the mentioned and retired codes of each group, sorted and never empty', () => {
    const sources = new Map(catalog.programs.flatMap(program => program.groups).map(group => [group.id, group]))
    let mentioned = 0
    let unresolved = 0
    for (const group of programs.programs.flatMap(program => program.groups)) {
      const source = sources.get(group.id)!
      expect(group.mentioned ?? [], group.id).toEqual(sorted(source.mentionedIds ?? []))
      expect(group.unresolved ?? [], group.id).toEqual(sorted(source.unresolvedIds ?? []))
      expect(group.mentioned).not.toEqual([])
      expect(group.unresolved).not.toEqual([])
      for (const id of group.unresolved ?? []) expect(catalogIds.has(id), `${group.id} unresolved ${id}`).toBe(false)
      mentioned += group.mentioned?.length ?? 0
      unresolved += group.unresolved?.length ?? 0
    }
    expect(mentioned).toBeGreaterThan(0)
    expect(unresolved).toBeGreaterThan(0)
    const excepted = programs.programs.find(program => program.code === 'ERMIN1688')?.groups
      .find(group => group.text.includes('except for CSC392H5'))
    expect(excepted?.mentioned).toContain('UTM:CSC392H5')
  })

  it('marks Focus programs whose code is the page slug', () => {
    const focus = programs.programs.filter(program => program.type === 'Focus')
    expect(focus.length).toBeGreaterThan(0)
    for (const program of focus) {
      expect(program.codeSource, program.id).toBe('url-slug')
      expect(program.code).toBe(program.id.slice('UTM:'.length))
    }
    for (const program of programs.programs.filter(entry => entry.type !== 'Focus')) {
      expect(program, program.id).not.toHaveProperty('codeSource')
    }
    expect(Object.keys(focus[0]).slice(0, 6)).toEqual(['id', 'code', 'title', 'type', 'codeSource', 'sourceUrl'])
  })

  it('never shows invented context as official group text', () => {
    for (const group of programs.programs.flatMap(program => program.groups)) {
      expect(group.text, group.id).not.toMatch(/Admission clauses depend/)
    }
    const major = programs.programs.find(program => program.code === 'ERMAJ1688')
    const stream = major?.groups.filter(group => group.label.startsWith('UTMCIP stream')) ?? []
    expect(stream.length).toBeGreaterThan(10)
    for (const group of stream.slice(1)) expect(group.text, group.id).not.toMatch(/UTMCIP/)
  })

  it('omits empty program notes', () => {
    for (const program of programs.programs) expect(program.notes).not.toBe('')
  })
})

describe('campus registry', () => {
  const registry = buildRegistry(registrySource, new Map([['UTM', summarise(built)]]))

  it('lists UTM as available with its data path and UTSG as planned', () => {
    const entry = registry.campuses.find(item => item.id === 'UTM')
    expect(entry).toMatchObject({
      status: 'available', dataPath: 'utm/', academicYear: catalog.metadata.academicYear,
      courseCount: catalog.courses.length, programCount: 168,
    })
    const planned = registry.campuses.find(item => item.id === 'UTSG')
    expect(planned?.status).toBe('planned')
    expect(planned).not.toHaveProperty('dataPath')
    expect(planned).not.toHaveProperty('courseCount')
    expect(registry.generatedAt).toBe(catalog.metadata.fetchedAt)
  })

  it('carries startSubjects from data/campuses.json and drops subjects the dataset lacks', () => {
    for (const entry of registry.campuses) expect(entry.startSubjects).toEqual(campus(entry.id).startSubjects)
    const withMissing = { ...registrySource, campuses: registrySource.campuses.map(entry => (
      entry.id === 'UTM' ? { ...entry, startSubjects: ['CSC', 'ZZZ'] } : entry)) }
    const rebuilt = buildRegistry(withMissing, new Map([['UTM', summarise(built)]]))
    expect(rebuilt.campuses.find(entry => entry.id === 'UTM')?.startSubjects).toEqual(['CSC'])
    expect(() => parseCampusRegistry({ schemaVersion: 1, campuses: [{ ...utm, startSubjects: ['csc'] }] })).toThrow(/startSubjects/)
  })

  it('refuses an available campus without a dataset', () => {
    expect(() => buildRegistry(registrySource, new Map())).toThrow(DataBuildError)
  })
})

describe('input validation', () => {
  it('fails on duplicate course ids', () => {
    expect(() => buildCampusDatasets(synthetic([course('TST100H5'), course('TST100H5')]), null, utm))
      .toThrow(/duplicate course id UTM:TST100H5/)
  })

  it('fails on malformed requirement ids', () => {
    const bad = course('TST200H5', { prerequisites: req({ kind: 'course', courseId: 'UTM:tst100' }, 'TST100', ['UTM:tst100']) })
    expect(() => buildCampusDatasets(synthetic([bad]), null, utm)).toThrow(/malformed course id/)
  })

  it('moves same-campus references missing from the catalog out of the edges', () => {
    const scope = { campus: 'UTM' as const, courseIds: new Set(['UTM:TST100H5']) }
    const legacy = req({ kind: 'any', items: [{ kind: 'course', courseId: 'UTM:TST100H5' }, { kind: 'course', courseId: 'UTM:OLD100H5' }] },
      'TST100H5 or OLD100H5', ['UTM:TST100H5', 'UTM:OLD100H5', 'UTSG:TST100H1'])
    expect(requirementRefs(legacy, scope)).toEqual({ ids: ['UTM:TST100H5', 'UTSG:TST100H1'], mentioned: [], unresolved: ['UTM:OLD100H5'] })
    const roles = req({ kind: 'course', courseId: 'UTM:OLD100H5' }, 'OLD100H5 (except TST100H5)', [],
      { mentionedIds: ['UTM:TST100H5'], unresolvedIds: ['UTM:OLD100H5'] })
    expect(toRequirementLite(roles, scope)).toEqual({
      text: 'OLD100H5 (except TST100H5)', rule: { kind: 'course', courseId: 'UTM:OLD100H5' }, ids: [],
      mentioned: ['UTM:TST100H5'], unresolved: ['UTM:OLD100H5'],
    })
    const mentionOnly = req({ kind: 'true' }, '', [], { mentionedIds: ['UTM:TST100H5'] })
    expect(toRequirementLite(mentionOnly, scope)).toMatchObject({ text: '', ids: [], mentioned: ['UTM:TST100H5'] })
  })

  it('projects a synthetic catalog with roles and a delivery campus', () => {
    const delivered = course('TST200H5', {
      deliveryCampus: 'Sheridan',
      prerequisites: req({ kind: 'course', courseId: 'UTM:TST100H5' }, 'TST100H5 (excluding TST150H5)', ['UTM:TST100H5'],
        { mentionedIds: ['UTM:TST150H5'] }),
    })
    const result = buildCampusDatasets(synthetic([course('TST100H5'), delivered]), null, utm)
    const projected = result.graph.courses.find(entry => entry.code === 'TST200H5')
    expect(projected?.deliveryCampus).toBe('Sheridan')
    expect(projected?.prereq).toMatchObject({ ids: ['UTM:TST100H5'], mentioned: ['UTM:TST150H5'] })
    const bad = course('TST300H5', { prerequisites: req(undefined, 'x', [], { mentionedIds: ['nope'] }) })
    expect(() => buildCampusDatasets(synthetic([bad]), null, utm)).toThrow(/malformed course id/)
  })

  it('projects program group roles and the code source of a synthetic program', () => {
    const group: ProgramGroup = {
      id: 'UTM:FOCUS-TEST:completion:1', label: 'Group A', category: 'completion', rawText: 'TST100H5 or OLD100H5 (except TST150H5)',
      sourceUrl: 'https://utm.calendar.utoronto.ca/program/focus-test', rule: { kind: 'course', courseId: 'UTM:TST100H5' },
      courseIds: ['UTM:TST100H5'], mentionedIds: ['UTM:TST150H5'], unresolvedIds: ['UTM:OLD100H5'],
    }
    const program: Program = {
      id: 'UTM:FOCUS-TEST', campus: 'UTM', code: 'FOCUS-TEST', title: 'Focus in Testing', type: 'Focus', codeSource: 'url-slug',
      description: '', sourceUrl: group.sourceUrl, contentHash: 'synthetic', fetchedAt: '2026-01-01T00:00:00+00:00',
      admission: req(), completion: req(), groups: [group], notes: '',
    }
    const projected = buildCampusDatasets({ ...synthetic([course('TST100H5'), course('TST150H5')]), programs: [program] }, null, utm)
      .programs.programs[0]
    expect(projected.codeSource).toBe('url-slug')
    expect(projected.groups[0]).toEqual({
      id: group.id, label: 'Group A', category: 'completion', text: group.rawText, rule: group.rule,
      ids: ['UTM:TST100H5'], mentioned: ['UTM:TST150H5'], unresolved: ['UTM:OLD100H5'],
    })
    const bad = { ...program, codeSource: 'guess' } as unknown as Program
    expect(() => buildCampusDatasets({ ...synthetic([course('TST100H5')]), programs: [bad] }, null, utm)).toThrow(/unsupported codeSource/)
  })

  it('fails on unsupported rule kinds', () => {
    const bad = course('TST200H5', { prerequisites: req({ kind: 'mystery' } as unknown as Rule, 'TST100H5') })
    expect(() => buildCampusDatasets(synthetic([bad]), null, utm)).toThrow(/unsupported rule kind/)
  })

  it('fails on a catalog from another campus', () => {
    expect(() => buildCampusDatasets(synthetic([course('TST100H5')]), null, campus('UTSG'))).toThrow(DataBuildError)
  })

  it('warns and falls back when a subject is missing from subjects.json', () => {
    const input: SubjectsInput = {
      divisions: [{ id: 'sciences', label: 'Sciences' }, { id: 'humanities', label: 'Humanities' }],
      subjects: [{ code: 'TST', name: 'Testing', department: 'Test Studies', division: 'Sciences' }],
    }
    const result = buildCampusDatasets(synthetic([course('TST100H5'), course('ABC100H5')]), input, utm)
    expect(result.warnings.join('\n')).toMatch(/missing from subjects\.json.*ABC/)
    expect(result.graph.subjects).toEqual([
      { code: 'ABC', name: 'ABC', department: '', division: 'interdisciplinary', courseCount: 1 },
      { code: 'TST', name: 'Testing', department: 'Test Studies', division: 'sciences', courseCount: 1 },
    ])
    expect(result.graph.divisions).toEqual([
      { id: 'sciences', label: 'Sciences' },
      { id: 'interdisciplinary', label: 'Interdisciplinary' },
    ])
  })

  it('falls back for every subject when subjects.json is absent', () => {
    const result = buildCampusDatasets(synthetic([course('TST100H5')]), null, utm)
    expect(result.warnings.join('\n')).toMatch(/subjects\.json not found/)
    expect(result.graph.subjects[0]).toMatchObject({ name: 'TST', department: '', division: 'interdisciplinary' })
  })

  it('accepts subjects.json as an array or as a map keyed by code', () => {
    const asArray = parseSubjectsFile({
      divisions: [{ id: 'sciences', label: 'Sciences' }],
      subjects: [{ code: 'CSC', name: 'Computer Science', department: 'MCS', division: 'sciences' }],
    })
    const asMap = parseSubjectsFile({
      divisions: { sciences: 'Sciences' },
      subjects: { CSC: { name: 'Computer Science', department: 'MCS', division: 'sciences' } },
    })
    expect(asMap).toEqual(asArray)
    expect(() => parseSubjectsFile({ subjects: [{ code: 'CSC' }, { code: 'CSC' }] })).toThrow(/duplicate code CSC/)
    expect(() => parseSubjectsFile('nonsense')).toThrow(DataBuildError)
  })
})

describe('determinism', () => {
  it('produces identical datasets on every run', () => {
    const again = buildCampusDatasets(catalog, subjectsInput, utm)
    expect(again).toEqual(built)
    expect(serialise(again.graph)).toBe(serialise(graph))
    expect(serialise(again.programs)).toBe(serialise(programs))
  })

  it('serialises compactly with a single trailing newline', () => {
    const text = serialise(graph)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.indexOf('\n')).toBe(text.length - 1)
    expect(text.startsWith('{"schemaVersion":1,"campus":"UTM"')).toBe(true)
  })

  it('generates the same files from disk twice', () => {
    const first = generateFrontendData(process.cwd())
    const second = generateFrontendData(process.cwd())
    expect(first.files.map(file => file.path)).toEqual([
      'public/data/campuses.json',
      'public/data/utm/graph.json',
      'public/data/utm/details.json',
      'public/data/utm/programs.json',
    ])
    expect(second.files).toEqual(first.files)
  })

  // Fails when data/ changed without `npm run data:build` (same as the --check flag).
  it.skipIf(!existsSync('public/data/campuses.json'))('matches the committed public/data files', () => {
    for (const file of generateFrontendData(process.cwd()).files) {
      expect(existsSync(file.path), file.path).toBe(true)
      expect(readFileSync(file.path, 'utf8') === file.content, `${file.path} is stale; run npm run data:build`).toBe(true)
    }
  })
})
