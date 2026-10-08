// Application shell: loads the campus, wires the store, the graph pipeline, the canvas, the right
// panel and the chrome together (design-spec 6, 10.1, 11.3, 14).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CampusEntry, CampusRegistry, GraphDataset, ProgramsDataset } from '../data/schema'
import { createEngine } from '../domain/engine'
import type { GraphCanvasHandle, PlotSize } from '../graph/canvas-types'
import { GraphCanvas } from '../graph/GraphCanvas'
import { createLabelMeasure, useTextMetricsVersion } from '../graph/text'
import { buildTopology } from '../graph/topology'
import { useStrings } from '../i18n'
import { CardHead, cardMeta } from '../ui/CardHead'
import { Footer } from '../ui/Footer'
import { Header, type HeaderSearchProps } from '../ui/Header'
import { LegendStrip } from '../ui/LegendStrip'
import { RightPanel } from '../ui/panels/RightPanel'
import { ShortcutsHelp } from '../ui/ShortcutsHelp'
import { StartStrip } from '../ui/StartStrip'
import { commonStrings } from '../ui/strings'
import { subjectTones } from '../ui/SubjectBullet'
import { Toolbar } from '../ui/Toolbar'
import { usePopover } from '../ui/usePopover'
import { decideLanding, type Landing } from './landing'
import { computeReadout, shownCounts } from './readout'
import { buildCourseIndex, buildProgramIndex, programShortTitle } from './search'
import { actions, appStore, createStore, useApp } from './store'
import { useResolvedTheme } from './theme'
import { parseHash, startUrlSync } from './url'
import { useBreakpoint, type Breakpoint } from './useBreakpoint'
import { useCampusData, type CampusData } from './useCampusData'
import { useCourseById, useGraphModel } from './useGraphModel'
import { usePrograms } from './usePrograms'
import { consumeEscape, useShortcuts } from './useShortcuts'

type ViewRequest = { kind: 'frame'; target: 'chain' | 'program' } | { kind: 'lane'; subject: string }

const NO_TONES = new Map()

/** 000-level courses count as 100-level (presentation's level filter). */
const levelGroup = (level: number) => Math.max(100, Math.floor(level / 100) * 100)

export function App() {
  const data = useCampusData()
  const breakpoint = useBreakpoint()
  if (data.status === 'ready') return <Workspace key={data.campus.id} {...data} breakpoint={breakpoint} />
  return <LoadingShell data={data} breakpoint={breakpoint} />
}

// ---------------------------------------------------------------------------
// Page frame shared by the loading state and the workspace.

interface ShellProps {
  breakpoint: Breakpoint
  registry: CampusRegistry | null
  campus: CampusEntry | null
  dataset: GraphDataset | null
  search: HeaderSearchProps
  programTitle: string | null
  children: ReactNode
  /** Rendered after the footer: dialogs. */
  overlay?: ReactNode
}

function focusGraph(): void {
  const area = document.getElementById('graph-area')
  const target = area?.querySelector<HTMLElement>('[tabindex="0"]') ?? area
  target?.focus()
}

function Shell({ breakpoint, registry, campus, dataset, search, programTitle, children, overlay }: ShellProps) {
  const t = useStrings(commonStrings)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  return (
    <div className="app" data-bp={breakpoint}>
      <a className="skip-link" href="#graph-area" onClick={event => { event.preventDefault(); focusGraph() }}>{t.skipToMap}</a>
      <Header breakpoint={breakpoint} registry={registry} campus={campus} dataset={dataset} search={search} programTitle={programTitle} />
      {breakpoint === 'narrow' && !noticeDismissed && (
        <div className="narrow-notice" role="note">
          <span>{t.narrowNotice}</span>
          <button type="button" className="btn btn-small" onClick={() => setNoticeDismissed(true)}>{t.dismiss}</button>
        </div>
      )}
      <main className="main">{children}</main>
      <Footer campus={campus} dataset={dataset} />
      {overlay}
    </div>
  )
}

function LoadingShell({ data, breakpoint }: { data: Exclude<CampusData, { status: 'ready' }>; breakpoint: Breakpoint }) {
  const t = useStrings(commonStrings)
  const searchRef = useRef<HTMLInputElement>(null)
  const search: HeaderSearchProps = {
    courseIndex: null, programIndex: null, tones: NO_TONES, inputRef: searchRef,
    onWantPrograms: () => {}, onPickCourse: () => {}, onPickProgram: () => {},
  }
  return (
    <Shell breakpoint={breakpoint} registry={data.registry} campus={data.campus} dataset={null} search={search} programTitle={null}>
      <section className="graph-card" aria-busy={data.status === 'loading'}>
        <div className="graph-area graph-area-state" id="graph-area" tabIndex={-1}>
          {data.status === 'loading'
            ? <p className="load-state" role="status"><span className="spinner" aria-hidden="true" />{t.loading}</p>
            : (
              <div className="load-state" role="alert">
                <p>{t.loadError}</p>
                <button type="button" className="btn" onClick={data.retry}>{t.retry}</button>
              </div>
            )}
        </div>
      </section>
      <div className="panel-col panel-col-empty" aria-hidden="true" />
    </Shell>
  )
}

// ---------------------------------------------------------------------------
// Workspace: everything that needs the loaded dataset.

interface WorkspaceProps {
  registry: CampusRegistry
  campus: CampusEntry
  dataset: GraphDataset
  breakpoint: Breakpoint
}

function Workspace({ registry, campus, dataset, breakpoint }: WorkspaceProps) {
  const focusId = useApp(state => state.focusId)
  const programId = useApp(state => state.programId)
  const record = useApp(state => state.record)
  const levels = useApp(state => state.levels)
  const subjects = useApp(state => state.subjects)
  const hideCompleted = useApp(state => state.hideCompleted)
  const hideUnrelated = useApp(state => state.hideUnrelated)
  const onboarded = useApp(state => state.onboarded)
  const panelCollapsed = useApp(state => state.panelCollapsed)
  const theme = useResolvedTheme()

  // Static per dataset.
  const topology = useMemo(() => buildTopology(dataset), [dataset])
  const engine = useMemo(() => createEngine(dataset), [dataset])
  const courseById = useCourseById(dataset)
  const tones = useMemo(() => subjectTones(topology), [topology])
  const courseIndex = useMemo(() => buildCourseIndex(dataset), [dataset])
  const codeToId = useMemo(() => new Map(dataset.courses.map(course => [course.code, course.id])), [dataset])
  // The measurer caches widths per font; text.ts bumps the version when fonts or the language change.
  const metricsVersion = useTextMetricsVersion()
  const measure = useMemo(() => {
    void metricsVersion
    return createLabelMeasure(topology, dataset)
  }, [topology, dataset, metricsVersion])

  // Programs (lazy).
  const [programsWanted, setProgramsWanted] = useState(false)
  const programs = usePrograms(campus, programsWanted || programId !== null)
  const programsRef = useRef<ProgramsDataset | null>(programs)
  useEffect(() => { programsRef.current = programs }, [programs])
  const programIndex = useMemo(() => (programs ? buildProgramIndex(programs.programs) : null), [programs])
  const program = useMemo(() => (programs && programId ? programs.programs.find(entry => entry.id === programId) ?? null : null), [programs, programId])
  useEffect(() => {
    // A program id from the hash or a stored home that this calendar does not have.
    if (programs && programId && !program) actions.selectProgram(null)
  }, [programs, programId, program])
  const programIds = useMemo(() => {
    if (!program) return null
    const ids = engine.programProgress(program, record).courseIds
    return ids.length ? new Set(ids) : null
  }, [engine, program, record])

  // Graph pipeline.
  const [plot, setPlot] = useState<PlotSize | null>(null)
  const onPlotSize = useCallback((size: PlotSize) => {
    setPlot(previous => (previous && previous.width === size.width && previous.height === size.height ? previous : size))
  }, [])
  const model = useGraphModel(topology, courseById, engine, measure, programIds, plot)
  const { presentation, geometry, routes, focusIndex, focusCourse } = model

  // Canvas commands. Framing waits for the commit that carries the new geometry and a plot size.
  const canvasRef = useRef<GraphCanvasHandle>(null)
  // Zoom changes on every wheel frame: only the zoom readout subscribes, not the whole workspace.
  const zoom = useMemo(() => createStore({ zoom: 1 }), [])
  const onZoomChange = useCallback((value: number) => zoom.set({ zoom: value }), [zoom])
  const [request, setRequest] = useState<{ seq: number; view: ViewRequest } | null>(null)
  const handled = useRef(0)
  const requestView = useCallback((view: ViewRequest) => setRequest(previous => ({ seq: (previous?.seq ?? 0) + 1, view })), [])
  const waitingForPrograms = programId !== null && programs === null

  useEffect(() => {
    const handle = canvasRef.current
    if (!request || request.seq === handled.current || !handle || !plot) return
    const { view } = request
    if (view.kind === 'frame' && view.target === 'program' && waitingForPrograms) return
    handled.current = request.seq
    if (view.kind === 'lane') handle.scrollToLane(view.subject)
    else if (view.target === 'chain' ? focusIndex >= 0 : programIds !== null) handle.frame(view.target)
  }, [request, plot, geometry, focusIndex, programIds, waitingForPrograms])

  // Course selections that did not come from a click on the map frame the chain (hash, search,
  // panel chips); clicks anchor on the node inside GraphCanvas instead (10.4).
  const canvasSelection = useRef<string | null | undefined>(undefined)
  const previousFocus = useRef(focusId)
  useEffect(() => {
    if (focusId === previousFocus.current) return
    previousFocus.current = focusId
    const fromCanvas = canvasSelection.current === focusId
    canvasSelection.current = undefined
    if (focusId && !fromCanvas) requestView({ kind: 'frame', target: 'chain' })
  }, [focusId, requestView])

  const previousProgram = useRef(programId)
  useEffect(() => {
    if (programId === previousProgram.current) return
    previousProgram.current = programId
    if (programId && !appStore.get().focusId) requestView({ kind: 'frame', target: 'program' })
  }, [programId, requestView])

  useEffect(() => {
    if ((focusId || programId) && !onboarded) actions.setOnboarded()
  }, [focusId, programId, onboarded])

  // Landing (10.1) and URL sync, once per workspace.
  const searchRef = useRef<HTMLInputElement>(null)
  const autoFocusing = useRef(false)
  const [landing, setLanding] = useState<Landing | null>(null)
  useEffect(() => {
    const resolveCourse = (code: string) => codeToId.get(code) ?? null
    const resolveProgram = (code: string) =>
      programsRef.current ? programsRef.current.programs.find(entry => entry.code === code)?.id ?? null : `${campus.id}:${code}`
    const url = parseHash(window.location.hash)
    const state = appStore.get()
    const decided = decideLanding({
      hashCourse: url.course ? resolveCourse(url.course) : null,
      hashProgram: url.program ? resolveProgram(url.program) : null,
      home: state.home,
      onboarded: state.onboarded,
      startSubjects: campus.startSubjects ?? [],
      subjects: new Set(topology.lanes.map(lane => lane.subject)),
    })
    setLanding(decided)
    const stop = startUrlSync({ course: resolveCourse, program: resolveProgram })
    const { action } = decided
    if (action.kind === 'lane') requestView(action)
    else if (action.kind === 'program' && action.activate) actions.selectProgram(action.programId)
    if (decided.focusSearch) {
      autoFocusing.current = true
      searchRef.current?.focus()
      autoFocusing.current = false
    }
    return stop
  }, [campus, codeToId, topology, requestView])

  // Handlers.
  const onSelect = useCallback((id: string | null, via: 'click' | 'double-click' | 'keyboard') => {
    if (id === null) {
      if (appStore.get().focusId) {
        canvasSelection.current = null
        actions.clearFocus()
      } else if (via === 'keyboard') {
        actions.selectProgram(null)
      }
      // The graph handled this Esc (a rung of the ladder): the global handler must not take another.
      if (via === 'keyboard') consumeEscape()
      return
    }
    canvasSelection.current = id
    actions.selectCourse(id)
    if (via === 'double-click') requestView({ kind: 'frame', target: 'chain' })
  }, [requestView])

  const jumpToSubject = useCallback((subject: string) => {
    const visible = appStore.get().subjects
    if (visible && !visible.has(subject)) actions.setSubjects(new Set([...visible, subject]))
    actions.setHome({ kind: 'subject', id: subject })
    actions.setOnboarded()
    requestView({ kind: 'lane', subject })
  }, [requestView])

  const focusSearch = useCallback(() => {
    const input = searchRef.current
    input?.focus()
    input?.select()
  }, [])

  const [helpOpen, setHelpOpen] = useState(false)
  const closeHelp = useCallback(() => setHelpOpen(false), [])
  useShortcuts({
    focusSearch,
    zoomIn: () => canvasRef.current?.zoomIn(),
    zoomOut: () => canvasRef.current?.zoomOut(),
    fitWidth: () => canvasRef.current?.fitWidth(),
    resetZoom: () => canvasRef.current?.setZoom(1),
    frame: () => {
      const state = appStore.get()
      if (state.focusId) requestView({ kind: 'frame', target: 'chain' })
      else if (state.programId) requestView({ kind: 'frame', target: 'program' })
    },
    help: () => setHelpOpen(true),
  })

  const subjectPicker = usePopover()

  const search: HeaderSearchProps = {
    courseIndex,
    programIndex,
    tones,
    inputRef: searchRef,
    onWantPrograms: () => { if (!autoFocusing.current) setProgramsWanted(true) },
    onPickCourse: id => {
      if (id === appStore.get().focusId) requestView({ kind: 'frame', target: 'chain' })
      else actions.selectCourse(id)
    },
    onPickProgram: id => {
      actions.selectCourse(null)
      actions.selectProgram(id)
    },
  }

  // Card head.
  const shown = useMemo(() => shownCounts(topology, presentation), [topology, presentation])
  const hasCompleted = useMemo(() => [...record.values()].some(entry => entry.status === 'completed'), [record])
  const meta = cardMeta({
    subjects: topology.lanes.length,
    courses: topology.nodes.length,
    shownCourses: shown.courses,
    shownSubjects: shown.subjects,
    filtered: levels !== null || subjects !== null || (hideCompleted && hasCompleted),
    collapsing: hideUnrelated && presentation.dimming,
  })
  const readout = useMemo(
    () => (focusCourse && focusIndex >= 0 ? computeReadout(topology, presentation, focusIndex, focusCourse) : null),
    [topology, presentation, focusIndex, focusCourse],
  )
  const programTitle = program ? programShortTitle(program) : null
  const programCourses = useMemo(() => presentation.inProgram.filter(Boolean).length, [presentation])

  const showStart = Boolean(landing?.showStart) && !onboarded
  const startSubjects = useMemo(() => {
    const info = new Map(dataset.subjects.map(subject => [subject.code, subject]))
    const limit = breakpoint === 'compact' || breakpoint === 'narrow' ? 4 : 6
    return (campus.startSubjects ?? []).flatMap(code => info.get(code) ?? []).slice(0, limit)
  }, [dataset, campus, breakpoint])

  const levelCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const node of topology.nodes) {
      if (subjects && !subjects.has(node.subject)) continue
      const level = levelGroup(node.level)
      counts.set(level, (counts.get(level) ?? 0) + 1)
    }
    return counts
  }, [topology, subjects])

  const panelProps = useMemo(() => ({
    campus, dataset, topology, engine,
    onCenter: (courseId: string) => canvasRef.current?.centerOn(courseId),
    onClose: () => {
      if (appStore.get().panel === 'course') actions.clearFocus()
      else actions.openPanel(null)
    },
  }), [campus, dataset, topology, engine])

  const legendMode = focusIndex >= 0 ? 'chain' : programIds ? 'program' : 'overview'

  return (
    <Shell
      breakpoint={breakpoint} registry={registry} campus={campus} dataset={dataset} search={search} programTitle={programTitle}
      overlay={helpOpen && <ShortcutsHelp onClose={closeHelp} />}
    >
      <section className="graph-card" aria-labelledby="card-title">
        <CardHead
          breakpoint={breakpoint}
          meta={meta}
          focus={focusCourse && readout ? { course: focusCourse, readout } : null}
          program={!focusCourse && program && programTitle ? { title: programTitle, courses: programCourses } : null}
          start={showStart && !focusCourse && !program
            ? <StartStrip subjects={startSubjects} tones={tones} onJump={jumpToSubject} onAllSubjects={() => subjectPicker.setOpen(true)} />
            : null}
          onDetails={() => actions.showPanel('course')}
          onClear={() => actions.clearFocus()}
          onClearProgram={() => actions.selectProgram(null)}
        />
        <Toolbar
          breakpoint={breakpoint}
          topology={topology}
          subjects={dataset.subjects}
          divisions={dataset.divisions}
          tones={tones}
          levelCounts={levelCounts}
          subjectPicker={subjectPicker}
          hasFocus={focusIndex >= 0}
          programActive={programIds !== null}
          zoom={zoom}
          onJumpSubject={jumpToSubject}
          onZoomIn={() => canvasRef.current?.zoomIn()}
          onZoomOut={() => canvasRef.current?.zoomOut()}
          onZoomReset={() => canvasRef.current?.setZoom(1)}
          onFit={() => canvasRef.current?.fitWidth()}
        />
        <div className="graph-area" id="graph-area" tabIndex={-1}>
          <GraphCanvas
            ref={canvasRef}
            dataset={dataset}
            topology={topology}
            presentation={presentation}
            geometry={geometry}
            routes={routes}
            measure={measure}
            theme={theme}
            selectedId={focusIndex >= 0 ? focusId : null}
            programActive={programIds !== null}
            onSelect={onSelect}
            onZoomChange={onZoomChange}
            onPlotSize={onPlotSize}
          />
        </div>
        <LegendStrip mode={legendMode} recordActive={record.size > 0} />
      </section>
      <div className="panel-col" data-collapsed={panelCollapsed || undefined}>
        <RightPanel {...panelProps} />
      </div>
    </Shell>
  )
}
