// Subject picker (design-spec 6.9.2): visibility per subject, grouped by division in lane order,
// with a filter field and a Jump action that also makes the subject the landing home. Pins are not
// in V1 (owner decision 19.2).
import { useEffect, useMemo, useRef, useState } from 'react'
import { actions, useApp } from '../app/store'
import type { Division, SubjectInfo } from '../data/schema'
import type { Topology } from '../graph/types'
import { format, formatNumber, useStrings } from '../i18n'
import { subjectStrings } from './strings'
import { divisionBar, SubjectBullet, type SubjectTone } from './SubjectBullet'

interface SubjectPickerProps {
  topology: Topology
  subjects: readonly SubjectInfo[]
  divisions: readonly Division[]
  tones: ReadonlyMap<string, SubjectTone>
  onJump(subject: string): void
}

interface Group {
  id: string
  label: string
  rows: SubjectInfo[]
}

/** Subjects in lane (architecture) order, grouped by division. */
export function groupSubjects(topology: Topology, subjects: readonly SubjectInfo[], divisions: readonly Division[], other: string): Group[] {
  const info = new Map(subjects.map(subject => [subject.code, subject]))
  const labels = new Map(divisions.map(division => [division.id, division.label]))
  const groups: Group[] = []
  for (const lane of topology.lanes) {
    const subject = info.get(lane.subject) ?? { code: lane.subject, name: lane.name, department: lane.department, division: lane.division, courseCount: lane.nodes.length }
    const id = labels.has(lane.division) ? lane.division : 'other'
    let group = groups.at(-1)
    if (!group || group.id !== id) {
      group = { id, label: labels.get(id) ?? other, rows: [] }
      groups.push(group)
    }
    group.rows.push(subject)
  }
  return groups
}

export function SubjectPicker({ topology, subjects, divisions, tones, onJump }: SubjectPickerProps) {
  const t = useStrings(subjectStrings)
  const lang = useApp(state => state.lang)
  const visible = useApp(state => state.subjects)
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => { filterRef.current?.focus() }, [])

  const groups = useMemo(() => groupSubjects(topology, subjects, divisions, t.other), [topology, subjects, divisions, t.other])
  const all = useMemo(() => groups.flatMap(group => group.rows.map(row => row.code)), [groups])
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? groups
      .map(group => ({ ...group, rows: group.rows.filter(row => row.code.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)) }))
      .filter(group => group.rows.length)
    : groups

  const toggle = (code: string) => {
    const next = new Set(visible ?? all)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    actions.setSubjects(next.size === all.length ? null : next)
  }

  return (
    <div className="popover subject-picker" role="dialog" aria-label={t.title}>
      <div className="picker-top">
        <input ref={filterRef} type="search" className="field" placeholder={t.filter} aria-label={t.filter}
          value={filter} onChange={event => setFilter(event.target.value)} />
        <div className="picker-actions">
          <button type="button" className="chip chip-small" aria-pressed={visible === null} onClick={() => actions.setSubjects(null)}>{t.all}</button>
          <button type="button" className="chip chip-small" aria-pressed={visible !== null && visible.size === 0} onClick={() => actions.setSubjects(new Set())}>{t.none}</button>
        </div>
      </div>
      <div className="picker-list">
        {shown.length === 0 && <p className="picker-empty">{format(t.noMatch, { q: filter.trim() })}</p>}
        {shown.map(group => (
          <div key={group.id} className="picker-group" role="group" aria-labelledby={`division-${group.id}`}>
            <div className="picker-division" id={`division-${group.id}`}>
              <span className="division-bar" style={{ background: divisionBar(group.id) }} aria-hidden="true" />
              <span lang="en">{group.label}</span>
            </div>
            {group.rows.map(row => {
              const checked = visible === null || visible.has(row.code)
              const name = `${row.name} (${row.code})`
              return (
                <div key={row.code} className="picker-row">
                  <input type="checkbox" className="checkbox" checked={checked} aria-label={format(t.show, { name })}
                    onChange={() => toggle(row.code)} />
                  <SubjectBullet code={row.code} tone={tones.get(row.code)} />
                  <button type="button" className="picker-name" lang="en" title={format(t.jumpTitle, { name })}
                    onClick={() => onJump(row.code)}>{row.name}</button>
                  <span className="picker-count" aria-label={format(t.count, { n: row.courseCount })}>{formatNumber(row.courseCount, lang)}</span>
                  <button type="button" className="picker-jump" title={format(t.jumpTitle, { name })} tabIndex={-1}
                    onClick={() => onJump(row.code)}>{t.jump}</button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
