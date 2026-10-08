// Right panel host (design-spec 6.7): tabs Course / Program / My courses driven by state.panel,
// collapsible to a 48 px rail (state.panelCollapsed). The Course tab stays mounted (hidden) while
// another tab is shown or the panel is collapsed, so its chain lists remain the screen-reader
// fallback of the map (section 12).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { actions, useApp, type PanelId } from '../../app/store'
import { loadPrograms } from '../../data/load'
import { format, formatNumber, useLang, useStrings } from '../../i18n'
import { useCampusData } from './context'
import { CoursePanel } from './CoursePanel'
import { codeOf, programCode, programDisplayTitle } from './format'
import { PanelEnvProvider } from './parts'
import { ProgramPanel } from './ProgramPanel'
import { RecordPanel } from './RecordPanel'
import { panelStrings, type PanelStrings } from './strings'
import type { PanelProps } from './types'
import './panels.css'

type Tab = Exclude<PanelId, null>

const TABS: readonly Tab[] = ['course', 'program', 'record']
const RAIL_LABEL: Record<Tab, keyof PanelStrings> = { course: 'railCourse', program: 'railProgram', record: 'railRecord' }

export function RightPanel(outer: PanelProps) {
  // The shell may pass a fresh onCenter on every render (zoom, hover); a stable wrapper keeps the
  // memoised panel views from re-rendering with it.
  const centerRef = useRef(outer.onCenter)
  useLayoutEffect(() => { centerRef.current = outer.onCenter })
  const onCenter = useCallback((courseId: string) => centerRef.current(courseId), [])
  const props: PanelProps = { ...outer, onCenter }

  const s = useStrings(panelStrings)
  const lang = useLang()
  const panel = useApp(state => state.panel)
  const collapsed = useApp(state => state.panelCollapsed)
  const focusId = useApp(state => state.focusId)
  const programId = useApp(state => state.programId)
  const recordSize = useApp(state => state.record.size)

  // state.panel becomes null when the selection is cleared; the host keeps showing that tab.
  const [lastTab, setLastTab] = useState<Tab>(panel ?? 'course')
  if (panel && panel !== lastTab) setLastTab(panel)
  const tab = panel ?? lastTab

  // Program data is lazy: mount the Program and My courses tabs on first visit, then keep them.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['course', tab]))
  if (!collapsed && !visited.has(tab)) setVisited(new Set([...visited, tab]))

  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const railRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const bodyRefs = useRef<Partial<Record<Tab, HTMLDivElement | null>>>({})
  const pendingFocus = useRef<'tab' | 'rail' | 'title' | null>(null)
  const wasCollapsed = useRef(collapsed)
  const current = useRef({ tab, focusId })
  useLayoutEffect(() => { current.current = { tab, focusId } })

  useLayoutEffect(() => {
    const expanded = wasCollapsed.current && !collapsed
    wasCollapsed.current = collapsed
    const pending = pendingFocus.current
    pendingFocus.current = null
    let target: HTMLElement | null | undefined = null
    if (pending === 'tab') target = tabRefs.current[tab]
    else if (pending === 'rail') target = railRefs.current[tab]
    // A chip pick remounts the Course tab for the new course: continue from its title.
    else if (pending === 'title') target = bodyRefs.current.course?.querySelector<HTMLElement>('.rp-title')
    // Expanded from outside (Details, shortcut) and the control that had focus is gone.
    else if (expanded && (!document.activeElement || document.activeElement === document.body)) target = tabRefs.current[tab]
    target?.focus()
  }, [collapsed, tab, focusId])

  // Called before a chip selects a course; nothing moves when that course is already shown.
  const onPick = useCallback((courseId: string) => {
    if (courseId !== current.current.focusId || current.current.tab !== 'course') pendingFocus.current = 'title'
  }, [])

  // A new course or program starts at the top of its tab.
  useEffect(() => { bodyRefs.current.course?.scrollTo({ top: 0 }) }, [focusId])
  useEffect(() => { bodyRefs.current.program?.scrollTo({ top: 0 }) }, [programId])

  const open = (next: Tab) => {
    actions.openPanel(next)
    if (collapsed) {
      pendingFocus.current = 'tab'
      actions.toggle('panelCollapsed')
    }
  }
  const collapse = () => {
    pendingFocus.current = 'rail'
    actions.toggle('panelCollapsed')
  }
  const onTabKey = (event: KeyboardEvent, index: number) => {
    const last = TABS.length - 1
    const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1
    if (next < 0) return
    event.preventDefault()
    actions.openPanel(TABS[next])
    tabRefs.current[TABS[next]]?.focus()
  }

  // Program data is cached per campus; the rail names the program by its POSt code, or by its
  // title when the calendar gives no code (the id then holds only the page slug).
  const programs = useCampusData(props.campus, loadPrograms, programId !== null)
  const program = programId && programs.status === 'ready' ? programs.data.programs.find(item => item.id === programId) : undefined
  const programDetail = program ? programCode(program) ?? programDisplayTitle(program.title, program.code) : null

  const tabLabel = (t: Tab) => t === 'course' ? s.tabCourse : t === 'program' ? s.tabProgram
    : recordSize ? format(s.tabRecordCount, { n: formatNumber(recordSize, lang) }) : s.tabRecord
  const activeDetail: Record<Tab, string | null> = {
    course: focusId ? codeOf(focusId) : null,
    program: programDetail,
    record: recordSize ? formatNumber(recordSize, lang) : null,
  }
  const panels: Record<Tab, ReactNode> = {
    course: <CoursePanel {...props} />,
    program: <ProgramPanel {...props} />,
    record: <RecordPanel {...props} />,
  }

  return (
    <PanelEnvProvider props={props} onPick={onPick}>
      <aside className="rp" data-collapsed={collapsed} aria-label={s.panelLabel}>
        {collapsed ? (
          <nav className="rp-rail" aria-label={s.railLabel}>
            {TABS.map(t => {
              const label = s[RAIL_LABEL[t]]
              const detail = activeDetail[t]
              const title = detail ? format(s.railActive, { label, detail }) : label
              return (
                <button
                  key={t}
                  ref={element => { railRefs.current[t] = element }}
                  type="button"
                  className="rp-rail-btn"
                  aria-label={title}
                  title={title}
                  onClick={() => open(t)}
                >
                  <TabIcon tab={t} />
                  {detail ? <span className={`rp-rail-dot rp-rail-dot-${t}`} aria-hidden="true" /> : null}
                </button>
              )
            })}
          </nav>
        ) : null}
        <div className="rp-card" hidden={collapsed}>
          <div className="rp-tabs">
            <div className="rp-tablist" role="tablist" aria-label={s.tabsLabel}>
              {TABS.map((t, i) => (
                <button
                  key={t}
                  ref={element => { tabRefs.current[t] = element }}
                  type="button"
                  role="tab"
                  id={`rp-tab-${t}`}
                  aria-selected={t === tab}
                  aria-controls={`rp-tabpanel-${t}`}
                  tabIndex={t === tab ? 0 : -1}
                  className="rp-tab"
                  onClick={() => open(t)}
                  onKeyDown={event => onTabKey(event, i)}
                >
                  {tabLabel(t)}
                </button>
              ))}
            </div>
            <button type="button" className="rp-collapse" aria-label={s.collapse} title={s.collapse} onClick={collapse}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <path d="M3 3.5 6.5 7 3 10.5M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {TABS.map(t => (
            <div
              key={t}
              ref={element => { bodyRefs.current[t] = element }}
              role="tabpanel"
              id={`rp-tabpanel-${t}`}
              aria-labelledby={`rp-tab-${t}`}
              className="rp-body"
              hidden={t !== tab}
              tabIndex={0}
            >
              {visited.has(t) ? panels[t] : null}
            </div>
          ))}
        </div>
      </aside>
    </PanelEnvProvider>
  )
}

function TabIcon({ tab }: { tab: Tab }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {tab === 'course' ? (
        <>
          <circle cx="9" cy="9" r="6" />
          <circle cx="9" cy="9" r="2.25" fill="currentColor" stroke="none" />
        </>
      ) : tab === 'program' ? (
        <>
          <path d="M1.75 7.25 9 3.75l7.25 3.5L9 10.75z" />
          <path d="M4.75 9v3.4c1.2 1.1 2.7 1.6 4.25 1.6s3.05-.5 4.25-1.6V9" />
          <path d="M16.25 7.25v4" />
        </>
      ) : (
        <>
          <path d="M2.75 5.25 4.25 6.75 6.75 4" />
          <path d="M9.25 5.5h6" />
          <path d="M2.75 11.25 4.25 12.75 6.75 10" />
          <path d="M9.25 11.5h6" />
        </>
      )}
    </svg>
  )
}
