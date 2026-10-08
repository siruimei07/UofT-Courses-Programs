import { useMemo, useState } from 'react'
import { ArrowRight, ArrowUpRight, CheckCircle2, ClipboardList, Compass, ExternalLink, GraduationCap } from 'lucide-react'
import { evaluateProgram, recommendCourses } from '../domain'
import type { Catalog, Program, StudentProfile } from '../domain/types'
import { StatusBadge } from './StatusBadge'

export function ProgramPanel({ program, catalog, profile, onSelectCourse, onProfile }: { program: Program | undefined; catalog: Catalog; profile: StudentProfile; onSelectCourse: (id: string) => void; onProfile: () => void }) {
  const [limit, setLimit] = useState(12)
  const [category, setCategory] = useState<'all' | 'ready' | 'planning'>('all')
  const evaluation = useMemo(() => program ? evaluateProgram(program, profile, catalog.courses) : undefined, [program, profile, catalog.courses])
  const recommendations = useMemo(() => program ? recommendCourses(program, catalog, profile) : [], [program, catalog, profile])
  const courseMap = useMemo(() => new Map(catalog.courses.map(course => [course.id, course])), [catalog.courses])
  if (!program || !evaluation) return <div className="program-empty"><div className="empty-illustration"><GraduationCap size={38} strokeWidth={1.4} /></div><span className="eyebrow">BUILD YOUR PATH</span><h2>从一个感兴趣的专业开始</h2><p>在左侧选择 Specialist、Major 或 Minor，查看官方入学与完成要求，以及与你的修读记录相关的课程建议。</p><div className="empty-steps"><span>01 <b>选择专业</b></span><ArrowRight size={16} /><span>02 <b>记录已修课程</b></span><ArrowRight size={16} /><span>03 <b>探索下一步</b></span></div></div>
  const suspended = /admissions?[\s\S]{0,160}suspended/i.test([program.description, program.admission.rawText, program.notes].join(' '))
  const visible = recommendations.filter(item => category === 'all' || item.category === category)
  return <div className="program-panel">
    <header className="program-heading"><div className="program-symbol"><GraduationCap size={25} /></div><div><span className="eyebrow">{program.type} · {program.code}</span><h2>{program.title}</h2><a className="text-link" href={program.sourceUrl} target="_blank" rel="noreferrer">官方专业要求 <ExternalLink size={13} /></a></div></header>
    {suspended ? <div className="suspended-note"><strong>暂停新生录取</strong><p>官方页面标明 admission suspended。下方建议仅作为已在读学生的规划参考；请核对原文与恢复录取公告。</p></div> : null}
    <div className="program-summary"><div><ClipboardList size={18} /><span>入学要求<StatusBadge status={evaluation.admission.status} /></span></div><div><CheckCircle2 size={18} /><span>完成要求<StatusBadge status={evaluation.completion.status} /></span></div><button className="text-button" onClick={onProfile}>完善我的档案 <ArrowUpRight size={14} /></button></div>
    <p className="program-caution">专业要求可能依入学 cohort、成绩、选课分配或许可而变化。建议是可解释的规划线索；未解析条款始终保留待确认状态。</p>
    <div className="program-requirements">
      <details><summary>Admission requirements <span>入学要求 · 官方原文</span></summary><p className="original-text">{program.admission.rawText || '详情请参阅官方专业页面。'}</p><ul>{evaluation.admission.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>
      <details><summary>Completion requirements <span>完成要求 · 官方原文</span></summary><p className="original-text">{program.completion.rawText || '详情请参阅官方专业页面。'}</p><ul>{evaluation.completion.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>
      {evaluation.groups.length ? <details><summary>要求分组 <span>{evaluation.groups.length} 组</span></summary>{evaluation.groups.map(group => <div key={group.id} className="program-group"><div><b>{group.label}</b><StatusBadge status={group.evaluation.status} /></div><p>{group.evaluation.reasons.join('；')}</p></div>)}</details> : null}
    </div>
    <div className="recommendation-heading"><div><span className="eyebrow">YOUR NEXT POSSIBILITIES</span><h3><Compass size={20} /> 值得考虑的下一门课 <span>{recommendations.length}</span></h3></div></div>
    <div className="recommendation-filters">{([['all', '全部建议'], ['ready', '条件已满足'], ['planning', '规划与待确认']] as const).map(([value, label]) => <button key={value} className={category === value ? 'active' : ''} onClick={() => { setCategory(value); setLimit(12) }}>{label}<span>{value === 'all' ? recommendations.length : recommendations.filter(item => item.category === value).length}</span></button>)}</div>
    <div className="recommendation-grid">{visible.slice(0, limit).map(item => { const course = courseMap.get(item.courseId); if (!course) return null; return <article key={item.courseId} className="recommendation-card"><div><strong>{course.code}</strong><StatusBadge status={item.eligibility.status} /></div><h4>{course.title}</h4><ul>{item.reasons.slice(0, 3).map((reason, index) => <li key={index}>{reason}</li>)}</ul>{item.eligibility.missing.length ? <details><summary>{item.eligibility.missing.length} 项缺失 / 待确认</summary><ul>{item.eligibility.missing.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details> : null}<footer><span>{course.credits.toFixed(1)} 学分 · {item.possibleUnlocks.length} 个潜在后续</span><button onClick={() => onSelectCourse(course.id)} aria-label={`查看 ${course.code}`}>查看课程 <ArrowRight size={14} /></button></footer></article> })}</div>
    {!visible.length ? <div className="inline-empty">当前分类暂无建议。可完善修读档案，或查看其他分类与官方要求。</div> : null}
    {visible.length > limit ? <button className="secondary-button load-more" onClick={() => setLimit(value => value + 24)}>再显示 24 项建议</button> : null}
  </div>
}
