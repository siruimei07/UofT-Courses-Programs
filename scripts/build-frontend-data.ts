// Frontend data generator: projects the backend datasets in data/ onto the compact files the
// static site loads from public/data/ (contract: src/data/schema.ts).
//
//   npx tsx scripts/build-frontend-data.ts           write public/data/** and print sizes
//   npx tsx scripts/build-frontend-data.ts --check   exit 1 when public/data/** is out of date
//
// The builders are pure and exported for tests; only the CLI at the bottom touches the disk.
// Output is deterministic: fixed key order, code-unit sorting, timestamps taken from the
// snapshot instead of the clock.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import type {
  CampusEntry, CampusId, CampusRegistry, CampusStatus, DetailsDataset, Division, GraphCourse,
  GraphDataset, ProgramGroupLite, ProgramLite, ProgramsDataset, RequirementLite, SubjectInfo,
} from '../src/data/schema'
import { ruleCourseIds } from '../src/domain/rules'
import type { Catalog, Course, Program, ProgramGroup, Requirement, Rule } from '../src/domain/types'

/** One entry of data/campuses.json (the backend registry). */
export interface CampusSource {
  id: CampusId
  name: string
  shortName: string
  status: CampusStatus
  /** Folder under data/ and public/data/, e.g. `utm`. */
  dataDir: string
  calendarUrl: string
  courseSearchUrl: string
  programSearchUrl: string
  coursePageTemplate: string
  programPageTemplate: string
  campusDigit?: string
  /** Subject codes shown first on a first visit. */
  startSubjects?: string[]
}

/** What a requirement's ids are resolved against: same-campus ids must be catalog courses. */
export interface IdScope {
  campus: CampusId
  courseIds: ReadonlySet<string>
}

export interface CampusSourceRegistry {
  schemaVersion: 1
  campuses: CampusSource[]
}

export interface SubjectSource {
  code: string
  name: string
  department: string
  division: string
}

/** data/<campus>/subjects.json after normalisation. */
export interface SubjectsInput {
  divisions: Division[]
  subjects: SubjectSource[]
}

export interface CampusDatasets {
  graph: GraphDataset
  details: DetailsDataset
  programs: ProgramsDataset
  warnings: string[]
}

export interface CampusSummary {
  academicYear: string
  fetchedAt: string
  courseCount: number
  programCount: number
  /** Subject codes present in the dataset. */
  subjects: string[]
}

export interface GeneratedFile {
  /** Repo-relative POSIX path. */
  path: string
  content: string
}

export interface Generation {
  files: GeneratedFile[]
  warnings: string[]
}

/** Thrown for input problems that must stop the build; lists every issue found. */
export class DataBuildError extends Error {
  readonly issues: string[]

  constructor(context: string, issues: string[]) {
    const shown = issues.slice(0, 40).map(issue => `  - ${issue}`)
    if (issues.length > shown.length) shown.push(`  ... and ${issues.length - shown.length} more`)
    super(`${context}: ${issues.length} error(s)\n${shown.join('\n')}`)
    this.name = 'DataBuildError'
    this.issues = issues
  }
}

const CAMPUS_IDS: readonly string[] = ['UTM', 'UTSG', 'UTSC'] satisfies CampusId[]
const CAMPUS_STATUSES: readonly string[] = ['available', 'planned'] satisfies CampusStatus[]
const COURSE_REF = /^(UTM|UTSG|UTSC|external):[A-Z0-9]+$/
const PROGRAM_TYPE_ORDER = ['Specialist', 'Major', 'Minor', 'Certificate', 'Focus']
const FALLBACK_DIVISION = 'interdisciplinary'
const EPOCH = '1970-01-01T00:00:00+00:00'

const REQUIREMENT_FIELDS = [
  ['prerequisites', 'prereq'],
  ['corequisites', 'coreq'],
  ['exclusions', 'exclusion'],
  ['recommended', 'recommended'],
  ['restrictions', 'restriction'],
] as const

// ---------------------------------------------------------------------------
// Small helpers

/** Locale-independent ordering, so output never depends on the machine's ICU data. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function normaliseText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

function uniqueSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCodeUnits)
}

function titleCase(id: string): string {
  return id.split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Compact JSON with a trailing newline. Key order is the construction order of the builders. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

// ---------------------------------------------------------------------------
// Input parsing

export function parseCampusRegistry(raw: unknown): CampusSourceRegistry {
  const errors: string[] = []
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.campuses)) {
    throw new DataBuildError('data/campuses.json', ['expected { schemaVersion: 1, campuses: [...] }'])
  }
  const seen = new Set<string>()
  raw.campuses.forEach((entry: unknown, index) => {
    const where = `campuses[${index}]`
    if (!isRecord(entry)) {
      errors.push(`${where}: not an object`)
      return
    }
    if (typeof entry.id !== 'string' || !CAMPUS_IDS.includes(entry.id)) errors.push(`${where}: unknown campus id ${JSON.stringify(entry.id)}`)
    else if (seen.has(entry.id)) errors.push(`${where}: duplicate campus id ${entry.id}`)
    else seen.add(entry.id)
    if (typeof entry.status !== 'string' || !CAMPUS_STATUSES.includes(entry.status)) errors.push(`${where}: invalid status ${JSON.stringify(entry.status)}`)
    if (typeof entry.dataDir !== 'string' || !/^[a-z0-9-]+$/.test(entry.dataDir)) errors.push(`${where}: invalid dataDir ${JSON.stringify(entry.dataDir)}`)
    for (const key of ['name', 'shortName', 'calendarUrl', 'courseSearchUrl', 'programSearchUrl', 'coursePageTemplate', 'programPageTemplate']) {
      if (!isText(entry[key])) errors.push(`${where}: missing ${key}`)
    }
    const start = entry.startSubjects
    if (start !== undefined && (!Array.isArray(start) || !start.every(code => typeof code === 'string' && /^[A-Z]{2,4}$/.test(code)))) {
      errors.push(`${where}: startSubjects must be an array of subject codes`)
    }
  })
  if (errors.length) throw new DataBuildError('data/campuses.json', errors)
  return raw as unknown as CampusSourceRegistry
}

/** `[{ id, label }]`, `{ id: label }` or `{ id: { label } }`; a missing label is derived from the id. */
function divisionEntries(raw: unknown): [unknown, unknown][] | null {
  if (Array.isArray(raw)) {
    return raw.map((item): [unknown, unknown] => (isRecord(item) ? [item.id, item.label ?? item.name] : [item, undefined]))
  }
  if (isRecord(raw)) {
    return Object.entries(raw).map(([id, value]): [unknown, unknown] => [id, isRecord(value) ? value.label ?? value.name : value])
  }
  return null
}

function parseDivisions(raw: unknown, errors: string[]): Division[] {
  if (raw === undefined) return []
  const entries = divisionEntries(raw)
  if (!entries) {
    errors.push('divisions: expected an array or an object')
    return []
  }
  const divisions: Division[] = []
  for (const [id, label] of entries) {
    if (!isText(id)) errors.push(`divisions: invalid id ${JSON.stringify(id)}`)
    else if (divisions.some(division => division.id === id)) errors.push(`divisions: duplicate id ${id}`)
    else divisions.push({ id, label: isText(label) ? normaliseText(label) : titleCase(id) })
  }
  return divisions
}

function parseSubjectEntry(code: unknown, value: Record<string, unknown>, errors: string[]): SubjectSource | null {
  if (typeof code !== 'string' || !/^[A-Z]{2,4}$/.test(code)) {
    errors.push(`subjects: invalid code ${JSON.stringify(code)}`)
    return null
  }
  const division = isRecord(value.division) ? value.division.id : value.division
  return {
    code,
    name: isText(value.name) ? normaliseText(value.name) : '',
    department: isText(value.department) ? normaliseText(value.department) : '',
    division: isText(division) ? division.trim() : '',
  }
}

/**
 * Accepts the shapes a subjects.json may reasonably take: `{ divisions?, subjects: [...] }`,
 * `{ divisions?, subjects: { CODE: {...} } }`, a bare array, or a bare `{ CODE: {...} }` map.
 */
export function parseSubjectsFile(raw: unknown): SubjectsInput {
  const errors: string[] = []
  const container: Record<string, unknown> = isRecord(raw) && 'subjects' in raw ? raw : { subjects: raw }
  const list = container.subjects
  const subjects: SubjectSource[] = []
  const add = (code: unknown, value: unknown): void => {
    if (!isRecord(value)) {
      errors.push(`subjects: entry ${JSON.stringify(code)} is not an object`)
      return
    }
    const subject = parseSubjectEntry(code, value, errors)
    if (!subject) return
    if (subjects.some(existing => existing.code === subject.code)) errors.push(`subjects: duplicate code ${subject.code}`)
    else subjects.push(subject)
  }
  if (Array.isArray(list)) list.forEach(item => add(isRecord(item) ? item.code : undefined, item))
  else if (isRecord(list)) Object.entries(list).forEach(([code, value]) => add(code, value))
  else errors.push('subjects: expected an array or an object keyed by subject code')
  const divisions = parseDivisions(container.divisions, errors)
  if (errors.length) throw new DataBuildError('subjects.json', errors)
  return { divisions, subjects }
}

// ---------------------------------------------------------------------------
// Validation

function ruleIssues(rule: Rule | undefined, where: string, errors: string[]): void {
  if (!isRecord(rule) || typeof rule.kind !== 'string') {
    errors.push(`${where}: missing rule`)
    return
  }
  const checkId = (id: unknown) => {
    if (typeof id !== 'string' || !COURSE_REF.test(id)) errors.push(`${where}: malformed course id ${JSON.stringify(id)}`)
  }
  switch (rule.kind) {
    case 'true': return
    case 'all': case 'any':
      if (!Array.isArray(rule.items) || rule.items.length === 0) errors.push(`${where}: empty ${rule.kind} group`)
      else rule.items.forEach((item, i) => ruleIssues(item, `${where}.${rule.kind}[${i}]`, errors))
      return
    case 'course':
      checkId(rule.courseId)
      return
    case 'minGrade':
      checkId(rule.courseId)
      if (!Number.isFinite(rule.minimum)) errors.push(`${where}: minGrade without a numeric minimum`)
      return
    case 'credits':
      if (!Number.isFinite(rule.minimum)) errors.push(`${where}: credits without a numeric minimum`)
      if (rule.courseIds !== undefined) {
        if (Array.isArray(rule.courseIds)) rule.courseIds.forEach(checkId)
        else errors.push(`${where}: credits.courseIds is not an array`)
      }
      return
    case 'permission':
      if (typeof rule.text !== 'string') errors.push(`${where}: permission without text`)
      return
    case 'program':
      if (!isText(rule.programId)) errors.push(`${where}: program rule without programId`)
      return
    case 'unknown':
      if (typeof rule.text !== 'string' || typeof rule.reason !== 'string') errors.push(`${where}: unknown rule without text/reason`)
      return
    case 'applicability':
      if (typeof rule.cohort !== 'string') errors.push(`${where}: applicability without cohort`)
      ruleIssues(rule.rule, `${where}.applicability`, errors)
      return
    default:
      errors.push(`${where}: unsupported rule kind ${JSON.stringify((rule as { kind: unknown }).kind)}`)
  }
}

const OPTIONAL_ID_LISTS = ['mentionedIds', 'unresolvedIds'] as const

function requirementIssues(req: Requirement | undefined, where: string, errors: string[], warnings: string[]): void {
  if (!isRecord(req) || typeof req.rawText !== 'string' || !Array.isArray(req.courseIds)) {
    errors.push(`${where}: malformed requirement`)
    return
  }
  const lists: unknown[][] = [req.courseIds]
  for (const key of OPTIONAL_ID_LISTS) {
    const value: unknown = req[key]
    if (value === undefined) continue
    if (Array.isArray(value)) lists.push(value)
    else errors.push(`${where}: ${key} is not an array`)
  }
  for (const id of lists.flat()) {
    if (typeof id !== 'string' || !COURSE_REF.test(id)) errors.push(`${where}: malformed course id ${JSON.stringify(id)}`)
  }
  const before = errors.length
  ruleIssues(req.rule, where, errors)
  if (errors.length > before) return
  if (new Set(req.courseIds).size !== req.courseIds.length) warnings.push(`${where}: duplicate course ids (de-duplicated)`)
  const listed = new Set([...req.courseIds, ...(req.unresolvedIds ?? [])])
  const unlisted = ruleCourseIds(req.rule).filter(id => !listed.has(id))
  if (unlisted.length) warnings.push(`${where}: rule references ids missing from courseIds (merged): ${unlisted.join(', ')}`)
  const mentioned = new Set(req.mentionedIds ?? [])
  const both = [...listed].filter(id => mentioned.has(id))
  if (both.length) warnings.push(`${where}: ids listed both as references and as mentions (kept as references): ${both.join(', ')}`)
}

function courseIssues(course: Course, campus: CampusId, errors: string[], warnings: string[]): void {
  const where = typeof course.id === 'string' ? course.id : JSON.stringify(course.id)
  if (typeof course.code !== 'string' || !/^[A-Z0-9]+$/.test(course.code)) errors.push(`${where}: malformed code ${JSON.stringify(course.code)}`)
  else if (course.id !== `${campus}:${course.code}`) errors.push(`${where}: id does not match ${campus}:${course.code}`)
  if (course.campus !== campus) errors.push(`${where}: campus ${JSON.stringify(course.campus)} is not ${campus}`)
  if (typeof course.subject !== 'string' || !/^[A-Z]{2,4}$/.test(course.subject)) errors.push(`${where}: malformed subject ${JSON.stringify(course.subject)}`)
  else if (typeof course.code === 'string' && !course.code.startsWith(course.subject)) errors.push(`${where}: code does not start with subject ${course.subject}`)
  if (!isText(course.title)) errors.push(`${where}: missing title`)
  if (!Number.isFinite(course.level)) errors.push(`${where}: non-numeric level`)
  if (!Number.isFinite(course.credits) || course.credits <= 0) errors.push(`${where}: invalid credits ${JSON.stringify(course.credits)}`)
  for (const key of ['description', 'notes'] as const) {
    if (typeof course[key] !== 'string') errors.push(`${where}: ${key} is not a string`)
  }
  for (const key of ['distribution', 'deliveryCampus'] as const) {
    if (course[key] !== undefined && typeof course[key] !== 'string') errors.push(`${where}: ${key} is not a string`)
  }
  for (const [field] of REQUIREMENT_FIELDS) requirementIssues(course[field], `${where}.${field}`, errors, warnings)
}

function programIssues(program: Program, campus: CampusId, groupIds: Set<string>, errors: string[], warnings: string[]): void {
  const where = typeof program.id === 'string' ? program.id : JSON.stringify(program.id)
  if (typeof program.id !== 'string' || !program.id.startsWith(`${campus}:`)) errors.push(`${where}: id is not prefixed with ${campus}:`)
  for (const key of ['code', 'title', 'type', 'sourceUrl'] as const) {
    if (!isText(program[key])) errors.push(`${where}: missing ${key}`)
  }
  for (const key of ['description', 'notes'] as const) {
    if (typeof program[key] !== 'string') errors.push(`${where}: ${key} is not a string`)
  }
  requirementIssues(program.admission, `${where}.admission`, errors, warnings)
  requirementIssues(program.completion, `${where}.completion`, errors, warnings)
  if (!Array.isArray(program.groups)) {
    errors.push(`${where}: groups is not an array`)
    return
  }
  program.groups.forEach((group: ProgramGroup, index) => {
    const at = `${where}.groups[${index}]`
    if (!isText(group.id)) errors.push(`${at}: missing id`)
    else if (groupIds.has(group.id)) errors.push(`${at}: duplicate group id ${group.id}`)
    else groupIds.add(group.id)
    if (group.category !== 'admission' && group.category !== 'completion') errors.push(`${at}: invalid category ${JSON.stringify(group.category)}`)
    if (typeof group.label !== 'string') errors.push(`${at}: label is not a string`)
    requirementIssues(group, at, errors, warnings)
  })
}

function duplicates(ids: readonly unknown[]): string[] {
  const seen = new Set<unknown>()
  const repeated = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) repeated.add(String(id))
    seen.add(id)
  }
  return [...repeated].sort(compareCodeUnits)
}

/** Returns hard errors (stop the build) and warnings (fallbacks applied) for one catalog. */
export function validateCatalog(catalog: Catalog, campus: CampusSource): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(catalog) || catalog.schemaVersion !== 1) errors.push('catalog: expected schemaVersion 1')
  const meta = isRecord(catalog) ? catalog.metadata : undefined
  if (!isRecord(meta)) errors.push('catalog: missing metadata')
  else {
    if (meta.campus !== campus.id) errors.push(`catalog: metadata.campus ${JSON.stringify(meta.campus)} is not ${campus.id}`)
    if (!isText(meta.academicYear)) errors.push('catalog: missing metadata.academicYear')
    if (typeof meta.fetchedAt !== 'string' || !Number.isFinite(Date.parse(meta.fetchedAt))) errors.push('catalog: metadata.fetchedAt is not a timestamp')
    if (meta.complete !== true) warnings.push('catalog: metadata.complete is not true')
  }
  if (!isRecord(catalog) || !Array.isArray(catalog.courses) || !Array.isArray(catalog.programs)) {
    errors.push('catalog: courses and programs must be arrays')
    return { errors, warnings }
  }
  for (const id of duplicates(catalog.courses.map(course => course.id))) errors.push(`duplicate course id ${id}`)
  for (const id of duplicates(catalog.programs.map(program => program.id))) errors.push(`duplicate program id ${id}`)
  for (const course of catalog.courses) {
    if (isRecord(course)) courseIssues(course, campus.id, errors, warnings)
    else errors.push('catalog: course entry is not an object')
  }
  const groupIds = new Set<string>()
  for (const program of catalog.programs) {
    if (isRecord(program)) programIssues(program, campus.id, groupIds, errors, warnings)
    else errors.push('catalog: program entry is not an object')
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// Projection

/** Rebuilds a rule with a fixed key order, so output never depends on the backend writer. */
export function canonicalRule(rule: Rule): Rule {
  switch (rule.kind) {
    case 'true': return { kind: 'true' }
    case 'all': case 'any': return { kind: rule.kind, items: rule.items.map(canonicalRule) }
    case 'course': return { kind: 'course', courseId: rule.courseId }
    case 'minGrade': return { kind: 'minGrade', courseId: rule.courseId, minimum: rule.minimum }
    case 'credits': {
      const out: Extract<Rule, { kind: 'credits' }> = { kind: 'credits', minimum: rule.minimum }
      if (rule.courseIds !== undefined) out.courseIds = [...rule.courseIds]
      if (rule.subject !== undefined) out.subject = rule.subject
      if (rule.level !== undefined) out.level = rule.level
      return out
    }
    case 'permission': return { kind: 'permission', text: rule.text }
    case 'program': return { kind: 'program', programId: rule.programId }
    case 'unknown': return { kind: 'unknown', text: rule.text, reason: rule.reason }
    case 'applicability': return { kind: 'applicability', cohort: rule.cohort, rule: canonicalRule(rule.rule) }
    default: throw new Error(`Unsupported rule: ${JSON.stringify(rule)}`)
  }
}

interface RequirementRefs {
  /** Graph edges: catalog courses of this campus and every other-campus id. */
  ids: string[]
  mentioned: string[]
  /** Same-campus ids absent from the catalog (retired or misprinted). */
  unresolved: string[]
}

/**
 * Splits a requirement's references by role. A same-campus id that is not a catalog course is
 * never an edge, whichever list (or rule leaf) it came from; mentions never become edges.
 */
export function requirementRefs(req: Requirement, scope?: IdScope): RequirementRefs {
  const referenced = uniqueSorted([...req.courseIds, ...ruleCourseIds(req.rule)])
  const missing = (id: string) => scope !== undefined && id.startsWith(`${scope.campus}:`) && !scope.courseIds.has(id)
  const ids = referenced.filter(id => !missing(id))
  const unresolved = uniqueSorted([...(req.unresolvedIds ?? []), ...referenced.filter(missing)])
  const taken = new Set([...ids, ...unresolved])
  const mentioned = uniqueSorted(req.mentionedIds ?? []).filter(id => !taken.has(id))
  return { ids, mentioned, unresolved }
}

/** `undefined` when the calendar field is empty (no text, no rule, no references or mentions). */
export function toRequirementLite(req: Requirement, scope?: IdScope): RequirementLite | undefined {
  const text = normaliseText(req.rawText)
  const { ids, mentioned, unresolved } = requirementRefs(req, scope)
  if (text === '' && req.rule.kind === 'true' && ids.length + mentioned.length + unresolved.length === 0) return undefined
  const lite: RequirementLite = { text, rule: canonicalRule(req.rule), ids }
  if (mentioned.length) lite.mentioned = mentioned
  if (unresolved.length) lite.unresolved = unresolved
  return lite
}

function toGraphCourse(course: Course, scope: IdScope): GraphCourse {
  const out: GraphCourse = {
    id: course.id,
    code: course.code,
    title: normaliseText(course.title),
    subject: course.subject,
    level: course.level,
    credits: course.credits,
  }
  const distribution = normaliseText(course.distribution)
  if (distribution) out.distribution = distribution
  const deliveryCampus = normaliseText(course.deliveryCampus)
  if (deliveryCampus) out.deliveryCampus = deliveryCampus
  for (const [field, key] of REQUIREMENT_FIELDS) {
    const lite = toRequirementLite(course[field], scope)
    if (lite) out[key] = lite
  }
  const notes = normaliseText(course.notes)
  if (notes) out.notes = notes
  return out
}

function toProgramGroupLite(group: ProgramGroup, scope: IdScope): ProgramGroupLite {
  return {
    id: group.id,
    label: normaliseText(group.label),
    category: group.category,
    text: normaliseText(group.rawText),
    rule: canonicalRule(group.rule),
    // ProgramGroupLite has no mention/unresolved lists: only highlightable references are kept.
    ids: requirementRefs(group, scope).ids,
  }
}

function toProgramLite(program: Program, scope: IdScope): ProgramLite {
  const notes = normaliseText(program.notes)
  return {
    id: program.id,
    code: normaliseText(program.code),
    title: normaliseText(program.title),
    type: normaliseText(program.type),
    sourceUrl: program.sourceUrl,
    description: normaliseText(program.description),
    ...(notes ? { notes } : {}),
    admissionText: normaliseText(program.admission.rawText),
    completionText: normaliseText(program.completion.rawText),
    groups: program.groups.map(group => toProgramGroupLite(group, scope)),
  }
}

function programTypeRank(type: string): number {
  const rank = PROGRAM_TYPE_ORDER.indexOf(type)
  return rank < 0 ? PROGRAM_TYPE_ORDER.length : rank
}

/** Specialist, Major, Minor, Certificate, Focus, then any other type alphabetically; then title. */
export function compareProgramLite(a: ProgramLite, b: ProgramLite): number {
  return programTypeRank(a.type) - programTypeRank(b.type)
    || compareCodeUnits(a.type, b.type)
    || compareCodeUnits(a.title, b.title)
    || compareCodeUnits(a.id, b.id)
}

function divisionResolver(declared: readonly Division[]) {
  const byLabel = new Map(declared.map(division => [division.label.toLowerCase(), division.id]))
  return (value: string): { id: string; declared: boolean } => {
    if (declared.some(division => division.id === value)) return { id: value, declared: true }
    const labelled = byLabel.get(value.toLowerCase())
    if (labelled) return { id: labelled, declared: true }
    return { id: slug(value) || FALLBACK_DIVISION, declared: false }
  }
}

/** Subjects present in the catalog (sorted by code, counts recomputed) and the divisions they use. */
export function buildSubjects(
  courses: readonly Course[],
  input: SubjectsInput | null,
  warnings: string[],
): { divisions: Division[]; subjects: SubjectInfo[] } {
  const counts = new Map<string, number>()
  for (const course of courses) counts.set(course.subject, (counts.get(course.subject) ?? 0) + 1)
  const known = new Map((input?.subjects ?? []).map(subject => [subject.code, subject]))
  const declared = input?.divisions ?? []
  const resolveDivision = divisionResolver(declared)
  const missing: string[] = []
  const undeclared = new Set<string>()
  const subjects = [...counts.keys()].sort(compareCodeUnits).map((code): SubjectInfo => {
    const source = known.get(code)
    if (!source) missing.push(code)
    const division = resolveDivision(source?.division || FALLBACK_DIVISION)
    if (source && !division.declared && declared.length > 0) undeclared.add(source.division || FALLBACK_DIVISION)
    return {
      code,
      name: source?.name || code,
      department: source?.department ?? '',
      division: division.id,
      courseCount: counts.get(code) ?? 0,
    }
  })
  if (input === null) {
    warnings.push(`subjects.json not found: ${subjects.length} subjects use their code as name and division "${FALLBACK_DIVISION}"`)
  } else if (missing.length) {
    warnings.push(`subjects missing from subjects.json (code used as name, division "${FALLBACK_DIVISION}"): ${missing.join(', ')}`)
  }
  if (undeclared.size) warnings.push(`divisions referenced by subjects but not declared: ${[...undeclared].sort(compareCodeUnits).join(', ')}`)
  const used = new Set(subjects.map(subject => subject.division))
  const extra = [...used].filter(id => !declared.some(division => division.id === id)).sort(compareCodeUnits)
  const divisions = [
    ...declared.filter(division => used.has(division.id)).map(division => ({ id: division.id, label: division.label })),
    ...extra.map(id => ({ id, label: titleCase(id) })),
  ]
  return { divisions, subjects }
}

/** Validates one campus catalog and projects it onto the three frontend datasets. */
export function buildCampusDatasets(catalog: Catalog, subjects: SubjectsInput | null, campus: CampusSource): CampusDatasets {
  const { errors, warnings } = validateCatalog(catalog, campus)
  if (errors.length) throw new DataBuildError(`${campus.id} catalog`, errors)
  const courses = [...catalog.courses].sort((a, b) => compareCodeUnits(a.id, b.id))
  const scope: IdScope = { campus: campus.id, courseIds: new Set(courses.map(course => course.id)) }
  const { divisions, subjects: subjectInfos } = buildSubjects(courses, subjects, warnings)
  const graph: GraphDataset = {
    schemaVersion: 1,
    campus: campus.id,
    academicYear: catalog.metadata.academicYear,
    fetchedAt: catalog.metadata.fetchedAt,
    // The snapshot time, not the clock: rebuilding an unchanged catalog must be byte-identical.
    generatedAt: catalog.metadata.fetchedAt,
    sources: {
      calendar: campus.calendarUrl,
      courseSearch: campus.courseSearchUrl,
      programSearch: campus.programSearchUrl,
      coursePageTemplate: campus.coursePageTemplate,
      programPageTemplate: campus.programPageTemplate,
    },
    divisions,
    subjects: subjectInfos,
    courses: courses.map(course => toGraphCourse(course, scope)),
  }
  const descriptions: Record<string, string> = {}
  for (const course of courses) {
    const description = normaliseText(course.description)
    if (description) descriptions[course.id] = description
  }
  return {
    graph,
    details: { schemaVersion: 1, campus: campus.id, descriptions },
    programs: { schemaVersion: 1, campus: campus.id, programs: catalog.programs.map(program => toProgramLite(program, scope)).sort(compareProgramLite) },
    warnings,
  }
}

export function summarise(datasets: Pick<CampusDatasets, 'graph' | 'programs'>): CampusSummary {
  return {
    academicYear: datasets.graph.academicYear,
    fetchedAt: datasets.graph.fetchedAt,
    courseCount: datasets.graph.courses.length,
    programCount: datasets.programs.programs.length,
    subjects: datasets.graph.subjects.map(subject => subject.code),
  }
}

/** Start subjects of an available campus that its dataset does not contain. */
export function missingStartSubjects(campus: CampusSource, summary: CampusSummary): string[] {
  return (campus.startSubjects ?? []).filter(code => !summary.subjects.includes(code))
}

/** Available campuses carry their data path and counts; planned ones are listed without data. */
export function buildRegistry(source: CampusSourceRegistry, summaries: ReadonlyMap<CampusId, CampusSummary>): CampusRegistry {
  const campuses = source.campuses.map((campus): CampusEntry => {
    const entry: CampusEntry = {
      id: campus.id,
      name: campus.name,
      shortName: campus.shortName,
      status: campus.status,
      calendarUrl: campus.calendarUrl,
    }
    if (campus.status !== 'available') {
      if (campus.startSubjects?.length) entry.startSubjects = [...campus.startSubjects]
      return entry
    }
    const summary = summaries.get(campus.id)
    if (!summary) throw new DataBuildError('campus registry', [`no dataset was built for available campus ${campus.id}`])
    entry.dataPath = `${campus.dataDir}/`
    entry.academicYear = summary.academicYear
    entry.courseCount = summary.courseCount
    entry.programCount = summary.programCount
    const missing = missingStartSubjects(campus, summary)
    const start = (campus.startSubjects ?? []).filter(code => !missing.includes(code))
    if (start.length) entry.startSubjects = start
    return entry
  })
  const latest = [...summaries.values()]
    .map(summary => summary.fetchedAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b) || compareCodeUnits(a, b))
    .at(-1)
  return { schemaVersion: 1, generatedAt: latest ?? EPOCH, campuses }
}

// ---------------------------------------------------------------------------
// File generation (reads data/, never writes)

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Builds every frontend file in memory from the backend datasets under `root`. */
export function generateFrontendData(root: string): Generation {
  const registry = parseCampusRegistry(readJson(join(root, 'data', 'campuses.json')))
  const files: GeneratedFile[] = []
  const warnings: string[] = []
  const summaries = new Map<CampusId, CampusSummary>()
  for (const campus of registry.campuses) {
    if (campus.status !== 'available') continue
    const dataDir = join(root, 'data', campus.dataDir)
    const catalog = readJson(join(dataDir, 'catalog.json')) as Catalog
    const subjectsPath = join(dataDir, 'subjects.json')
    let subjects: SubjectsInput | null = null
    if (existsSync(subjectsPath)) {
      try {
        subjects = parseSubjectsFile(readJson(subjectsPath))
      } catch (error) {
        if (error instanceof DataBuildError) throw new DataBuildError(`data/${campus.dataDir}/subjects.json`, error.issues)
        throw error
      }
    }
    const built = buildCampusDatasets(catalog, subjects, campus)
    warnings.push(...built.warnings.map(warning => `${campus.id}: ${warning}`))
    const summary = summarise(built)
    const missing = missingStartSubjects(campus, summary)
    if (missing.length) warnings.push(`${campus.id}: startSubjects not in the catalog (dropped): ${missing.join(', ')}`)
    summaries.set(campus.id, summary)
    const out = `public/data/${campus.dataDir}`
    files.push(
      { path: `${out}/graph.json`, content: serialise(built.graph) },
      { path: `${out}/details.json`, content: serialise(built.details) },
      { path: `${out}/programs.json`, content: serialise(built.programs) },
    )
  }
  files.unshift({ path: 'public/data/campuses.json', content: serialise(buildRegistry(registry, summaries)) })
  return { files, warnings }
}

// ---------------------------------------------------------------------------
// CLI

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)])
}

/** Files under public/data/ that the generator no longer produces. */
function findStaleFiles(root: string, files: readonly GeneratedFile[]): string[] {
  const expected = new Set(files.map(file => file.path))
  return listFiles(join(root, 'public', 'data'))
    .map(path => relative(root, path).split(sep).join('/'))
    .filter(path => !expected.has(path))
    .sort(compareCodeUnits)
}

function readIfExists(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function check(root: string, files: readonly GeneratedFile[], stale: readonly string[]): number {
  const problems: string[] = []
  for (const file of files) {
    const current = readIfExists(join(root, file.path))
    if (!current) problems.push(`missing  ${file.path}`)
    else if (!current.equals(Buffer.from(file.content, 'utf8'))) problems.push(`differs  ${file.path}`)
  }
  for (const path of stale) problems.push(`stale    ${path} (not produced by the generator; delete it)`)
  if (problems.length === 0) {
    console.log(`public/data is up to date (${files.length} files)`)
    return 0
  }
  console.error(`public/data is out of date; run \`npm run data:build\`:\n${problems.map(line => `  ${line}`).join('\n')}`)
  return 1
}

function write(root: string, files: readonly GeneratedFile[], stale: readonly string[]): number {
  const rows: string[][] = [['file', 'raw', 'gzip', '']]
  for (const file of files) {
    const target = join(root, file.path)
    const bytes = Buffer.from(file.content, 'utf8')
    const current = readIfExists(target)
    const changed = !current || !current.equals(bytes)
    if (changed) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    rows.push([file.path, kb(bytes.length), kb(gzipSync(bytes, { level: 9 }).length), changed ? 'written' : 'unchanged'])
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => row[col].length)))
  for (const row of rows) {
    console.log(row.map((cell, col) => (col === 1 || col === 2 ? cell.padStart(widths[col]) : cell.padEnd(widths[col]))).join('  ').trimEnd())
  }
  for (const path of stale) console.warn(`warning: ${path} is not produced by the generator anymore; delete it`)
  return 0
}

function main(args: readonly string[]): number {
  const unknown = args.filter(arg => arg !== '--check')
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: tsx scripts/build-frontend-data.ts [--check]`)
    return 2
  }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const { files, warnings } = generateFrontendData(root)
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  const stale = findStaleFiles(root, files)
  return args.includes('--check') ? check(root, files, stale) : write(root, files, stale)
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const norm = (path: string) => {
    const absolute = resolve(path).replace(/\.ts$/, '')
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return norm(entry) === norm(fileURLToPath(import.meta.url))
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
