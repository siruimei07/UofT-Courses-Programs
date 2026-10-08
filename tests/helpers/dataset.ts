// GraphDataset loaders for tests: the generated frontend file when present, otherwise a minimal
// inline projection of the backend catalog (following src/data/schema.ts), plus a synthetic builder.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CampusId, Division, GraphCourse, GraphDataset, RequirementLite, SubjectInfo } from '../../src/data/schema'
import type { Catalog, Requirement, Rule } from '../../src/domain/types'
import type { PresentationInput } from '../../src/graph/types'

const FALLBACK_DIVISION = 'interdisciplinary'

export interface LoadedDataset {
  dataset: GraphDataset
  source: 'public' | 'catalog'
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Set GRAPH_TEST_DATASET=catalog to skip public/data and test against the catalog projection. */
export function loadGraphDataset(dataDir = 'utm', root = process.cwd()): LoadedDataset {
  const generated = join(root, 'public', 'data', dataDir, 'graph.json')
  if (process.env.GRAPH_TEST_DATASET !== 'catalog' && existsSync(generated)) {
    try {
      const raw = readJson(generated)
      if (isRecord(raw) && raw.schemaVersion === 1 && Array.isArray(raw.courses)) {
        return { dataset: raw as unknown as GraphDataset, source: 'public' }
      }
    } catch {
      // Another process may be rewriting the file; the catalog projection is equivalent.
    }
  }
  return { dataset: datasetFromCatalog(dataDir, root), source: 'catalog' }
}

export function datasetFromCatalog(dataDir = 'utm', root = process.cwd()): GraphDataset {
  const catalog = readJson(join(root, 'data', dataDir, 'catalog.json')) as Catalog
  const subjectsPath = join(root, 'data', dataDir, 'subjects.json')
  let subjectsFile: unknown = null
  try {
    if (existsSync(subjectsPath)) subjectsFile = readJson(subjectsPath)
  } catch {
    subjectsFile = null
  }
  const registry = readJson(join(root, 'data', 'campuses.json')) as { campuses: Record<string, string>[] }
  const campus = registry.campuses.find(entry => entry.dataDir === dataDir) ?? {}
  const { divisions, subjects } = buildSubjects(catalog, subjectsFile)
  return {
    schemaVersion: 1,
    campus: (campus.id ?? catalog.metadata.campus) as CampusId,
    academicYear: catalog.metadata.academicYear,
    fetchedAt: catalog.metadata.fetchedAt,
    generatedAt: catalog.metadata.fetchedAt,
    sources: {
      calendar: campus.calendarUrl ?? '',
      courseSearch: campus.courseSearchUrl ?? '',
      programSearch: campus.programSearchUrl ?? '',
      coursePageTemplate: campus.coursePageTemplate ?? '',
      programPageTemplate: campus.programPageTemplate ?? '',
    },
    divisions,
    subjects,
    courses: catalog.courses
      .map((course): GraphCourse => ({
        id: course.id,
        code: course.code,
        title: text(course.title),
        subject: course.subject,
        level: course.level,
        credits: course.credits,
        ...optional('distribution', text(course.distribution)),
        ...optional('prereq', requirement(course.prerequisites)),
        ...optional('coreq', requirement(course.corequisites)),
        ...optional('exclusion', requirement(course.exclusions)),
        ...optional('recommended', requirement(course.recommended)),
        ...optional('restriction', requirement(course.restrictions)),
        ...optional('notes', text(course.notes)),
      }))
      .sort((a, b) => compareText(a.id, b.id)),
  }
}

const optional = <K extends string, V>(key: K, value: V | undefined | '') =>
  (value === undefined || value === '' ? {} : { [key]: value }) as Partial<Record<K, V>>

function requirement(req: Requirement | undefined): RequirementLite | undefined {
  const body = text(req?.rawText)
  if (!req || !body) return undefined
  return { text: body, rule: req.rule, ids: req.courseIds }
}

interface SubjectEntry { name: string; department: string; division: string }

/** Tolerates `{ divisions?, subjects: [...] | {CODE: ...} }`, a bare array or a bare map. */
function parseSubjectsFile(raw: unknown): { divisions: Division[]; entries: Map<string, SubjectEntry> } {
  const container = isRecord(raw) && 'subjects' in raw ? raw : { subjects: raw }
  const list = container.subjects
  const pairs: [unknown, unknown][] = Array.isArray(list)
    ? list.map(item => [isRecord(item) ? item.code : undefined, item])
    : isRecord(list) ? Object.entries(list) : []
  const entries = new Map<string, SubjectEntry>()
  for (const [code, value] of pairs) {
    if (typeof code !== 'string' || !isRecord(value)) continue
    const division = isRecord(value.division) ? value.division.id : value.division
    entries.set(code, { name: text(value.name), department: text(value.department), division: text(division) })
  }
  const rawDivisions = container.divisions
  const divisionPairs: [unknown, unknown][] = Array.isArray(rawDivisions)
    ? rawDivisions.map(item => (isRecord(item) ? [item.id, item.label] : [item, item]))
    : isRecord(rawDivisions) ? Object.entries(rawDivisions).map(([id, value]) => [id, isRecord(value) ? value.label : value]) : []
  const divisions = divisionPairs
    .filter((pair): pair is [string, unknown] => typeof pair[0] === 'string' && pair[0] !== '')
    .map(([id, label]) => ({ id, label: text(label) || id }))
  return { divisions, entries }
}

function buildSubjects(catalog: Catalog, subjectsFile: unknown): { divisions: Division[]; subjects: SubjectInfo[] } {
  const { divisions: declared, entries } = parseSubjectsFile(subjectsFile)
  const counts = new Map<string, number>()
  for (const course of catalog.courses) counts.set(course.subject, (counts.get(course.subject) ?? 0) + 1)
  const subjects = [...counts.keys()].sort(compareText).map((code): SubjectInfo => {
    const entry = entries.get(code)
    return {
      code,
      name: entry?.name || code,
      department: entry?.department ?? '',
      division: entry?.division || FALLBACK_DIVISION,
      courseCount: counts.get(code) ?? 0,
    }
  })
  const used = new Set(subjects.map(subject => subject.division))
  const divisions = declared.filter(division => used.has(division.id))
  for (const id of [...used].sort(compareText)) {
    if (!divisions.some(division => division.id === id)) divisions.push({ id, label: id })
  }
  return { divisions, subjects }
}

// ---------------------------------------------------------------------------
// Synthetic datasets for focused unit tests.

export interface SyntheticCourse {
  code: string
  /** Defaults to the first digit of the number × 100. */
  level?: number
  prereq?: string[]
  coreq?: string[]
}

const ruleOf = (ids: string[]): Rule =>
  ids.length === 1 ? { kind: 'course', courseId: ids[0] } : { kind: 'all', items: ids.map(courseId => ({ kind: 'course', courseId })) }
const syntheticRequirement = (codes: string[] | undefined): RequirementLite | undefined => {
  if (!codes?.length) return undefined
  const ids = codes.map(code => (code.includes(':') ? code : `UTM:${code}`))
  return { text: codes.join(', '), rule: ruleOf(ids), ids }
}

export function syntheticDataset(
  courses: SyntheticCourse[],
  subjects: Array<Pick<SubjectInfo, 'code' | 'division'> & Partial<SubjectInfo>> = [],
  divisions: Division[] = [],
): GraphDataset {
  return {
    schemaVersion: 1,
    campus: 'UTM',
    academicYear: 'synthetic',
    fetchedAt: '',
    generatedAt: '',
    sources: { calendar: '', courseSearch: '', programSearch: '', coursePageTemplate: '', programPageTemplate: '' },
    divisions,
    subjects: subjects.map(subject => ({ name: subject.code, department: '', courseCount: 0, ...subject })),
    courses: courses
      .map((course): GraphCourse => ({
        id: `UTM:${course.code}`,
        code: course.code,
        title: `Synthetic ${course.code}`,
        subject: course.code.slice(0, 3),
        level: course.level ?? Number(course.code[3]) * 100,
        credits: 0.5,
        ...optional('prereq', syntheticRequirement(course.prereq)),
        ...optional('coreq', syntheticRequirement(course.coreq)),
      }))
      .sort((a, b) => compareText(a.id, b.id)),
  }
}

/** Neutral app state (nothing focused, no filters); override what a test needs. */
export function presentationInput(overrides: Partial<PresentationInput> = {}): PresentationInput {
  return {
    focusId: null,
    depth: 'all',
    hideUnrelated: false,
    hideCompleted: false,
    showAllEdges: false,
    levels: null,
    subjects: null,
    programIds: null,
    record: new Map(),
    eligibility: null,
    ...overrides,
  }
}
