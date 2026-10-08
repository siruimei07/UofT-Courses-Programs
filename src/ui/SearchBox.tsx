// Header search (design-spec 6.2 item 6 and 6.9.1): a combobox over courses and programs with
// arrow-key navigation. Programs load lazily the first time the user focuses the field.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { searchCourses, searchPrograms, splitMatch, type CourseHit, type MatchRange, type ProgramHit } from '../app/search'
import type { buildCourseIndex, buildProgramIndex } from '../app/search'
import { format, useStrings } from '../i18n'
import { SearchIcon } from './icons'
import { searchStrings } from './strings'
import { SubjectBullet, type SubjectTone } from './SubjectBullet'

type Row = { kind: 'course'; hit: CourseHit } | { kind: 'program'; hit: ProgramHit }

interface SearchBoxProps {
  courseIndex: ReturnType<typeof buildCourseIndex> | null
  programIndex: ReturnType<typeof buildProgramIndex> | null
  tones: ReadonlyMap<string, SubjectTone>
  inputRef: Ref<HTMLInputElement>
  /** The user focused the field: time to fetch programs.json. */
  onWantPrograms(): void
  onPickCourse(id: string): void
  onPickProgram(id: string): void
}

function Highlight({ text, match, field }: { text: string; match: MatchRange | null; field: MatchRange['field'] }) {
  const [before, hit, after] = splitMatch(text, match, field)
  return <>{before}{hit && <mark className="hit">{hit}</mark>}{after}</>
}

export function SearchBox({ courseIndex, programIndex, tones, inputRef, onWantPrograms, onPickCourse, onPickProgram }: SearchBoxProps) {
  const t = useStrings(searchStrings)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const courses = useMemo(() => (courseIndex && query.trim() ? searchCourses(courseIndex, query, 8) : []), [courseIndex, query])
  const programs = useMemo(() => (programIndex && query.trim() ? searchPrograms(programIndex, query, 3) : []), [programIndex, query])
  const rows: Row[] = useMemo(() => [
    ...courses.map(hit => ({ kind: 'course' as const, hit })),
    ...programs.map(hit => ({ kind: 'program' as const, hit })),
  ], [courses, programs])
  const showList = open && query.trim().length > 0

  useEffect(() => {
    if (!showList) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [showList])

  const reset = () => {
    setQuery('')
    setOpen(false)
    setActive(0)
    rootRef.current?.querySelector('input')?.blur()
  }

  const pick = (row: Row) => {
    reset()
    if (row.kind === 'course') onPickCourse(row.hit.id)
    else onPickProgram(row.hit.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Esc ladder rung 2: clear the text and leave the field; never clears the selection too.
      event.preventDefault()
      event.stopPropagation()
      reset()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (rows.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter' && showList && rows.length) {
      event.preventDefault()
      pick(rows[Math.min(active, rows.length - 1)])
    }
  }

  const activeRow = showList && rows.length ? Math.min(active, rows.length - 1) : -1
  const optionId = (index: number) => `${listId}-option-${index}`
  const loadingPrograms = programIndex === null

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
        onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true) }}
        onFocus={() => { onWantPrograms(); if (query.trim()) setOpen(true) }}
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
                      onMouseEnter={() => setActive(index)}
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
                        onMouseEnter={() => setActive(index)}
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
          {rows.length === 0 && !loadingPrograms && <div className="search-note" role="status">{format(t.noMatch, { q: query.trim() })}</div>}
          {loadingPrograms && <div className="search-note" role="status">{t.loadingPrograms}</div>}
        </div>
      )}
    </div>
  )
}
