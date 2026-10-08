import type { Status, StudentCourse } from '../domain/types'

export const statusText: Record<Status, string> = { met: '条件已满足', unmet: '尚缺条件', unknown: '需人工确认' }
export const recordText: Record<StudentCourse['status'], string> = { completed: '已完成', inProgress: '正在修读', planned: '计划修读' }

export function StatusBadge({ status }: { status: Status | StudentCourse['status'] }) {
  return <span className={`status-badge status-${status}`}><span aria-hidden="true" />{status in statusText ? statusText[status as Status] : recordText[status as StudentCourse['status']]}</span>
}
