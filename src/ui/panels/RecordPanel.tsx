// My courses tab (design-spec 6.7.3): the student record grouped by status with counts and
// credits, an "Add a course…" search, and JSON import / export / clear. Stored only locally.
import { memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { actions, type RecordEntry } from '../../app/store'
import type { RecordStatus } from '../../graph/types'
import { format, formatNumber, useLang, useStrings } from '../../i18n'
import { campusName, RECORD_LABEL, RecordGlyph } from './CourseChip'
import { PanelContext, usePanelEnv } from './context'
import { campusOf, coursesText, creditsText, plural } from './format'
import { PanelEnvProvider } from './parts'
import {
  exportRecordJson, groupRecord, importErrorText, importRecordText, MAX_IMPORT_BYTES, nextRecordEntry, RECORD_FILE_NAME, recordMark, recordTotals,
  searchCourses, STATUS_ORDER, type ImportError, type RecordRow,
} from './record'
import { panelStrings } from './strings'
import type { PanelProps } from './types'

export function RecordPanel(props: PanelProps) {
  const env = useContext(PanelContext)
  if (env) return <RecordView />
  return (
    <PanelEnvProvider props={props}>
      <RecordView />
    </PanelEnvProvider>
  )
}

const RecordView = memo(function RecordView() {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { record, courses } = usePanelEnv()
  const groups = useMemo(() => groupRecord(record, courses), [record, courses])
  const totals = recordTotals(groups)
  return (
    <div className="rp-record-panel">
      <div className="rp-pad rp-record-top">
        <p className="rp-note">{s.recordNote}</p>
        <div className="rp-stats">
          {STATUS_ORDER.map(status => (
            <div key={status} className="rp-stat">
              {/* The label has its own line and may wrap; the glyph sits with the count. */}
              <span className="rp-stat-label">{s[RECORD_LABEL[status]]}</span>
              <span className="rp-stat-value">
                <RecordGlyph status={status} />
                {formatNumber(totals[status].count, lang)}
              </span>
              <span className="rp-stat-meta">{creditsText(totals[status].credits, lang, s)}</span>
            </div>
          ))}
        </div>
        <AddCourse />
      </div>
      {record.size === 0 ? (
        <p className="rp-pad rp-muted">{s.recordEmpty}</p>
      ) : (
        STATUS_ORDER.map(status => (groups[status].length ? <RecordGroup key={status} status={status} rows={groups[status]} credits={totals[status].credits} /> : null))
      )}
      <RecordActions count={record.size} />
    </div>
  )
})

function AddCourse() {
  const s = useStrings(panelStrings)
  const { dataset, record } = usePanelEnv()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchCourses(dataset.courses, query), [dataset, query])
  const listId = useId()
  const add = (courseId: string) => {
    if (!record.has(courseId)) actions.setRecord(courseId, { status: 'completed' })
    setQuery('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && results.length) {
      event.preventDefault()
      add(results[0].id)
    } else if (event.key === 'Escape' && query) {
      event.stopPropagation()
      setQuery('')
    }
  }
  return (
    <div className="rp-add">
      <input
        type="search"
        className="rp-input rp-search"
        placeholder={s.addCourse}
        aria-label={s.addCourseLabel}
        aria-controls={listId}
        autoComplete="off"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div id={listId}>
        {query.trim() ? (
          results.length ? (
            <ul className="rp-results">
              {results.map(course => {
                const mark = recordMark(record.get(course.id))
                return (
                  <li key={course.id}>
                    <button type="button" className="rp-result" onClick={() => add(course.id)}>
                      <span className="rp-result-code" lang="en">{course.code}</span>
                      <span className="rp-result-title" lang="en">{course.title}</span>
                      {mark ? <span className="rp-result-state">{format(s.onRecord, { status: s[RECORD_LABEL[mark]] })}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="rp-muted rp-results-empty">{format(s.addNoMatch, { q: query.trim() })}</p>
          )
        ) : null}
      </div>
    </div>
  )
}

function RecordGroup({ status, rows, credits }: { status: RecordStatus; rows: readonly RecordRow[]; credits: number }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const headingId = useId()
  return (
    <section className="rp-rgroup" aria-labelledby={headingId}>
      <h3 className="rp-rgroup-title" id={headingId}>
        <span>{s[RECORD_LABEL[status]]}</span>
        <span className="rp-count">
          {format(s.groupCredits, { n: formatNumber(rows.length, lang), credits: creditsText(credits, lang, s) })}
        </span>
      </h3>
      <ul className="rp-rrows">
        {rows.map(row => <RecordRowView key={row.id} row={row} />)}
      </ul>
    </section>
  )
}

function RecordRowView({ row }: { row: RecordRow }) {
  const s = useStrings(panelStrings)
  const { dataset, pick } = usePanelEnv()
  const campus = campusOf(row.id)
  const missingLabel = campus && campus !== dataset.campus ? campusName(campus, s) : s.notInCalendar
  const setStatus = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = nextRecordEntry(row.entry, event.target.value as RecordStatus)
    if (next !== 'unchanged') actions.setRecord(row.id, next)
  }
  const statusLabel = format(s.changeStatus, { code: row.code })
  const removeLabel = format(s.remove, { code: row.code })
  // A failed attempt stays in the Completed group (its status) but is marked as not passed.
  const mark = recordMark(row.entry)
  const failed = mark === 'failed'
  return (
    <li className="rp-rrow">
      <span className="rp-status-menu" title={statusLabel}>
        <RecordGlyph status={mark} />
        <svg className="rp-menu-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <select aria-label={statusLabel} value={row.entry.status} onChange={setStatus}>
          {STATUS_ORDER.map(status => <option key={status} value={status}>{s[RECORD_LABEL[status]]}</option>)}
        </select>
      </span>
      {row.title ? (
        <button type="button" className="rp-rrow-main" title={row.title} onClick={() => pick(row.id)}>
          <span className="rp-rrow-code" lang="en">{row.code}</span>
          <span className="rp-rrow-title" lang="en">{row.title}</span>
        </button>
      ) : (
        <span className="rp-rrow-main rp-rrow-missing">
          <span className="rp-rrow-code" lang="en">{row.code}</span>
          <span className="rp-rrow-title">{missingLabel}</span>
        </span>
      )}
      {row.entry.grade !== undefined ? (
        <span className={failed ? 'rp-rrow-grade rp-rrow-failed' : 'rp-rrow-grade'} title={failed ? s.notPassed : undefined}>
          {row.entry.grade}%
          {failed ? <span className="rp-sr">{s.srSep}{s.notPassed}</span> : null}
        </span>
      ) : null}
      <button type="button" className="rp-icon-btn" aria-label={removeLabel} title={removeLabel} onClick={() => actions.setRecord(row.id, null)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 3 9 9M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  )
}

type Message = { kind: 'ok'; count: number; file: string } | { kind: 'error'; error: ImportError }

/** A parsed import waiting for "Replace" because the current record is not empty. */
interface PendingImport {
  record: Map<string, RecordEntry>
  file: string
}

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function RecordActions({ count }: { count: number }) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { record } = usePanelEnv()
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  // After an inline confirmation closes, focus returns to the button that opened it.
  const restore = useRef<'import' | 'clear' | null>(null)
  useLayoutEffect(() => {
    if (confirming || pending || !restore.current) return
    const target = restore.current === 'import' ? importRef.current : clearRef.current
    restore.current = null
    target?.focus()
  }, [confirming, pending])

  const apply = (next: PendingImport) => {
    actions.replaceRecord(next.record)
    setMessage({ kind: 'ok', count: next.record.size, file: next.file })
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setMessage(null)
    if (file.size > MAX_IMPORT_BYTES) return setMessage({ kind: 'error', error: { key: 'importTooLarge' } })
    let text: string
    try {
      text = await file.text()
    } catch {
      return setMessage({ kind: 'error', error: { key: 'importUnreadable' } })
    }
    const result = importRecordText(text)
    if (!result.ok) return setMessage({ kind: 'error', error: result.error })
    const next = { record: result.record, file: file.name }
    // Replacing a record the student built is confirmed first; an empty record just loads.
    if (count > 0) setPending(next)
    else apply(next)
  }

  const closePending = (replace: boolean) => {
    if (replace && pending) apply(pending)
    restore.current = 'import'
    setPending(null)
  }
  const closeConfirm = (clear: boolean) => {
    if (clear) {
      actions.replaceRecord(new Map())
      setMessage(null)
    }
    restore.current = 'clear'
    setConfirming(false)
  }

  const empty = count === 0
  return (
    <div className="rp-actions">
      {pending ? (
        <div className="rp-confirm" role="group" aria-label={s.importJson}>
          <span>
            {format(s.importReplace, {
              current: coursesText(count, lang, s),
              incoming: coursesText(pending.record.size, lang, s),
              file: pending.file,
            })}
          </span>
          <button type="button" className="rp-btn" autoFocus onClick={() => closePending(false)}>{s.cancel}</button>
          <button type="button" className="rp-btn rp-btn-danger" onClick={() => closePending(true)}>{s.replace}</button>
        </div>
      ) : confirming ? (
        <div className="rp-confirm" role="group" aria-label={s.clearAll}>
          <span>{format(plural(count, s.clearConfirmOne, s.clearConfirmMany), { n: formatNumber(count, lang) })}</span>
          <button type="button" className="rp-btn" autoFocus onClick={() => closeConfirm(false)}>{s.cancel}</button>
          <button type="button" className="rp-btn rp-btn-danger" onClick={() => closeConfirm(true)}>{s.clear}</button>
        </div>
      ) : (
        <div className="rp-action-row">
          <button ref={importRef} type="button" className="rp-btn" onClick={() => fileRef.current?.click()}>{s.importJson}</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden tabIndex={-1} onChange={onFile} />
          <button
            type="button"
            className="rp-btn"
            aria-disabled={empty}
            title={empty ? s.exportEmpty : undefined}
            onClick={() => { if (!empty) download(exportRecordJson(record), RECORD_FILE_NAME) }}
          >
            {s.exportJson}
          </button>
          <button
            ref={clearRef}
            type="button"
            className="rp-btn"
            aria-disabled={empty}
            title={empty ? s.exportEmpty : undefined}
            onClick={() => {
              if (empty) return
              setMessage(null)
              setConfirming(true)
            }}
          >
            {s.clearAll}
          </button>
        </div>
      )}
      {message ? (
        message.kind === 'error'
          ? <p className="rp-danger" role="alert">{importErrorText(message.error, s)}</p>
          : <p className="rp-ok" role="status">{format(s.importDone, { courses: coursesText(message.count, lang, s), file: message.file })}</p>
      ) : null}
    </div>
  )
}
