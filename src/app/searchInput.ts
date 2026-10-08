// State machine of the header search field (design-spec 6.9.1 and the Esc ladder in 11.3). Pure:
// the SearchBox component applies the next state and runs the returned effects.
import type { ProgramsStatus } from './usePrograms'

export interface SearchInputState {
  query: string
  /** The user wants the result list (it shows while the query is not blank). */
  open: boolean
  /** Highlighted row. */
  active: number
}

export const SEARCH_INPUT_IDLE: SearchInputState = { query: '', open: false, active: 0 }

export type SearchInputEvent =
  | { kind: 'focus' }
  | { kind: 'change'; value: string }
  | { kind: 'move'; delta: 1 | -1; rows: number }
  | { kind: 'hover'; index: number }
  | { kind: 'escape' }
  | { kind: 'outside' }
  | { kind: 'pick' }

export interface SearchInputEffects {
  /** Fetch programs.json (first focus or first keystroke; repeated calls are harmless). */
  wantPrograms?: boolean
  /** Load programs.json again after a failure: the next focus retries. */
  retryPrograms?: boolean
  /** Leave the field. */
  blur?: boolean
}

export interface SearchInputStep {
  state: SearchInputState
  effects: SearchInputEffects
}

/** Whether the result popover is showing. */
export function listShowing(state: SearchInputState): boolean {
  return state.open && state.query.trim().length > 0
}

export function searchInputStep(state: SearchInputState, event: SearchInputEvent, programs: ProgramsStatus): SearchInputStep {
  switch (event.kind) {
    case 'focus':
      return {
        state: state.query.trim() ? { ...state, open: true } : state,
        effects: { wantPrograms: true, retryPrograms: programs === 'error' },
      }
    case 'change':
      return { state: { query: event.value, open: true, active: 0 }, effects: { wantPrograms: true } }
    case 'move': {
      const active = event.rows ? (state.active + event.delta + event.rows) % event.rows : state.active
      return { state: { ...state, open: true, active }, effects: {} }
    }
    case 'hover':
      return { state: { ...state, active: event.index }, effects: {} }
    case 'escape':
      // An open list closes first; the next Esc clears the text and leaves the field. Neither
      // touches the selection (rungs 3 and 4 belong to the global handler).
      if (listShowing(state)) return { state: { ...state, open: false }, effects: {} }
      return { state: SEARCH_INPUT_IDLE, effects: { blur: true } }
    case 'outside':
      return { state: { ...state, open: false }, effects: {} }
    case 'pick':
      // The shell moves focus to the map after a pick.
      return { state: SEARCH_INPUT_IDLE, effects: {} }
  }
}
