// App header (design-spec 6.2): brand, campus switcher, calendar status, fetch date, search,
// Programs, My courses, language and theme.
import type { ReactNode, Ref } from 'react'
import { academicYearLabel, formatFetchDate } from '../app/format'
import type { buildCourseIndex, buildProgramIndex } from '../app/search'
import { actions, useApp, type Lang, type ThemePref } from '../app/store'
import type { Breakpoint } from '../app/useBreakpoint'
import type { CampusEntry, CampusRegistry, GraphDataset } from '../data/schema'
import { format, formatNumber, useStrings } from '../i18n'
import { CampusSwitcher } from './CampusSwitcher'
import { CloseIcon, MonitorIcon, MoonIcon, ProgramIcon, RecordIcon, SunIcon } from './icons'
import { SearchBox } from './SearchBox'
import { Segmented, type SegmentOption } from './Segmented'
import { headerStrings } from './strings'
import type { SubjectTone } from './SubjectBullet'

export interface HeaderSearchProps {
  courseIndex: ReturnType<typeof buildCourseIndex> | null
  programIndex: ReturnType<typeof buildProgramIndex> | null
  tones: ReadonlyMap<string, SubjectTone>
  inputRef: Ref<HTMLInputElement>
  onWantPrograms(): void
  onPickCourse(id: string): void
  onPickProgram(id: string): void
}

interface HeaderProps {
  breakpoint: Breakpoint
  registry: CampusRegistry | null
  campus: CampusEntry | null
  dataset: GraphDataset | null
  search: HeaderSearchProps
  /** Short title of the active program, when one is selected. */
  programTitle: string | null
}

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" focusable="false">
      <rect width="26" height="26" rx="7" fill="var(--ink)" />
      <path d="M7.5 18.5C13 18.5 13 7.5 18.5 7.5" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="7.5" cy="18.5" r="2.6" fill="var(--pre-soft)" />
      <circle cx="18.5" cy="7.5" r="2.6" fill="var(--unl-soft)" />
    </svg>
  )
}

function HeaderButton({ icon, label, title, badge, onClick }: { icon: ReactNode; label: ReactNode; title: string; badge?: ReactNode; onClick(): void }) {
  return (
    <button type="button" className="hbtn" title={title} onClick={onClick}>
      {icon}
      <span className="hbtn-label">{label}</span>
      {badge}
    </button>
  )
}

export function Header({ breakpoint, registry, campus, dataset, search, programTitle }: HeaderProps) {
  const t = useStrings(headerStrings)
  const lang = useApp(state => state.lang)
  const theme = useApp(state => state.theme)
  const currentCampus = useApp(state => state.campus)
  const recordCount = useApp(state => state.record.size)
  const compact = breakpoint === 'compact' || breakpoint === 'narrow'

  const year = campus?.academicYear ?? dataset?.academicYear ?? ''
  const date = dataset ? formatFetchDate(dataset.fetchedAt, lang) : ''
  const statusTitle = campus && dataset
    ? format(t.statusTooltip, {
      campus: campus.shortName, year: academicYearLabel(year), date,
      courses: formatNumber(campus.courseCount ?? dataset.courses.length, lang),
      programs: formatNumber(campus.programCount ?? 0, lang),
    })
    : undefined

  const themeOptions: SegmentOption<ThemePref>[] = [
    { value: 'system', label: compact ? <MonitorIcon size={15} /> : t.themeSystem, ariaLabel: compact ? t.themeSystem : undefined, title: t.themeSystem },
    { value: 'light', label: compact ? <SunIcon size={15} /> : t.themeLight, ariaLabel: compact ? t.themeLight : undefined, title: t.themeLight },
    { value: 'dark', label: compact ? <MoonIcon size={15} /> : t.themeDark, ariaLabel: compact ? t.themeDark : undefined, title: t.themeDark },
  ]
  const langOptions: SegmentOption<Lang>[] = [
    { value: 'en', label: <span lang="en">EN</span>, ariaLabel: 'English' },
    { value: 'zh', label: <span lang="zh-CN">中文</span>, ariaLabel: '中文' },
  ]

  const home = `#/${currentCampus.toLowerCase()}`

  return (
    <header className="header" aria-label={t.banner}>
      <a className="brand" href={home} aria-label={t.brandHome} onClick={event => {
        event.preventDefault()
        actions.selectCourse(null)
        actions.selectProgram(null)
      }}>
        <BrandMark />
        <span className="wordmark" aria-hidden="true"><b>{t.brandUofT}</b> {t.brandRest}</span>
      </a>
      <CampusSwitcher registry={registry} current={currentCampus} />
      {year && (
        <span className="status-pill" title={statusTitle}>
          <span className="status-dot" aria-hidden="true" />
          {compact ? academicYearLabel(year, true) : format(t.statusCalendar, { year: academicYearLabel(year) })}
        </span>
      )}
      {breakpoint === 'wide' && date && <span className="fetch-date">{format(t.fetched, { date })}</span>}
      <span className="header-spacer" />
      <SearchBox {...search} />
      {programTitle ? (
        <div className="hbtn-group" title={format(t.programActiveTitle, { title: programTitle })}>
          <button type="button" className="hbtn hbtn-program" onClick={() => actions.showPanel('program')}>
            <ProgramIcon />
            <span className="hbtn-label program-name" lang="en">{programTitle}</span>
          </button>
          <button type="button" className="hbtn-clear" aria-label={t.clearProgram} title={t.clearProgram}
            onClick={() => actions.selectProgram(null)}>
            <CloseIcon size={12} />
          </button>
        </div>
      ) : (
        <HeaderButton icon={<ProgramIcon />} label={t.programs} title={t.programsTitle} onClick={() => actions.showPanel('program')} />
      )}
      <HeaderButton
        icon={<RecordIcon />}
        label={t.myCourses}
        title={t.myCoursesTitle}
        badge={recordCount > 0 && (
          <span className="count-badge" aria-label={format(t.myCoursesCount, { n: recordCount })}>{formatNumber(recordCount, lang)}</span>
        )}
        onClick={() => actions.showPanel('record')}
      />
      <Segmented label={t.language} value={lang} options={langOptions} onChange={actions.setLang} />
      <Segmented className={compact ? 'seg-icons' : undefined} label={t.theme} value={theme} options={themeOptions} onChange={actions.setTheme} />
    </header>
  )
}
