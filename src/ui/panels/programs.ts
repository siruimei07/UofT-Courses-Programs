// Program picker and program progress helpers. Pure; no React.
import type { ProgramGroupLite, ProgramLite } from '../../data/schema'
import type { RecordEntry } from '../../app/store'
import type { ProgramProgress } from '../../domain/engine-types'
import { programCode } from './format'
import { earnsCredit } from './record'

/** Official program types in picker order; anything else is "Other". */
export const PROGRAM_TYPES = ['Specialist', 'Major', 'Minor', 'Certificate', 'Focus'] as const
export type ProgramType = (typeof PROGRAM_TYPES)[number] | 'other'
export type ProgramTypeFilter = ProgramType | 'all'

export function programTypeOf(type: string): ProgramType {
  return (PROGRAM_TYPES as readonly string[]).includes(type) ? (type as ProgramType) : 'other'
}

/** Filter chips with their counts: All first, then the types present in the data. */
export function programTypeChips(programs: readonly ProgramLite[]): { type: ProgramTypeFilter; count: number }[] {
  const counts = new Map<ProgramType, number>()
  for (const program of programs) {
    const type = programTypeOf(program.type)
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  const order: ProgramType[] = [...PROGRAM_TYPES, 'other']
  return [
    { type: 'all', count: programs.length },
    ...order.filter(type => counts.has(type)).map(type => ({ type, count: counts.get(type) ?? 0 })),
  ]
}

/** Every query word must appear in the title, POSt code or type; results sorted by title. */
export function filterPrograms(programs: readonly ProgramLite[], query: string, type: ProgramTypeFilter): ProgramLite[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return programs
    .filter(program => type === 'all' || programTypeOf(program.type) === type)
    .filter(program => {
      const haystack = `${program.title} ${programCode(program) ?? ''} ${program.type}`.toLowerCase()
      return words.every(word => haystack.includes(word))
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.code.localeCompare(b.code))
}

export interface CourseTally {
  done: number
  total: number
}

/** Completed courses that earn credit (no grade, or 50 and above) among a set of listed course ids. */
export function tally(ids: Iterable<string>, record: ReadonlyMap<string, RecordEntry>): CourseTally {
  const unique = new Set(ids)
  let done = 0
  for (const id of unique) {
    const entry = record.get(id)
    if (entry?.status === 'completed' && earnsCredit(entry)) done++
  }
  return { done, total: unique.size }
}

export interface CategorySummary {
  category: ProgramGroupLite['category']
  groups: ProgramGroupLite[]
  tally: CourseTally
}

/** Admission and completion groups with the completed share of the courses they list. */
export function categories(program: ProgramLite, progress: ProgramProgress | null, record: ReadonlyMap<string, RecordEntry>): CategorySummary[] {
  const idsByGroup = new Map(progress?.groups.map(group => [group.groupId, group.courseIds]) ?? [])
  return (['admission', 'completion'] as const).map(category => {
    const groups = program.groups.filter(group => group.category === category)
    const ids = groups.flatMap(group => idsByGroup.get(group.id) ?? group.ids)
    return { category, groups, tally: tally(ids, record) }
  })
}

/** The pipeline's generic group labels (the category itself): never repeated as a section heading. */
export const GENERIC_GROUP_LABELS: readonly string[] = ['Admission', 'Completion']

/** One run of groups sharing a label: a pathway ("For students admitted through …:"), a year, notes. */
export interface GroupSection {
  key: string
  /** Shown once above the section's cards; null for the generic category label. */
  heading: string | null
  /** Requirement groups to show as cards (a heading-only group becomes the heading instead). */
  items: ProgramGroupLite[]
}

const NUMBERED = /\s*·\s*\d+$/
const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** Item number the pipeline appended to a label ("Notes: · 2" → 2), if any. */
export function groupNumber(group: ProgramGroupLite): number | null {
  const match = /·\s*(\d+)$/.exec(group.label)
  return match ? Number(match[1]) : null
}

/**
 * A group that only frames the ones after it ("For students admitted through the CMP1 admission
 * category …:"): no course of its own and its text is its label (or the end of it).
 */
export function isHeadingOnly(group: ProgramGroupLite): boolean {
  if (group.ids.length || group.mentioned?.length || group.unresolved?.length) return false
  const label = normal(group.label.replace(NUMBERED, ''))
  const text = normal(group.text)
  return Boolean(text) && (label === text || label.endsWith(text))
}

/**
 * Consecutive groups with one label become a section with that label as its heading, so a pathway's
 * steps read as one block and "one of three pathways" is visible; heading-only groups are not
 * repeated as cards (they had no courses and only a "check" badge).
 */
export function groupSections(groups: readonly ProgramGroupLite[]): GroupSection[] {
  const sections: GroupSection[] = []
  for (const group of groups) {
    const key = group.label.replace(NUMBERED, '').trim()
    let section = sections[sections.length - 1]
    if (!section || section.key !== key) {
      section = { key, heading: GENERIC_GROUP_LABELS.includes(key) ? null : key, items: [] }
      sections.push(section)
    }
    if (!isHeadingOnly(group)) section.items.push(group)
  }
  return sections.filter(section => section.items.length || section.heading)
}

/**
 * Sections shown before "Show all": whole sections, until the cards shown reach `limit` (the section
 * that crosses it is shown complete, so a pathway is never cut in half).
 */
export function capSections(sections: readonly GroupSection[], limit: number, expanded: boolean): { shown: GroupSection[]; rest: number } {
  if (expanded) return { shown: [...sections], rest: 0 }
  const shown: GroupSection[] = []
  let cards = 0
  for (const section of sections) {
    if (cards >= limit) break
    shown.push(section)
    cards += section.items.length
  }
  const total = sections.reduce((sum, section) => sum + section.items.length, 0)
  return { shown, rest: total - cards }
}

/** A clamped block overflows when its content is taller than its box (1 px of rounding allowed). */
export function isOverflowing(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight > 1
}
