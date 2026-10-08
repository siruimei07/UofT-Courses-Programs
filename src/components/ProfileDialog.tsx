import { useEffect, useRef, useState } from 'react'
import { Download, FileUp, ShieldCheck, Trash2, X } from 'lucide-react'
import { createEmptyProfile, parseStudentProfile } from '../domain'
import type { Course, Program, StudentProfile } from '../domain/types'

export function ProfileDialog({ profile, programs, courses, onChange, onClose }: { profile: StudentProfile; programs: Program[]; courses: Course[]; onChange: (profile: StudentProfile) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  const catalogIds = new Set(courses.map(course => course.id))
  const missingRecords = profile.courses.filter(course => !catalogIds.has(course.courseId))
  const completed = profile.courses.filter(course => course.status === 'completed').length
  function exportProfile() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'utm-student-profile.json'
    link.click()
    URL.revokeObjectURL(url)
  }
  return <dialog ref={dialog} className="profile-dialog" onCancel={onClose} aria-labelledby="profile-title">
    <div className="dialog-title"><div><span className="eyebrow">YOUR LOCAL PROFILE</span><h2 id="profile-title">我的修读档案</h2></div><button className="icon-button" aria-label="关闭档案" onClick={onClose}><X size={20} /></button></div>
    <div className="privacy-note"><ShieldCheck size={20} /><p>你的课程与成绩仅保存在此浏览器。<small>导出文件含个人修读记录，请妥善保管。无需账号，没有数据上传。</small></p></div>
    <div className="profile-stats"><div><strong>{completed}</strong><span>已完成课程</span></div><div><strong>{profile.courses.filter(course => course.status === 'inProgress').length}</strong><span>正在修读</span></div><div><strong>{profile.courses.filter(course => course.status === 'planned').length}</strong><span>计划修读</span></div></div>
    <label className="checkbox-label"><input type="checkbox" checked={profile.recordComplete} onChange={event => onChange({ ...profile, recordComplete: event.target.checked })} /><span>我已录入全部已完成课程<small>未勾选时，缺少记录的条件可能仍需确认。</small></span></label>
    <div className="profile-grid"><label>已获总学分（可选）<input type="number" aria-label="已完成总学分" min="0" max="1000" step="0.5" placeholder="仅填写实际已获学分" value={profile.completedCredits ?? ''} onChange={event => { const value = event.target.value === '' ? undefined : Number(event.target.value); if (value === undefined || value >= 0 && value <= 1000) onChange({ ...profile, completedCredits: value }) }} /></label><label>入学 cohort（可选）<input aria-label="入学 cohort" value={profile.cohort ?? ''} placeholder="例如 2025" maxLength={100} onChange={event => onChange({ ...profile, cohort: event.target.value.trim() || undefined })} /></label></div>
    <label className="field-label">已被录取的专业<select aria-label="添加已录取专业" value="" onChange={event => { if (event.target.value && !profile.admittedPrograms.includes(event.target.value)) onChange({ ...profile, admittedPrograms: [...profile.admittedPrograms, event.target.value] }) }}><option value="">选择已获录取的专业…</option>{programs.map(program => <option key={program.id} value={program.id}>{program.title}</option>)}</select></label>
    <div className="admitted-list">{profile.admittedPrograms.map(id => <button key={id} onClick={() => onChange({ ...profile, admittedPrograms: profile.admittedPrograms.filter(item => item !== id) })}>{programs.find(program => program.id === id)?.title ?? id}<X size={12} /><span className="sr-only">移除</span></button>)}</div>
    {missingRecords.length ? <section className="outside-records"><h3>当前目录以外的记录（{missingRecords.length}）</h3><p>这些记录可能来自其他校区或年度更新前的课程。原始信息仍会保留并导出；无法确定的规则继续待确认。</p>{missingRecords.map(record => <div key={record.courseId}><span>{record.courseId} · {record.status}{record.grade === undefined ? '' : ` · ${record.grade}%`}</span><button onClick={() => onChange({ ...profile, courses: profile.courses.filter(course => course.courseId !== record.courseId) })}>移除</button></div>)}</section> : null}
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    <div className="profile-actions"><button className="secondary-button" onClick={exportProfile}><Download size={15} /> 导出档案</button><button className="secondary-button" onClick={() => upload.current?.click()}><FileUp size={15} /> 导入档案</button><input ref={upload} className="sr-only" aria-label="导入档案文件" type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 2_000_000) throw new Error('档案文件过大，请选择小于 2 MB 的 JSON 文件。'); const parsed = parseStudentProfile(await file.text()); onChange(parsed); setError(''); setConfirmClear(false) } catch (error) { setError(error instanceof Error ? error.message : '无法读取档案') } event.target.value = '' }} /></div>
    <div className="dialog-bottom">{confirmClear ? <div className="clear-confirm"><span>清除所有本机修读记录？</span><button className="danger-button" onClick={() => { onChange(createEmptyProfile()); setConfirmClear(false) }}>确认清除</button><button className="text-button" onClick={() => setConfirmClear(false)}>取消</button></div> : <button className="text-button danger-text" onClick={() => setConfirmClear(true)}><Trash2 size={14} /> 清除本机档案</button>}<button className="primary-button" onClick={onClose}>完成</button></div>
  </dialog>
}
