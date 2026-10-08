// Header search (design-spec 6.2 item 6 and 6.9.1): a combobox over courses and programs with
// arrow-key navigation. Programs load lazily the first time the user focuses the field or types;
// a failed load says so and is retried on the next focus. The field's behaviour (Esc ladder,
// program requests) is the pure state machine in app/searchInput.ts.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { searchCourses, searchPrograms, splitMatch, type CourseHit, type MatchRange, type ProgramHit } from '../app/search'
import type { buildCourseIndex, buildProgramIndex } from '../app/search'
import { listShowing, SEARCH_INPUT_IDLE, searchInputStep, type SearchInputEvent } from '../app/searchInput'
import type { ProgramsStatus } from '../app/usePrograms'
import { format, useStrings } from '../i18n'
import { SearchIcon } from './icons'
import { ProgramsNote } from './ProgramsNote'
import { searchStrings } from './strings'
import { SubjectBullet, type SubjectTone } from './SubjectBullet'

type Row = { kind: 'course'; hit: CourseHit } | { kind: 'program'; hit: ProgramHit }

interface SearchBoxProps {
  courseIndex: ReturnType<typeof buildCourseIndex> | null
  programIndex: ReturnType<typeof buildProgramIndex> | null
  tones: ReadonlyMap<string, SubjectTone>
  inputRef: Ref<HTMLInputElement>
  /** State of programs.json; programs are searched once it is 'ready'. */
  programsStatus: ProgramsStatus
  /** The user focused the field or typed: time to fetch programs.json (safe to call repeatedly). */
  onWantPrograms(): void
  /** Load programs.json again after a failure (next focus or the note's retry button). */
  onRetryPrograms(): void
  /** A pick: the shell selects it and moves focus to the map. */
  onPickCourse(id: string): void
  onPickProgram(id: string): void
}

function Highlight({ text, match, field }: { text: string; match: MatchRange | null; field: MatchRange['field'] }) {
  const [before, hit, after] = splitMatch(text, match, field)
  return <>{before}{hit && <mark className="hit">{hit}</mark>}{after}</>
}

export function SearchBox(props: SearchBoxProps) {
  const { courseIndex, programIndex, tones, inputRef, programsStatus, onWantPrograms, onRetryPrograms, onPickCourse, onPickProgram } = props
  const t = useStrings(searchStrings)
  const [field, setField] = useState(SEARCH_INPUT_IDLE)
  const { query, active } = field
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const courses = useMemo(() => (courseIndex && query.trim() ? searchCourses(courseIndex, query, 8) : []), [courseIndex, query])
  const programs = useMemo(() => (programIndex && query.trim() ? searchPrograms(programIndex, query, 3) : []), [programIndex, query])
  const rows: Row[] = useMemo(() => [
    ...courses.map(hit => ({ kind: 'course' as const, hit })),
    ...programs.map(hit => ({ kind: 'program' as const, hit })),
  ], [courses, programs])
  const showList = listShowing(field)

  const dispatch = (event: SearchInputEvent, input?: HTMLInputElement) => {
    const { state, effects } = searchInputStep(field, event, programsStatus)
    setField(state)
    if (effects.wantPrograms) onWantPrograms()
    if (effects.retryPrograms) onRetryPrograms()
    if (effects.blur) input?.blur()
  }

  useEffect(() => {
    if (!showList) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setField(state => searchInputStep(state, { kind: 'outside' }, 'idle').state)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [showList])

  const pick = (row: Row) => {
    dispatch({ kind: 'pick' })
    if (row.kind === 'course') onPickCourse(row.hit.id)
    else onPickProgram(row.hit.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Handled here, so the global Esc ladder never takes a second rung on the same key.
      event.preventDefault()
      event.stopPropagation()
      dispatch({ kind: 'escape' }, event.currentTarget)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      dispatch({ kind: 'move', delta: event.key === 'ArrowDown' ? 1 : -1, rows: rows.length })
      return
    }
    if (event.key === 'Enter' && showList && rows.length) {
      event.preventDefault()
      pick(rows[Math.min(active, rows.length - 1)])
    }
  }

  const activeRow = showList && rows.length ? Math.min(active, rows.length - 1) : -1
  const optionId = (index: number) => `${listId}-option-${index}`

  return (
    <div className="search" ref={rootRef}>
      <SearchIcon className="search-icon" size={15} />
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        role="combobox"
        aria-label={t.label}
        aria-expanded={showList && rows.length > 0}
        aria-controls={showList && rows.length ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeRow >= 0 ? optionId(activeRow) : undefined}
        aria-keyshortcuts="/ Control+K"
        placeholder={t.placeholder}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={event => dispatch({ kind: 'change', value: event.target.value })}
        onFocus={() => dispatch({ kind: 'focus' })}
        onKeyDown={onKeyDown}
      />
      <kbd className="search-kbd" title={t.shortcut}>/</kbd>
      {showList && (
        <div className="popover search-results" onMouseDown={event => event.preventDefault()}>
          {rows.length > 0 && (
            <div id={listId} role="listbox" aria-label={t.results}>
              {courses.length > 0 && (
                <div role="group" aria-label={t.courses}>
                  {courses.map((hit, index) => (
                    <div key={hit.id} id={optionId(index)} role="option" aria-selected={index === activeRow}
                      className={`result-row course-row${index === activeRow ? ' is-active' : ''}`}
                      onMouseEnter={() => dispatch({ kind: 'hover', index })}
                      onClick={() => pick({ kind: 'course', hit })}>
                      <span className="result-code" lang="en"><Highlight text={hit.code} match={hit.match} field="code" /></span>
                      <span className="result-title" lang="en"><Highlight text={hit.title} match={hit.match} field="title" /></span>
                      <SubjectBullet code={hit.subject} tone={tones.get(hit.subject)} />
                    </div>
                  ))}
                </div>
              )}
              {programs.length > 0 && (
                <div role="group" aria-labelledby={`${listId}-programs`}>
                  <div className="result-group" id={`${listId}-programs`}>{t.programs}</div>
                  {programs.map((hit, offset) => {
                    const index = courses.length + offset
                    return (
                      <div key={hit.id} id={optionId(index)} role="option" aria-selected={index === activeRow}
                        className={`result-row program-row${index === activeRow ? ' is-active' : ''}`}
                        onMouseEnter={() => dispatch({ kind: 'hover', index })}
                        onClick={() => pick({ kind: 'program', hit })}>
                        <span className="result-title program-title" lang="en"><Highlight text={hit.title} match={hit.match} field="title" /></span>
                        <span className="result-meta" lang="en">{format(t.programMeta, { type: hit.type, code: hit.code })}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {rows.length === 0 && (programsStatus === 'ready' || programsStatus === 'error') && (
            <div className="search-note" role="status">{format(programsStatus === 'ready' ? t.noMatch : t.noCourseMatch, { q: query.trim() })}</div>
          )}
          {programsStatus !== 'ready' && (
            <div className="search-note"><ProgramsNote status={programsStatus} onRetry={onRetryPrograms} /></div>
          )}
        </div>
      )}
    </div>
  )
}
