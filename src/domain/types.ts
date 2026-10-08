export type Campus = 'UTM' | 'UTSG' | 'UTSC' | 'external'
export type Status = 'met' | 'unmet' | 'unknown'
export type Rule =
  | { kind: 'true' }
  | { kind: 'all' | 'any'; items: Rule[] }
  | { kind: 'course'; courseId: string }
  | { kind: 'minGrade'; courseId: string; minimum: number }
  | { kind: 'credits'; minimum: number; courseIds?: string[]; subject?: string; level?: number }
  | { kind: 'permission'; text: string }
  | { kind: 'program'; programId: string }
  | { kind: 'unknown'; text: string; reason: string }
  | { kind: 'applicability'; cohort: string; rule: Rule }

export interface Requirement {
  rawText: string
  sourceUrl: string
  rule: Rule
  /** Courses the requirement actually depends on (required or alternatives); these become graph edges. */
  courseIds: string[]
  /** Codes mentioned but ruled out, advisory or conditional ("except ENG100H5"); never edges. */
  mentionedIds?: string[]
  /** Same-campus codes cited but absent from this calendar (retired / misprinted); never edges. */
  unresolvedIds?: string[]
}
export interface Course {
  id: string
  campus: Campus
  code: string
  title: string
  subject: string
  level: number
  credits: number
  description: string
  sourceUrl: string
  contentHash: string
  fetchedAt: string
  prerequisites: Requirement
  corequisites: Requirement
  exclusions: Requirement
  recommended: Requirement
  restrictions: Requirement
  notes: string
  distribution?: string
  /** Delivery location when not the main campus (e.g. "Sheridan"). */
  deliveryCampus?: string
  courseExperience?: string
  internationalComponent?: string
}
export interface ProgramGroup extends Requirement {
  id: string
  label: string
  category: 'admission' | 'completion'
}
export interface Program {
  id: string
  campus: 'UTM'
  code: string
  title: string
  type: string
  description: string
  sourceUrl: string
  contentHash: string
  fetchedAt: string
  admission: Requirement
  completion: Requirement
  groups: ProgramGroup[]
  notes: string
}
export interface Catalog {
  schemaVersion: 1
  metadata: {
    campus: 'UTM'
    academicYear: string
    academicYearSource: string
    fetchedAt: string
    parserVersion: string
    sources: string[]
    complete: boolean
  }
  courses: Course[]
  programs: Program[]
}
export interface StudentCourse {
  courseId: string
  status: 'completed' | 'inProgress' | 'planned'
  grade?: number
}
export interface StudentProfile {
  schemaVersion: 1
  courses: StudentCourse[]
  recordComplete: boolean
  completedCredits?: number
  admittedPrograms: string[]
  cohort?: string
}
export interface Evaluation {
  status: Status
  reasons: string[]
  missing: string[]
}
export interface Recommendation {
  courseId: string
  score: number
  category: 'ready' | 'planning'
  reasons: string[]
  groups: string[]
  eligibility: Evaluation
  possibleUnlocks: string[]
  sourceUrls: string[]
}
