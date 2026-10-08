// Shared environment of the panel components, provided once by RightPanel.
import { createContext, useContext, useEffect, useState } from 'react'
import type { CampusEntry, GraphCourse, GraphDataset } from '../../data/schema'
import type { RecordEntry } from '../../app/store'
import type { Eligibility, Topology } from '../../graph/types'

export interface PanelEnv {
  campus: CampusEntry
  dataset: GraphDataset
  topology: Topology
  courses: ReadonlyMap<string, GraphCourse>
  record: ReadonlyMap<string, RecordEntry>
  /** Eligibility of courses not taken yet; null while the record is empty. */
  eligibility: ReadonlyMap<string, Eligibility> | null
  /** Selects a course and asks the graph to bring it into view. */
  pick(courseId: string): void
}

export const PanelContext = createContext<PanelEnv | null>(null)

export function usePanelEnv(): PanelEnv {
  const env = useContext(PanelContext)
  if (!env) throw new Error('Panel components must be rendered inside RightPanel')
  return env
}

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; retry(): void }

/** Loads a lazy campus dataset (details, programs); `enabled` defers the request until needed. */
export function useCampusData<T>(campus: CampusEntry, load: (campus: CampusEntry) => Promise<T>, enabled = true): Loaded<T> {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: T; failed?: boolean } | null>(null)
  const key = `${campus.id}#${attempt}`
  useEffect(() => {
    if (!enabled) return
    let live = true
    load(campus).then(
      data => { if (live) setResult({ key, data }) },
      () => { if (live) setResult({ key, failed: true }) },
    )
    return () => { live = false }
  }, [campus, load, enabled, key])
  if (!result || result.key !== key) return { status: 'loading' }
  if (result.failed) return { status: 'error', retry: () => setAttempt(n => n + 1) }
  return { status: 'ready', data: result.data as T }
}
