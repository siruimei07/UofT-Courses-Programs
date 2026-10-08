import type { StudentCourse, StudentProfile } from './types'

export const PROFILE_STORAGE_KEY = 'utm-course-planner:profile:v1'

export function createEmptyProfile(): StudentProfile {
  return { schemaVersion: 1, courses: [], recordComplete: false, admittedPrograms: [] }
}

/** Use createEmptyProfile() when a mutable value is needed. */
export const EMPTY_PROFILE: StudentProfile = Object.freeze({
  schemaVersion: 1 as const,
  courses: Object.freeze([]) as unknown as StudentCourse[],
  recordComplete: false,
  admittedPrograms: Object.freeze([]) as unknown as string[],
})

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('档案必须是一个 JSON 对象。')
  }
  return value as Record<string, unknown>
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(value)) {
    throw new Error(`${label}格式无效。`)
  }
  return value
}

function number(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${label}必须是 0 至 ${max} 之间的有限数值。`)
  }
  return value
}

/** Validate and copy all imported values; unknown properties are never retained. */
export function parseStudentProfile(value: string | unknown): StudentProfile {
  let input: unknown = value
  if (typeof value === 'string') {
    if (value.length > 2_000_000) throw new Error('档案过大，请导入小于 2 MB 的 JSON 文件。')
    try { input = JSON.parse(value) } catch { throw new Error('无法解析档案，请选择有效的 JSON 文件。') }
  }
  const data = object(input)
  if (data.schemaVersion !== 1) throw new Error('不支持此档案版本；当前只接受 schemaVersion 1。')
  if (typeof data.recordComplete !== 'boolean') throw new Error('档案需要明确的 recordComplete 标记。')
  if (!Array.isArray(data.courses) || data.courses.length > 10_000) throw new Error('courses 必须是最多 10000 条记录的数组。')
  if (!Array.isArray(data.admittedPrograms) || data.admittedPrograms.length > 100) throw new Error('admittedPrograms 必须是最多 100 项的数组。')
  const seen = new Set<string>()
  const courses: StudentCourse[] = data.courses.map((entry: unknown) => {
    const row = object(entry)
    const courseId = identifier(row.courseId, '课程 ID')
    if (!/^(UTM|UTSG|UTSC|external):[^:]+$/.test(courseId)) throw new Error(`课程 ${courseId} 缺少有效校区前缀。`)
    if (seen.has(courseId)) throw new Error(`课程 ${courseId} 重复，请先合并记录。`)
    seen.add(courseId)
    if (!['completed', 'inProgress', 'planned'].includes(String(row.status))) throw new Error(`课程 ${courseId} 的状态无效。`)
    const result: StudentCourse = { courseId, status: row.status as StudentCourse['status'] }
    if (row.grade !== undefined) result.grade = number(row.grade, `${courseId} 成绩`, 100)
    return result
  })
  const result: StudentProfile = {
    schemaVersion: 1,
    courses,
    recordComplete: data.recordComplete,
    admittedPrograms: [...new Set(data.admittedPrograms.map((entry: unknown) => identifier(entry, '专业 ID')))],
  }
  if (data.completedCredits !== undefined) result.completedCredits = number(data.completedCredits, '已完成学分', 1000)
  if (data.cohort !== undefined) {
    if (typeof data.cohort !== 'string' || !data.cohort.trim() || data.cohort.length > 160) throw new Error('cohort 必须是 1 至 160 个字符的文本。')
    result.cohort = data.cohort.trim()
  }
  return result
}

export function serializeStudentProfile(profile: StudentProfile): string {
  return JSON.stringify(parseStudentProfile(profile), null, 2)
}
