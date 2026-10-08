// Program picker and program progress helpers. Pure; no React.
import type { ProgramGroupLite, ProgramLite } from '../../data/schema'
import type { RecordEntry } from '../../app/store'
import type { ProgramProgress } from '../../domain/engine-types'

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

/** Every query word must appear in the title, code or type; results sorted by title. */
export function filterPrograms(programs: readonly ProgramLite[], query: string, type: ProgramTypeFilter): ProgramLite[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return programs
    .filter(program => type === 'all' || programTypeOf(program.type) === type)
    .filter(program => {
      const haystack = `${program.title} ${program.code} ${program.type}`.toLowerCase()
      return words.every(word => haystack.includes(word))
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.code.localeCompare(b.code))
}

export interface CourseTally {
  done: number
  total: number
}

/** Completed courses among a set of listed course ids. */
export function tally(ids: Iterable<string>, record: ReadonlyMap<string, RecordEntry>): CourseTally {
  const unique = new Set(ids)
  let done = 0
  for (const id of unique) if (record.get(id)?.status === 'completed') done++
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

/** Official text long enough to be clamped to 4 lines in a 300 px panel. */
export function needsClamp(text: string): boolean {
  return text.length > 200
}
