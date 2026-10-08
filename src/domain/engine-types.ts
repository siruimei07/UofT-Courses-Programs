// Contract between the rule engine (src/domain/engine.ts) and the UI. The engine works on the
// frontend datasets. Record semantics (students plan the coming term):
//   - unmarked courses are not taken (the record is treated as complete);
//   - `completed` satisfies everything (a grade below 50 counts as failed);
//   - `inProgress` counts as passed for prerequisites and corequisites, so "available" means
//     available once current courses are finished (minimum-grade checks stay unknown);
//   - `planned` only satisfies corequisites (taken together), never prerequisites.
import type { GraphDataset, ProgramLite } from '../data/schema'
import type { Eligibility, RecordStatus } from '../graph/types'
import type { Rule } from './types'

export interface RecordEntryLike {
  status: RecordStatus
  grade?: number
}

export type StudentRecord = ReadonlyMap<string, RecordEntryLike>

/** Evaluated rule tree, mirroring the Rule AST so the UI can render AND/OR structure. */
export interface EvalNode {
  kind: Rule['kind']
  status: Eligibility
  /** course / minGrade nodes. */
  courseId?: string
  /** minGrade percentage or credits minimum. */
  minimum?: number
  /** permission / unknown text, applicability cohort, program id. */
  text?: string
  /** credits nodes: credits counted so far. */
  earned?: number
  children?: EvalNode[]
}

export interface ExclusionCheck {
  /**
   * 'blocked' only when a parsed exclusion leaf matches the record; matches found only in
   * unparsed text or among codes absent from this calendar give 'unknown' ("may exclude").
   */
  status: 'clear' | 'blocked' | 'unknown'
  /** Completed or in-progress courses that trigger (or may trigger) the exclusion. */
  blockedBy: string[]
}

export interface CourseEvaluation {
  courseId: string
  /** Prerequisites, corequisites, exclusions and restrictions combined. */
  overall: Eligibility
  /** null when the calendar lists none. */
  prerequisites: EvalNode | null
  corequisites: EvalNode | null
  exclusions: ExclusionCheck | null
  restrictions: EvalNode | null
}

export interface ProgramGroupProgress {
  groupId: string
  status: Eligibility
  /** Referenced course ids that exist in the loaded dataset, in dataset order. */
  courseIds: string[]
  completed: string[]
  inProgress: string[]
  planned: string[]
}

export interface ProgramProgress {
  programId: string
  /** Completion requirements as a whole (often unknown: complex clauses are not auto-judged). */
  completion: Eligibility
  groups: ProgramGroupProgress[]
  /** Union of course ids referenced by the program's groups (for graph highlighting). */
  courseIds: string[]
}

export interface NextCourse {
  courseId: string
  eligibility: Eligibility
  /** Program group ids this course appears in. */
  groups: string[]
  /** How many other program courses list it as a prerequisite. */
  unlocks: number
  reason: 'ready' | 'needs-prerequisites' | 'needs-corequisites' | 'check-requirements'
}

export interface CourseEngine {
  /** Eligibility of every course not completed or in progress. Must handle the whole catalog fast. */
  eligibility(record: StudentRecord): Map<string, Eligibility>
  evaluateCourse(courseId: string, record: StudentRecord): CourseEvaluation
  programProgress(program: ProgramLite, record: StudentRecord): ProgramProgress
  /** Explainable "what to take next" for a program, best first. */
  nextCourses(program: ProgramLite, record: StudentRecord, limit?: number): NextCourse[]
}

export type CreateEngine = (dataset: GraphDataset) => CourseEngine
