// Shareable URL hash: `#/utm?course=CSC148H5&program=ERMAJ1688`. Only the campus, the selected
// course and the selected program go into the URL — never the student record.
import type { CampusId } from '../data/schema'
import { appStore, type AppState } from './store'

export interface UrlState {
  campus: CampusId | null
  course: string | null
  program: string | null
}

const CAMPUSES: readonly CampusId[] = ['UTM', 'UTSG', 'UTSC']
const CODE = /^[A-Z0-9]{3,12}$/

export function parseHash(hash: string): UrlState {
  const match = /^#\/([a-z]+)(?:\?(.*))?$/i.exec(hash)
  if (!match) return { campus: null, course: null, program: null }
  const campus = CAMPUSES.find(id => id.toLowerCase() === match[1].toLowerCase()) ?? null
  const params = new URLSearchParams(match[2] ?? '')
  const course = params.get('course')?.toUpperCase() ?? null
  const program = params.get('program')?.toUpperCase() ?? null
  return {
    campus,
    course: course && CODE.test(course) ? course : null,
    program: program && CODE.test(program) ? program : null,
  }
}

export function formatHash(state: Pick<AppState, 'campus' | 'focusId' | 'programId'>): string {
  const params = new URLSearchParams()
  // Ids are `CAMPUS:CODE`; the URL carries only the code.
  if (state.focusId) params.set('course', state.focusId.split(':')[1] ?? state.focusId)
  if (state.programId) params.set('program', state.programId.split(':')[1] ?? state.programId)
  const query = params.toString()
  return `#/${state.campus.toLowerCase()}${query ? `?${query}` : ''}`
}

/**
 * Applies the current hash to the store, then mirrors store changes back into the hash with
 * replaceState (no history entries). `resolve` maps codes from the URL to ids that exist in the
 * loaded dataset (or null); codes that do not resolve are dropped from the URL right away.
 */
export function startUrlSync(resolve: { course(code: string): string | null; program(code: string): string | null }): () => void {
  const mirror = () => {
    const next = formatHash(appStore.get())
    if (next !== window.location.hash) window.history.replaceState(null, '', next)
  }
  const apply = () => {
    const url = parseHash(window.location.hash)
    const patch: Partial<AppState> = {
      focusId: url.course ? resolve.course(url.course) : null,
      programId: url.program ? resolve.program(url.program) : null,
    }
    if (url.campus) patch.campus = url.campus
    if (patch.focusId) patch.panel = 'course'
    else if (patch.programId) patch.panel = 'program'
    appStore.set(patch)
    mirror()
  }
  apply()
  window.addEventListener('hashchange', apply)

  const unsubscribe = appStore.subscribe(mirror)
  return () => {
    window.removeEventListener('hashchange', apply)
    unsubscribe()
  }
}
