import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, Database, ExternalLink, GitBranch, GraduationCap, Layers, List, LoaderCircle, Map as MapIcon, Search, ShieldCheck, SlidersHorizontal, UserRound, X } from 'lucide-react'
import { createEmptyProfile, evaluateEligibility, getRelatedCourses, parseStudentProfile, PROFILE_STORAGE_KEY } from './domain'
import type { Catalog, Course, Status, StudentCourse, StudentProfile } from './domain/types'
import { CourseDetails } from './components/CourseDetails'
import { ProfileDialog } from './components/ProfileDialog'
import { ProgramPanel } from './components/ProgramPanel'
import { StatusBadge } from './components/StatusBadge'
import type { Relation } from './components/graph-layout'
import './styles.css'

const CourseGraph = lazy(() => import('./components/CourseGraph'))
const PROFILE_KEY = PROFILE_STORAGE_KEY
const SUBJECT_NAMES: Record<string, string> = { CSC: 'Computer Science', MAT: 'Mathematics', STA: 'Statistics', BIO: 'Biology', CHM: 'Chemistry', PHY: 'Physics', PSY: 'Psychology', ECO: 'Economics', ENG: 'English', SOC: 'Sociology', ANT: 'Anthropology', HIS: 'History', POL: 'Political Science', PHL: 'Philosophy', MGT: 'Management', ENV: 'Environment', GGR: 'Geography', VCC: 'Visual Culture', CCT: 'Communication & Culture', JCP: 'Chemical & Physical Sciences' }
type Tab = 'courses' | 'programs' | 'profile'
function readProfile(): { profile: StudentProfile; error: string } {
  try { const saved = localStorage.getItem(PROFILE_KEY); return { profile: saved ? parseStudentProfile(saved) : createEmptyProfile(), error: '' } }
  catch { return { profile: createEmptyProfile(), error: '本机档案无法读取。原始记录尚未覆盖；请导入有效档案，或从档案设置重新开始。' } }
}

function App() {
  const [catalog, setCatalog] = useState<Catalog>()
  const [loadError, setLoadError] = useState('')
  const [initialProfile] = useState(readProfile)
  const [profile, setProfile] = useState(initialProfile.profile)
  const [storageError, setStorageError] = useState(initialProfile.error)
  const [tab, setTab] = useState<Tab>('courses')
  const [view, setView] = useState<'graph' | 'list'>(() => window.matchMedia('(max-width: 760px)').matches ? 'list' : 'graph')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [searchFocused, setSearchFocused] = useState(false)
  const [subject, setSubject] = useState('')
  const [level, setLevel] = useState(0)
  const [hideCompleted, setHideCompleted] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [programId, setProgramId] = useState('')
  const [programType, setProgramType] = useState('')
  const [profileFilter, setProfileFilter] = useState('')
  const [showProfile, setShowProfile] = useState(false)
  const [showData, setShowData] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [expandDependencies, setExpandDependencies] = useState(false)
  const [limit, setLimit] = useState(60)
  const [relations, setRelations] = useState<Relation[]>(['prerequisite', 'corequisite'])
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}data/catalog.json`, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error(`目录加载失败 (${response.status})`); return response.json() as Promise<Catalog> }).then(data => { if (data.schemaVersion !== 1 || !Array.isArray(data.courses) || !Array.isArray(data.programs)) throw new Error('目录格式不兼容'); setCatalog(data); setSelectedId(null) }).catch(error => { if (error.name !== 'AbortError') setLoadError(error.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  const changeProfile = useCallback((next: StudentProfile) => { setProfile(next); try { localStorage.setItem(PROFILE_KEY, JSON.stringify(next)); setStorageError('') } catch { setStorageError('浏览器不允许保存档案；当前更改只在本次访问有效，请导出备份。') } }, [])
  const onRecord = useCallback((courseId: string, status?: StudentCourse['status'], grade?: number) => { const courses = profile.courses.filter(item => item.courseId !== courseId); if (status) courses.push({ courseId, status, ...(grade === undefined ? {} : { grade }) }); changeProfile({ ...profile, courses }) }, [profile, changeProfile])
  const records = useMemo(() => new Map(profile.courses.map(record => [record.courseId, record.status])), [profile.courses])
  const courseMap = useMemo(() => new Map(catalog?.courses.map(course => [course.id, course])), [catalog])
  const subjects = useMemo(() => { const counts = new Map<string, number>(); catalog?.courses.forEach(course => counts.set(course.subject, (counts.get(course.subject) ?? 0) + 1)); return [...counts].sort((a, b) => a[0].localeCompare(b[0])) }, [catalog])
  const selectedCourse = selectedId ? courseMap.get(selectedId) : undefined
  const related = useMemo(() => selectedId && catalog ? getRelatedCourses(selectedId, catalog.courses) : undefined, [selectedId, catalog])
  const relatedIds = useMemo(() => new Set([...(related?.transitivePrerequisites ?? []), ...(related?.transitiveDependents ?? [])]), [related])
  const focusedIds = useMemo(() => { if (!focusId || !catalog) return null; const links = getRelatedCourses(focusId, catalog.courses); return new Set([focusId, ...links.prerequisites, ...links.dependents]) }, [focusId, catalog])
  const searchPrograms = useMemo(() => catalog?.programs.filter(program => (!deferredQuery || `${program.code} ${program.title} ${program.type}`.toLowerCase().includes(deferredQuery)) && (!programType || program.type === programType)) ?? [], [catalog, deferredQuery, programType])
  const searchCourses = useMemo(() => catalog?.courses.filter(course => `${course.code} ${course.title} ${course.subject}`.toLowerCase().includes(deferredQuery)) ?? [], [catalog, deferredQuery])
  const filteredCourses = useMemo(() => {
    if (!catalog) return []
    let list = (deferredQuery ? searchCourses : catalog.courses).filter(course => {
      if (tab === 'profile') return records.has(course.id) && (!profileFilter || records.get(course.id) === profileFilter)
      if (focusId && focusedIds) return focusedIds.has(course.id)
      return (deferredQuery || !subject || course.subject === subject) && (!level || course.level === level) && (!hideCompleted || records.get(course.id) !== 'completed')
    })
    if (expandDependencies) { const ids = new Set(list.map(course => course.id)); for (const course of list) for (const id of [...course.prerequisites.courseIds, ...course.corequisites.courseIds]) ids.add(id); list = catalog.courses.filter(course => ids.has(course.id)) }
    return list
  }, [catalog, deferredQuery, searchCourses, tab, records, profileFilter, focusId, focusedIds, subject, level, hideCompleted, expandDependencies])
  const visibleCourses = useMemo(() => filteredCourses.slice(0, limit), [filteredCourses, limit])
  const graphCourses = useMemo(() => selectedId && catalog && tab === 'courses'
    ? catalog.courses.filter(course => course.id === selectedId || relatedIds.has(course.id))
    : filteredCourses, [selectedId, catalog, tab, relatedIds, filteredCourses])
  const displayedCourses = view === 'graph' ? graphCourses : visibleCourses
  const statuses = useMemo(() => new Map<string, Status>(displayedCourses.map(course => [course.id, evaluateEligibility(course, profile, catalog!.courses).status])), [displayedCourses, profile, catalog])
  const selectedProgram = catalog?.programs.find(program => program.id === programId)
  const onSelect = useCallback((id: string) => { setSelectedId(id); setSearchFocused(false) }, [])
  const onExpand = useCallback((id: string) => { setFocusId(id); setSelectedId(id); setTab('courses'); setQuery(''); setLevel(0); setLimit(60); setView(window.matchMedia('(max-width: 760px)').matches ? 'list' : 'graph'); setExpandDependencies(false) }, [])
  function resetScope() { setFocusId(null); setSelectedId(null); setExpandDependencies(false); setLimit(60) }
  const clearSelection = useCallback(() => { setSelectedId(null); setFocusId(null); setQuery(''); setSubject(''); setLevel(0); setHideCompleted(false); setExpandDependencies(false) }, [])
  function changeTab(next: Tab) { setTab(next); if (next !== 'courses') setSelectedId(null); setQuery(''); setLimit(60); if (next === 'profile') setView('list') }
  function selectSearchCourse(course: Course) { onSelect(course.id); setSubject(course.subject); setTab('courses'); setQuery(course.code); setLimit(60); setFocusId(null); setExpandDependencies(false) }

  if (!catalog) return <main className="app-loading"><div className="brand-mark"><GitBranch size={25} /></div><h1>UTM Pathways</h1>{loadError ? <><p role="alert">{loadError}</p><button className="primary-button" onClick={() => location.reload()}>重新加载目录</button></> : <><LoaderCircle className="spinning" size={21} /><p>正在载入当前 UTM Calendar…</p></>}</main>
  const completedCount = profile.courses.filter(course => course.status === 'completed').length
  const displayTitle = tab === 'programs' ? '找到属于你的专业方向' : tab === 'profile' ? '每一门课，都是你的进展' : '看见课程之间的联系'
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="app-header">
      <button className="brand" onClick={() => { changeTab('courses'); setSubject(''); setLevel(0); resetScope() }} aria-label="UTM Pathways 首页"><span className="brand-mark"><GitBranch size={22} strokeWidth={1.7} /></span><span>UTM <b>Pathways</b><small>COURSE EXPLORER</small></span></button>
      <nav className="main-nav" aria-label="主导航"><button className={tab === 'courses' ? 'active' : ''} onClick={() => changeTab('courses')}><MapIcon size={16} />探索课程</button><button className={tab === 'programs' ? 'active' : ''} onClick={() => changeTab('programs')}><GraduationCap size={17} />专业规划</button><button className={tab === 'profile' ? 'active' : ''} onClick={() => changeTab('profile')}><BookOpen size={16} />我的课程{profile.courses.length ? <span>{profile.courses.length}</span> : null}</button></nav>
      <div className="header-actions"><span className="campus-tag"><span /> UTM · Mississauga</span><button className="profile-button" onClick={() => setShowProfile(true)}><UserRound size={16} /><span>我的档案</span></button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar" aria-label="目录导航">
        <div className="sidebar-heading"><span className="eyebrow">EXPLORE THE CALENDAR</span><h2>{tab === 'programs' ? '专业目录' : tab === 'profile' ? '我的学习空间' : '课程目录'}</h2></div>
        {tab === 'programs' ? <><div className="sidebar-field"><label htmlFor="program-type">专业类型</label><select id="program-type" value={programType} onChange={event => setProgramType(event.target.value)}><option value="">全部类型 · {catalog.programs.length}</option>{[...new Set(catalog.programs.map(program => program.type))].sort().map(type => <option key={type}>{type}</option>)}</select></div><div className="program-nav-list">{searchPrograms.map(program => <button key={program.id} className={programId === program.id ? 'active' : ''} onClick={() => setProgramId(program.id)}><span>{program.title}</span><small>{program.type}</small></button>)}{!searchPrograms.length ? <p className="muted small-text">没有匹配的专业。</p> : null}</div></> : tab === 'profile' ? <div className="profile-nav"><button className={!profileFilter ? 'active' : ''} onClick={() => setProfileFilter('')}><Layers size={16} />全部记录<span>{profile.courses.length}</span></button>{([['completed', '已完成'], ['inProgress', '正在修读'], ['planned', '计划修读']] as const).map(([value, label]) => <button key={value} className={profileFilter === value ? 'active' : ''} onClick={() => setProfileFilter(value)}><span className={`status-dot status-${value}`} />{label}<span>{profile.courses.filter(record => record.status === value).length}</span></button>)}<button onClick={() => setShowProfile(true)}><SlidersHorizontal size={16} />管理档案<ArrowUpRight size={13} /></button></div> : <><button className={`all-subjects ${!subject ? 'active' : ''}`} onClick={() => { setSubject(''); setQuery(''); resetScope() }}><Layers size={16} />全部学科<span>{catalog.courses.length.toLocaleString()}</span></button><div className="sidebar-section-label">学科 / SUBJECT <span>{subjects.length}</span></div><div className="subject-list">{subjects.map(([code, count]) => <button key={code} className={subject === code && !focusId ? 'active' : ''} onClick={() => { setSubject(code); setQuery(''); setLevel(0); resetScope() }}><span><strong>{code}</strong><small>{SUBJECT_NAMES[code] ?? `${code} Courses`}</small></span><span className="subject-count">{count}</span></button>)}</div></>}
        <div className="sidebar-bottom"><div className="local-profile-mini"><span><ShieldCheck size={16} /> 本机学习档案</span><p><strong>{completedCount}</strong> 门已完成 <i /> {profile.courses.filter(course => course.status === 'planned').length} 门计划修读</p><button onClick={() => setShowProfile(true)}>管理修读记录 <ArrowRight size={13} /></button></div><button className="data-info-button" onClick={() => setShowData(true)}><Database size={14} /><span>{catalog.metadata.academicYear} Calendar</span><ArrowUpRight size={13} /></button></div>
      </aside>
      <div className="main-workspace" id="main-content">
        <section className="workspace-intro"><div><span className="eyebrow">{tab === 'programs' ? 'PLAN WITH PURPOSE' : tab === 'profile' ? 'YOUR LEARNING JOURNEY' : 'CONNECT YOUR POSSIBILITIES'}</span><h1>{displayTitle}<span className="title-dot">.</span></h1><p>{tab === 'programs' ? '从官方要求出发，让修读计划更有方向。' : tab === 'profile' ? '保存修读状态，让每一次规划有据可循。' : '探索先修关系，理解专业要求，规划你的下一步。'}</p></div><div className="catalog-stats"><div><b>{catalog.courses.length.toLocaleString()}</b><span>门课程</span></div><i /><div><b>{catalog.programs.length}</b><span>个专业 / 方向</span></div></div></section>
        <div className="search-row"><div className="search-box"><Search size={18} /><input ref={searchRef} type="search" aria-label="搜索课程或专业" placeholder="搜索课程代码、课程名称或专业…" value={query} onChange={event => { setQuery(event.target.value); setLimit(60); setFocusId(null); setSelectedId(null) }} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setSearchFocused(false) } if (event.key === 'Enter') setSearchFocused(false) }} /><kbd>/</kbd>{searchFocused && deferredQuery ? <div className="search-dropdown" onMouseDown={event => event.preventDefault()}><div className="search-group-title">COURSES <span>{searchCourses.length}</span></div>{searchCourses.slice(0, 4).map(course => <button key={course.id} onClick={() => selectSearchCourse(course)}><BookOpen size={15} /><span><b>{course.code}</b> {course.title}</span><ArrowUpRight size={13} /></button>)}<div className="search-group-title">PROGRAMS <span>{searchPrograms.length}</span></div>{searchPrograms.slice(0, 3).map(program => <button key={program.id} onClick={() => { setProgramId(program.id); setTab('programs'); setSearchFocused(false); setQuery('') }}><GraduationCap size={16} /><span>{program.title}</span><ArrowUpRight size={13} /></button>)}{!searchCourses.length && !searchPrograms.length ? <p>没有找到匹配结果，试试课程代码或英文名称。</p> : null}</div> : null}</div><button aria-label="查看数据快照说明" className="snapshot-button" onClick={() => setShowData(true)}><span className="fresh-dot" /><span>当前快照 · {catalog.metadata.academicYear}</span><ChevronDown size={13} /></button></div>
        {storageError ? <div className="storage-error" role="alert">{storageError}<button onClick={() => setShowProfile(true)}>管理档案</button></div> : null}
        {!catalog.metadata.complete ? <div className="storage-error" role="alert">当前目录快照存在采集缺口，请查看数据报告。</div> : null}
        <div className={`content-layout ${selectedCourse ? 'with-inspector' : ''}`}>
          <main className="main-panel">
            {tab === 'programs' ? <><div className="mobile-program-select"><label>选择专业<select aria-label="选择专业" value={programId} onChange={event => setProgramId(event.target.value)}><option value="">选择专业…</option>{searchPrograms.map(program => <option key={program.id} value={program.id}>{program.title}</option>)}</select></label></div><ProgramPanel key={programId} program={selectedProgram} catalog={catalog} profile={profile} onSelectCourse={onSelect} onProfile={() => setShowProfile(true)} /></> : <>
              <div className="panel-heading"><div><GitBranch size={18} /><h2>{tab === 'profile' ? '我的课程' : view === 'graph' ? '课程依赖图' : '课程列表'}</h2><span className="count-badge">{view === 'graph' ? graphCourses.length : filteredCourses.length}</span>{focusId ? <button className="focus-chip" onClick={resetScope}>关联视图 <X size={12} /></button> : null}</div><div className="view-toggle" aria-label="切换视图"><button className={view === 'graph' ? 'active' : ''} aria-label="依赖图视图" aria-pressed={view === 'graph'} onClick={() => setView('graph')}><GitBranch size={15} /><span>依赖图</span></button><button className={view === 'list' ? 'active' : ''} aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={16} /><span>列表</span></button></div></div>
              {tab === 'courses' ? <div className="filter-row"><div className="level-filters"><span>级别</span>{[0, 100, 200, 300, 400].map(value => <button key={value} className={level === value ? 'active' : ''} onClick={() => { setLevel(value); resetScope() }}>{value || '全部'}</button>)}</div><label className="hide-completed"><input type="checkbox" checked={hideCompleted} onChange={event => { setHideCompleted(event.target.checked); resetScope() }} />隐藏已完成</label><select className="mobile-subject-select" aria-label="选择学科" value={subject} onChange={event => { setSubject(event.target.value); setQuery(''); resetScope() }}><option value="">全部学科</option>{subjects.map(([code]) => <option key={code}>{code}</option>)}</select></div> : null}
              {displayedCourses.length ? view === 'graph' ? <Suspense fallback={<div className="graph-loading"><LoaderCircle className="spinning" size={22} /> 正在准备课程图…</div>}><CourseGraph courses={graphCourses} selectedId={selectedId} relatedIds={relatedIds} statuses={statuses} records={records} onSelect={onSelect} onClear={clearSelection} relations={relations} onExpand={() => { if (selectedId) onExpand(selectedId); else { setExpandDependencies(true); setLimit(value => value + 60) } }} /></Suspense> : <div className="course-list" aria-label="课程列表"><div className="list-column-headings"><span>课程 / COURSE</span><span>学分</span><span>修读 / 条件</span></div>{visibleCourses.map(course => <button className={`course-list-row ${selectedId === course.id ? 'active' : ''}`} key={course.id} onClick={() => onSelect(course.id)} aria-label={`查看 ${course.code} ${course.title}`}><span><strong>{course.code}</strong><small>{course.title}</small></span><span>{course.credits.toFixed(1)}</span><StatusBadge status={records.get(course.id) ?? statuses.get(course.id) ?? 'unknown'} /><ArrowRight size={15} /></button>)}</div> : <div className="empty-state"><Search size={30} strokeWidth={1.5} /><h3>{tab === 'profile' ? '让学习计划从这里开始' : '没有找到匹配的课程'}</h3><p>{tab === 'profile' ? '在任意课程详情中设置修读状态，它就会出现在这里。' : '试试其他代码、英文名称，或调整当前筛选。'}</p><button className="secondary-button" onClick={() => { changeTab('courses'); setSubject(''); setLevel(0); setHideCompleted(false); resetScope() }}>浏览全部课程 <ArrowRight size={14} /></button></div>}
              {view === 'list' && filteredCourses.length > limit ? <div className="progressive-notice"><span>当前列表显示 {visibleCourses.length} / {filteredCourses.length} 门课程；搜索可访问全目录。</span><button onClick={() => setLimit(value => value + 60)}>显示更多 <ArrowDown size={13} /></button></div> : null}
              {view === 'graph' ? <div className="graph-legend"><div>{([['prerequisite', '先修'], ['corequisite', '并修'], ['exclusion', '排除'], ['recommended', '建议准备']] as [Relation, string][]).map(([value, label]) => <button key={value} className={`legend-item legend-${value} ${relations.includes(value) ? '' : 'disabled'}`} aria-pressed={relations.includes(value)} onClick={() => setRelations(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])}><i />{label}</button>)}</div><span>点选课程以展开关联路径 · 连线不是无条件解锁</span></div> : null}
            </>}
          </main>
          {selectedCourse ? <CourseDetails key={selectedCourse.id} course={selectedCourse} courses={catalog.courses} profile={profile} onClose={clearSelection} onRecord={onRecord} onSelect={onSelect} onExpand={onExpand} /> : null}
        </div>
        <footer className="workspace-footer"><span><ShieldCheck size={12} /> 本机保存 · 无需账号</span><p>独立规划工具 · 数据源自 UTM Calendar · 课程收录不代表当期开课或保证注册</p><a href="https://utm.calendar.utoronto.ca/" target="_blank" rel="noreferrer">Official Calendar <ArrowUpRight size={12} /></a></footer>
      </div>
    </div>
    {showProfile ? <ProfileDialog profile={profile} programs={catalog.programs} courses={catalog.courses} onChange={changeProfile} onClose={() => setShowProfile(false)} /> : null}
    {showData ? <DataDialog catalog={catalog} onClose={() => setShowData(false)} /> : null}
  </div>
}

function DataDialog({ catalog, onClose }: { catalog: Catalog; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="profile-dialog data-dialog" onCancel={onClose} aria-labelledby="data-title"><div className="dialog-title"><div><span className="eyebrow">A SINGLE CURRENT SNAPSHOT</span><h2 id="data-title">关于这份 Calendar</h2></div><button className="icon-button" aria-label="关闭数据说明" onClick={onClose}><X size={20} /></button></div><div className="data-status"><Database size={25} /><div><b>{catalog.metadata.academicYear}</b><span>University of Toronto Mississauga</span></div>{catalog.metadata.complete ? <Check size={20} /> : null}</div><dl className="data-metadata"><div><dt>课程 / 专业与方向</dt><dd>{catalog.courses.length.toLocaleString()} / {catalog.programs.length}</dd></div><div><dt>采集时间</dt><dd>{new Date(catalog.metadata.fetchedAt).toLocaleString('zh-CN', { timeZone: 'America/Toronto' })}（多伦多）</dd></div><div><dt>解析器版本</dt><dd>{catalog.metadata.parserVersion}</dd></div><div><dt>维护方式</dt><dd>单一当前快照 · 每年手动更新</dd></div></dl><p className="muted small-text">所有规则保留英文原文与来源。无法可靠解析的条款显示“需人工确认”。当前仅提供 UTM；规则检查不替代官方学业指导或注册资格审查。</p><div className="data-links"><a href={`${import.meta.env.BASE_URL}data/quality-report.json`} target="_blank" rel="noreferrer">查看完整性与解析质量报告 <ExternalLink size={14} /></a><a href={catalog.metadata.academicYearSource} target="_blank" rel="noreferrer">查看 academic year 官方来源 <ExternalLink size={14} /></a>{catalog.metadata.sources.map(source => <a href={source} key={source} target="_blank" rel="noreferrer">{source.includes('program') ? 'Programs 官方目录' : 'Courses 官方目录'} <ExternalLink size={14} /></a>)}</div><button className="primary-button" onClick={onClose}>了解了</button></dialog>
}

export default App
