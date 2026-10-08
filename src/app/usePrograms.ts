// programs.json is lazy (2 MB): it loads the first time something needs it (search focus or
// typing, a program in the hash or a stored program home) and is cached per campus by load.ts.
// A failed load is kept as an error until something asks again (`retry`, e.g. the next search
// focus), so the UI can say "Programs unavailable" instead of loading forever.
import { useCallback, useEffect, useState } from 'react'
import { loadPrograms } from '../data/load'
import type { CampusEntry, ProgramsDataset } from '../data/schema'

export type ProgramsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Programs {
  data: ProgramsDataset | null
  status: ProgramsStatus
  /** Loads again after an error; does nothing otherwise. */
  retry(): void
}

type Settled = { campus: string; attempt: number } & ({ ok: true; data: ProgramsDataset } | { ok: false })

/** Status of the current request: settled results only count for the same campus and attempt. */
export function programsStatus(wanted: boolean, campus: string | null, attempt: number, settled: Settled | null): ProgramsStatus {
  if (settled && settled.campus === campus && settled.ok) return 'ready'
  if (!wanted || !campus) return 'idle'
  if (settled && settled.campus === campus && settled.attempt === attempt) return 'error'
  return 'loading'
}

export function usePrograms(campus: CampusEntry | null, wanted: boolean): Programs {
  const [settled, setSettled] = useState<Settled | null>(null)
  const [attempt, setAttempt] = useState(0)
  const available = campus?.status === 'available' ? campus : null

  useEffect(() => {
    if (!available || !wanted) return
    let cancelled = false
    const key = { campus: available.id, attempt }
    loadPrograms(available).then(
      data => { if (!cancelled) setSettled({ ...key, ok: true, data }) },
      () => { if (!cancelled) setSettled({ ...key, ok: false }) },
    )
    return () => { cancelled = true }
  }, [available, wanted, attempt])

  const status = programsStatus(wanted, available?.id ?? null, attempt, settled)
  const data = status === 'ready' && settled?.ok ? settled.data : null
  const retry = useCallback(() => {
    if (status === 'error') setAttempt(value => value + 1)
  }, [status])
  return { data, status, retry }
}
