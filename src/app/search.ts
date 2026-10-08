// Header search (design-spec 6.9.1): pure ranking over courses (code, title) and programs (title,
// code). Indexes are built once per dataset; a query is a linear scan (2,491 courses is cheap).
import type { GraphDataset, ProgramLite } from '../data/schema'

/** Character range of the match inside the displayed field, for the 600-weight highlight. */
export interface MatchRange {
  field: 'code' | 'title'
  start: number
  end: number
}

export interface CourseHit {
  id: string
  code: string
  title: string
  subject: string
  rank: number
  match: MatchRange | null
}

export interface ProgramHit {
  id: string
  code: string
  /** Title without the trailing " - CODE" the calendar appends. */
  title: string
  type: string
  rank: number
  match: MatchRange | null
}

interface Entry {
  id: string
  code: string
  title: string
  codeKey: string
  titleKey: string
}

interface CourseEntry extends Entry {
  subject: string
  /** Code without the H5 / Y5 suffix, so "csc148" is an exact hit for CSC148H5. */
  stemKey: string
}

interface ProgramEntry extends Entry {
  type: string
}

export interface Query {
  /** Lower case, trimmed, inner whitespace collapsed. */
  text: string
  /** Lower case without spaces or hyphens: "CSC 148" → "csc148". */
  compact: string
  words: string[]
}

export function parseQuery(raw: string): Query {
  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  return { text, compact: text.replace(/[\s-]+/g, ''), words: text ? text.split(' ') : [] }
}

export function buildCourseIndex(dataset: GraphDataset): CourseEntry[] {
  return dataset.courses.map(course => {
    const codeKey = course.code.toLowerCase()
    return {
      id: course.id, code: course.code, title: course.title, subject: course.subject,
      codeKey, stemKey: codeKey.replace(/[hy]\d$/, ''), titleKey: course.title.toLowerCase(),
    }
  })
}

/** "Computer Science - Major (Science) - ERMAJ1688" → "Computer Science - Major (Science)". */
export function programShortTitle(program: Pick<ProgramLite, 'title' | 'code'>): string {
  const suffix = ` - ${program.code}`
  return program.title.endsWith(suffix) ? program.title.slice(0, -suffix.length) : program.title
}

export function buildProgramIndex(programs: readonly ProgramLite[]): ProgramEntry[] {
  return programs.map(program => {
    const title = programShortTitle(program)
    return { id: program.id, code: program.code, title, type: program.type, codeKey: program.code.toLowerCase(), titleKey: title.toLowerCase() }
  })
}

const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char)

/** Index of the first occurrence of `needle` that starts a word in `haystack`, or -1. */
function wordPrefixIndex(haystack: string, needle: string): number {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (at === 0 || !isWordChar(haystack[at - 1])) return at
  }
  return -1
}

interface Ranked {
  rank: number
  match: MatchRange | null
}

/** Title tiers shared by courses and programs, starting at `base`. */
function rankTitle(entry: Entry, query: Query, base: number): Ranked | null {
  const { text, words } = query
  if (entry.titleKey.startsWith(text)) return { rank: base, match: { field: 'title', start: 0, end: text.length } }
  const word = wordPrefixIndex(entry.titleKey, text)
  if (word >= 0) return { rank: base + 1, match: { field: 'title', start: word, end: word + text.length } }
  const inside = entry.titleKey.indexOf(text)
  if (inside >= 0) return { rank: base + 2, match: { field: 'title', start: inside, end: inside + text.length } }
  if (words.length > 1 && words.every(part => entry.titleKey.includes(part))) return { rank: base + 3, match: null }
  return null
}

/**
 * Course tiers: 0 exact code, 1 code prefix, 2 code contains, 3 title starts with the query,
 * 4 a title word starts with it, 5 title contains it, 6 every query word appears in the title.
 */
export function rankCourse(entry: CourseEntry, query: Query): Ranked | null {
  const { compact } = query
  if (!compact) return null
  if (entry.codeKey === compact || entry.stemKey === compact) return { rank: 0, match: { field: 'code', start: 0, end: compact.length } }
  if (entry.codeKey.startsWith(compact)) return { rank: 1, match: { field: 'code', start: 0, end: compact.length } }
  const inCode = entry.codeKey.indexOf(compact)
  if (inCode >= 0) return { rank: 2, match: { field: 'code', start: inCode, end: inCode + compact.length } }
  return rankTitle(entry, query, 3)
}

/** Program tiers: 0 exact code, 1 code prefix, then the title tiers from 2. */
export function rankProgram(entry: ProgramEntry, query: Query): Ranked | null {
  const { compact } = query
  if (!compact) return null
  if (entry.codeKey === compact) return { rank: 0, match: { field: 'code', start: 0, end: compact.length } }
  if (compact.length >= 2 && entry.codeKey.startsWith(compact)) return { rank: 1, match: { field: 'code', start: 0, end: compact.length } }
  return rankTitle(entry, query, 2)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function searchCourses(index: readonly CourseEntry[], raw: string, limit = 8): CourseHit[] {
  const query = parseQuery(raw)
  const hits: CourseHit[] = []
  for (const entry of index) {
    const ranked = rankCourse(entry, query)
    if (ranked) hits.push({ id: entry.id, code: entry.code, title: entry.title, subject: entry.subject, ...ranked })
  }
  // Ties sorted by code (6.9.1).
  return hits.sort((a, b) => a.rank - b.rank || byText(a.code, b.code)).slice(0, limit)
}

export function searchPrograms(index: readonly ProgramEntry[], raw: string, limit = 3): ProgramHit[] {
  const query = parseQuery(raw)
  const hits: ProgramHit[] = []
  for (const entry of index) {
    const ranked = rankProgram(entry, query)
    if (ranked) hits.push({ id: entry.id, code: entry.code, title: entry.title, type: entry.type, ...ranked })
  }
  // Program ties read best by title ("Computer Science - Major", "- Minor", "- Specialist").
  return hits.sort((a, b) => a.rank - b.rank || byText(a.title, b.title) || byText(a.code, b.code)).slice(0, limit)
}

/** Splits `text` around a match range for rendering: [before, matched, after]. */
export function splitMatch(text: string, match: MatchRange | null, field: MatchRange['field']): [string, string, string] {
  if (!match || match.field !== field || match.end <= match.start) return [text, '', '']
  return [text.slice(0, match.start), text.slice(match.start, match.end), text.slice(match.end)]
}
