import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SEARCH_INPUT_IDLE, listShowing, searchInputStep, type SearchInputState } from '../src/app/searchInput'
import { appStore, initialAppState } from '../src/app/store'
import { escapeLadder, isEditable } from '../src/app/useShortcuts'

/** Just enough of HTMLElement for isEditable (node has no DOM). */
class FakeElement {
  isContentEditable = false
  constructor(public tagName: string, public type = '') {}
}

beforeAll(() => {
  const globals = globalThis as unknown as { HTMLElement?: unknown }
  globals.HTMLElement ??= FakeElement
})

/** An instance of whatever HTMLElement is (the fake one under node), typed as an event target. */
const element = (tag: string, type = '', isContentEditable = false): EventTarget => {
  const Element = (globalThis as unknown as { HTMLElement: new (tag: string, type?: string) => FakeElement }).HTMLElement
  return Object.assign(Object.create(Element.prototype) as FakeElement, { tagName: tag, type, isContentEditable }) as unknown as EventTarget
}

describe('isEditable (design-spec 11.3)', () => {
  it('treats text fields, text areas, selects and contenteditable as editable', () => {
    expect(isEditable(element('INPUT', 'search'))).toBe(true)
    expect(isEditable(element('INPUT', 'text'))).toBe(true)
    expect(isEditable(element('INPUT', 'number'))).toBe(true)
    expect(isEditable(element('TEXTAREA'))).toBe(true)
    expect(isEditable(element('SELECT'))).toBe(true)
    expect(isEditable(element('DIV', '', true))).toBe(true)
  })

  it('leaves buttons, checkboxes, the map and non-elements to the shortcuts', () => {
    expect(isEditable(element('INPUT', 'checkbox'))).toBe(false)
    expect(isEditable(element('INPUT', 'radio'))).toBe(false)
    expect(isEditable(element('INPUT', 'range'))).toBe(false)
    expect(isEditable(element('BUTTON'))).toBe(false)
    expect(isEditable(element('DIV'))).toBe(false)
    expect(isEditable(null)).toBe(false)
    expect(isEditable({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(false)
  })
})

describe('escapeLadder (rungs 3 and 4)', () => {
  beforeEach(() => appStore.set(initialAppState()))
  afterEach(() => appStore.set(initialAppState()))

  it('clears the course first, then the program, never the record', () => {
    const record = new Map([['UTM:CSC108H5', { status: 'completed' as const }]])
    appStore.set({ focusId: 'UTM:CSC148H5', programId: 'UTM:ERMAJ1688', panel: 'course', record })
    escapeLadder()
    expect(appStore.get()).toMatchObject({ focusId: null, programId: 'UTM:ERMAJ1688', panel: null })
    escapeLadder()
    expect(appStore.get()).toMatchObject({ focusId: null, programId: null })
    escapeLadder()
    expect(appStore.get().record).toBe(record)
  })

  it('keeps another panel open when it clears the course', () => {
    appStore.set({ focusId: 'UTM:CSC148H5', panel: 'record' })
    escapeLadder()
    expect(appStore.get()).toMatchObject({ focusId: null, panel: 'record' })
  })
})

describe('search field (review bugs 1, 2 and the Esc rungs)', () => {
  const typed = (value: string): SearchInputState => searchInputStep(SEARCH_INPUT_IDLE, { kind: 'change', value }, 'idle').state

  it('typing asks for programs, even when the field was focused without asking (first visit)', () => {
    const step = searchInputStep(SEARCH_INPUT_IDLE, { kind: 'change', value: 'computer science' }, 'idle')
    expect(step.effects.wantPrograms).toBe(true)
    expect(listShowing(step.state)).toBe(true)
  })

  it('focus asks for programs and retries only after a failure', () => {
    expect(searchInputStep(SEARCH_INPUT_IDLE, { kind: 'focus' }, 'idle').effects).toEqual({ wantPrograms: true, retryPrograms: false })
    expect(searchInputStep(SEARCH_INPUT_IDLE, { kind: 'focus' }, 'loading').effects.retryPrograms).toBe(false)
    expect(searchInputStep(SEARCH_INPUT_IDLE, { kind: 'focus' }, 'error').effects.retryPrograms).toBe(true)
    expect(searchInputStep(typed('csc'), { kind: 'change', value: 'csc1' }, 'error').effects.retryPrograms).toBeUndefined()
  })

  it('Esc with results open only closes the list; the next Esc clears the text and leaves', () => {
    const first = searchInputStep(typed('csc148'), { kind: 'escape' }, 'ready')
    expect(first.state).toEqual({ query: 'csc148', open: false, active: 0 })
    expect(first.effects.blur).toBeUndefined()
    const second = searchInputStep(first.state, { kind: 'escape' }, 'ready')
    expect(second.state).toEqual(SEARCH_INPUT_IDLE)
    expect(second.effects.blur).toBe(true)
  })

  it('focus reopens the list for text that is still there', () => {
    const closed = searchInputStep(typed('csc148'), { kind: 'escape' }, 'ready').state
    expect(listShowing(searchInputStep(closed, { kind: 'focus' }, 'ready').state)).toBe(true)
    expect(listShowing(searchInputStep(SEARCH_INPUT_IDLE, { kind: 'focus' }, 'ready').state)).toBe(false)
  })

  it('arrows wrap through the rows; a pick resets the field without leaving it', () => {
    const down = searchInputStep(typed('csc'), { kind: 'move', delta: 1, rows: 3 }, 'ready').state
    expect(down.active).toBe(1)
    expect(searchInputStep(typed('csc'), { kind: 'move', delta: -1, rows: 3 }, 'ready').state.active).toBe(2)
    expect(searchInputStep(down, { kind: 'move', delta: 1, rows: 0 }, 'ready').state.active).toBe(1)
    expect(searchInputStep(down, { kind: 'pick' }, 'ready')).toEqual({ state: SEARCH_INPUT_IDLE, effects: {} })
  })

  it('a press outside closes the list and keeps the text', () => {
    expect(searchInputStep(typed('mat'), { kind: 'outside' }, 'ready').state).toEqual({ query: 'mat', open: false, active: 0 })
  })
})
