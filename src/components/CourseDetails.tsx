import { ArrowRight, BookOpen, ExternalLink, Link2, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { evaluateEligibility, getPossibleUnlocks } from '../domain'
import type { Course, Requirement, StudentCourse, StudentProfile } from '../domain/types'
import { StatusBadge, recordText } from './StatusBadge'

interface Props {
  course: Course
  courses: Course[]
  profile: StudentProfile
  onClose: () => void
  onRecord: (courseId: string, status?: StudentCourse['status'], grade?: number) => void
  onSelect: (id: string) => void
  onExpand: (id: string) => void
}

function RequirementSection({ name, requirement, onSelect, courseMap }: { name: string; requirement: Requirement; onSelect: (id: string) => void; courseMap: Map<string, Course> }) {
  if (!requirement.rawText) return null
  return <details className="requirement-block" open={name === 'Prerequisite'}>
    <summary>{name}<span>{requirement.rule.kind === 'unknown' ? '需确认' : '官方原文'}</span></summary>
    <p className="original-text">{requirement.rawText}</p>
    <div className="inline-courses">{requirement.courseIds.map(id => courseMap.has(id) ? <button key={id} onClick={() => onSelect(id)}>{courseMap.get(id)!.code}<ArrowRight size={11} /></button> : <span key={id} className="external-course">{id.split(':').at(-1)} · 目录外</span>)}</div>
  </details>
}

export function CourseDetails({ course, courses, profile, onClose, onRecord, onSelect, onExpand }: Props) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [course.id])
  const evaluation = useMemo(() => evaluateEligibility(course, profile, courses), [course, profile, courses])
  const unlocks = useMemo(() => getPossibleUnlocks(course.id, courses, profile), [course.id, courses, profile])
  const courseMap = useMemo(() => new Map(courses.map(item => [item.id, item])), [courses])
  const record = profile.courses.find(item => item.courseId === course.id)
  const later = [...new Set([...unlocks.newlyEligible, ...unlocks.potential])]
  return <aside className="course-inspector" aria-label="课程详情">
    <div className="inspector-top"><span><BookOpen size={15} /> COURSE DETAILS</span><button className="icon-button" aria-label="关闭课程详情" onClick={onClose}><X size={18} /></button></div>
    <div className="inspector-scroll">
      <div className="course-eyebrow">{course.campus} <span> / </span> {course.subject}</div>
      <h2 ref={heading} tabIndex={-1} className="course-code">{course.code}</h2>
      <h3 className="course-name">{course.title}</h3>
      <div className="course-facts"><span>{course.credits.toFixed(1)} 学分</span><span>{course.level} 级</span>{record ? <StatusBadge status={record.status} /> : null}</div>
      <a href={course.sourceUrl} target="_blank" rel="noreferrer" className="text-link">查看官方 Calendar <ExternalLink size={13} /></a>
      <div className="record-card">
        <label htmlFor="course-status">我的修读状态</label>
        <select id="course-status" value={record?.status ?? ''} onChange={event => onRecord(course.id, event.target.value as StudentCourse['status'] || undefined, record?.grade)}>
          <option value="">未添加到档案</option>
          {Object.entries(recordText).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
        {record?.status === 'completed' ? <label className="grade-label">成绩（% · 可选）<input aria-label="课程成绩" type="number" min="0" max="100" value={record.grade ?? ''} placeholder="未填写" onChange={event => { const grade = event.target.value === '' ? undefined : Number(event.target.value); if (grade === undefined || grade >= 0 && grade <= 100) onRecord(course.id, 'completed', grade) }} /></label> : null}
        <small>仅保存在此浏览器 · 计划修读不算已通过</small><small>已完成表示已通过；低于 50% 的成绩不会计为通过。</small>
      </div>
      <section className={`eligibility-card eligibility-${evaluation.status}`}>
        <div className="section-heading">规则检查 <StatusBadge status={evaluation.status} /></div>
        <ul>{evaluation.reasons.slice(0, 6).map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        {evaluation.missing.length ? <details><summary>缺失或待确认项（{evaluation.missing.length}）</summary><ul>{evaluation.missing.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details> : null}
      </section>
      <section className="inspector-section"><h4>关于这门课</h4><p className="description">{course.description || '请参阅官方 Calendar 的课程说明。'}</p></section>
      <section className="inspector-section"><h4>修读要求 <span>保留官方原文</span></h4>
        <RequirementSection name="Prerequisite" requirement={course.prerequisites} courseMap={courseMap} onSelect={onSelect} />
        <RequirementSection name="Corequisite" requirement={course.corequisites} courseMap={courseMap} onSelect={onSelect} />
        <RequirementSection name="Exclusion" requirement={course.exclusions} courseMap={courseMap} onSelect={onSelect} />
        <RequirementSection name="Recommended preparation" requirement={course.recommended} courseMap={courseMap} onSelect={onSelect} />
        <RequirementSection name="Restrictions" requirement={course.restrictions} courseMap={courseMap} onSelect={onSelect} />
        {!course.prerequisites.rawText ? <p className="muted small-text">Calendar 未列出 prerequisite；其他条件仍需核对。</p> : null}
      </section>
      <section className="inspector-section"><h4>下一步，可能通往 <span>{later.length} 门课</span></h4><p className="muted small-text">假设通过本课程后的条件模拟；成绩与其他要求仍会影响结果。</p>
        <div className="unlock-list">{later.slice(0, 8).map(id => <button key={id} onClick={() => onSelect(id)}><span>{courseMap.get(id)?.code ?? id}<small>{unlocks.newlyEligible.includes(id) ? '假设完成后条件可满足' : '部分条件可能改善'}</small></span><ArrowRight size={14} /></button>)}</div>
        {!later.length ? <p className="muted small-text">暂未发现满足模拟条件的后续课程。</p> : null}
      </section>
      {course.notes ? <details className="requirement-block"><summary>Notes</summary><p className="original-text">{course.notes}</p></details> : null}
      <p className="inspector-footnote">Calendar 收录不代表当学期开课、存在名额或保证注册。最终以官方规定为准。</p>
    </div>
    <button className="inspector-action" onClick={() => onExpand(course.id)}><Link2 size={16} /> 在图中展开关联课程 <ArrowRight size={16} /></button>
  </aside>
}
