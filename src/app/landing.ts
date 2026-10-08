// Where the map opens (design-spec 10.1), decided once after the campus data loads. Pure.
import type { HomePref } from './store'

export type LandingAction =
  /** Hash course: select it and frame its chain. */
  | { kind: 'chain' }
  /** Hash program or a stored program home: program mode framed to the program box. */
  | { kind: 'program'; programId: string; activate: boolean }
  /** Scroll a subject's lane to the top of the plot at zoom 1. */
  | { kind: 'lane'; subject: string }
  | { kind: 'none' }

export interface Landing {
  action: LandingAction
  /** First visit: the start strip replaces the hint (6.3). */
  showStart: boolean
  /** First visit: focus the search input; its dropdown stays closed until the user types. */
  focusSearch: boolean
}

export interface LandingInput {
  /** Course id resolved from the hash (null when absent or not in this calendar). */
  hashCourse: string | null
  /** Program id from the hash (null when absent). */
  hashProgram: string | null
  home: HomePref | null
  onboarded: boolean
  /** Campus registry `startSubjects` (UTM: CSC, MAT, STA, ECO, PSY, BIO). */
  startSubjects: readonly string[]
  /** Subjects that have a lane in the loaded dataset. */
  subjects: ReadonlySet<string>
}

export function decideLanding(input: LandingInput): Landing {
  const quiet = { showStart: false, focusSearch: false }
  if (input.hashCourse) return { action: { kind: 'chain' }, ...quiet }
  if (input.hashProgram) return { action: { kind: 'program', programId: input.hashProgram, activate: false }, ...quiet }
  const home = input.home
  if (home?.kind === 'subject' && input.subjects.has(home.id)) return { action: { kind: 'lane', subject: home.id }, ...quiet }
  if (home?.kind === 'program') return { action: { kind: 'program', programId: home.id, activate: true }, ...quiet }

  // Never open on the first science lanes (Astronomy, Biology): start at the campus's first
  // start subject, for returning visitors as well.
  const start = input.startSubjects.find(subject => input.subjects.has(subject))
  const firstVisit = !input.onboarded
  return {
    action: start ? { kind: 'lane', subject: start } : { kind: 'none' },
    showStart: firstVisit,
    focusSearch: firstVisit,
  }
}
