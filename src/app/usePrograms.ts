// programs.json is lazy (2 MB): it loads the first time something needs it (search focus, a
// program in the hash or a stored program home) and is cached per campus by load.ts.
import { useEffect, useState } from 'react'
import { loadPrograms } from '../data/load'
import type { CampusEntry, ProgramsDataset } from '../data/schema'

export function usePrograms(campus: CampusEntry | null, wanted: boolean): ProgramsDataset | null {
  const [loaded, setLoaded] = useState<{ campus: string; data: ProgramsDataset } | null>(null)

  useEffect(() => {
    if (!campus || !wanted || campus.status !== 'available') return
    let cancelled = false
    loadPrograms(campus).then(
      data => { if (!cancelled) setLoaded({ campus: campus.id, data }) },
      () => { /* Search keeps working with courses only; a later request retries. */ },
    )
    return () => { cancelled = true }
  }, [campus, wanted])

  return loaded && campus && loaded.campus === campus.id ? loaded.data : null
}
