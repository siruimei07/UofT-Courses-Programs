// Loads the campus registry, picks the campus to show and loads its graph dataset.
import { useCallback, useEffect, useState } from 'react'
import { loadGraph, loadRegistry } from '../data/load'
import type { CampusEntry, CampusId, CampusRegistry, GraphDataset } from '../data/schema'
import { actions, appStore, useApp } from './store'

export type CampusData =
  | { status: 'loading'; registry: CampusRegistry | null; campus: CampusEntry | null }
  | { status: 'error'; registry: CampusRegistry | null; campus: CampusEntry | null; retry(): void }
  | { status: 'ready'; registry: CampusRegistry; campus: CampusEntry; dataset: GraphDataset }

/** The requested campus when its data is available, otherwise the first available one. */
export function pickCampus(registry: CampusRegistry, wanted: CampusId): CampusEntry | null {
  const available = registry.campuses.filter(entry => entry.status === 'available' && entry.dataPath)
  return available.find(entry => entry.id === wanted) ?? available[0] ?? null
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; dataset: GraphDataset }

export function useCampusData(): CampusData {
  const wanted = useApp(state => state.campus)
  const [registry, setRegistry] = useState<CampusRegistry | null>(null)
  const [registryFailed, setRegistryFailed] = useState(false)
  const [loaded, setLoaded] = useState<{ campus: CampusId; state: Loaded } | null>(null)
  const [registryAttempt, setRegistryAttempt] = useState(0)
  const [graphAttempt, setGraphAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadRegistry().then(
      value => { if (!cancelled) { setRegistry(value); setRegistryFailed(false) } },
      () => { if (!cancelled) setRegistryFailed(true) },
    )
    return () => { cancelled = true }
  }, [registryAttempt])

  const campus = registry ? pickCampus(registry, wanted) : null

  // A hash or stored state may name a campus that is not available yet: fall back visibly.
  useEffect(() => {
    if (campus && campus.id !== appStore.get().campus) appStore.set({ campus: campus.id })
  }, [campus])

  useEffect(() => {
    if (!campus) return
    let cancelled = false
    setLoaded({ campus: campus.id, state: { kind: 'loading' } })
    loadGraph(campus).then(
      dataset => { if (!cancelled) setLoaded({ campus: campus.id, state: { kind: 'ready', dataset } }) },
      () => { if (!cancelled) setLoaded({ campus: campus.id, state: { kind: 'error' } }) },
    )
    return () => { cancelled = true }
  }, [campus, graphAttempt])

  const retry = useCallback(() => {
    if (registryFailed) setRegistryAttempt(value => value + 1)
    else setGraphAttempt(value => value + 1)
  }, [registryFailed])

  if (registryFailed || (registry && !campus)) return { status: 'error', registry, campus, retry }
  if (!registry || !campus || !loaded || loaded.campus !== campus.id) return { status: 'loading', registry, campus }
  if (loaded.state.kind === 'error') return { status: 'error', registry, campus, retry }
  if (loaded.state.kind === 'loading') return { status: 'loading', registry, campus }
  return { status: 'ready', registry, campus, dataset: loaded.state.dataset }
}

/** Selecting a campus segment (only available campuses are selectable). */
export function selectCampus(entry: CampusEntry): void {
  if (entry.status !== 'available') return
  actions.selectCourse(null)
  actions.selectProgram(null)
  appStore.set({ campus: entry.id })
}
