// Fetches the generated frontend datasets relative to the Vite base path, so the same build
// works at a GitHub Pages subpath. Lazy datasets are cached per campus.
import type { CampusEntry, CampusRegistry, DetailsDataset, GraphDataset, ProgramsDataset } from './schema'

const base = import.meta.env.BASE_URL

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${base}data/${path}`)
  if (!response.ok) throw new Error(`Failed to load ${path}: HTTP ${response.status}`)
  return (await response.json()) as T
}

function dataPath(entry: CampusEntry): string {
  if (entry.status !== 'available' || !entry.dataPath) throw new Error(`${entry.shortName} data is not available yet`)
  return entry.dataPath
}

export function loadRegistry(): Promise<CampusRegistry> {
  return fetchJson<CampusRegistry>('campuses.json')
}

export function loadGraph(entry: CampusEntry): Promise<GraphDataset> {
  return fetchJson<GraphDataset>(`${dataPath(entry)}graph.json`)
}

const details = new Map<string, Promise<DetailsDataset>>()
const programs = new Map<string, Promise<ProgramsDataset>>()

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let promise = cache.get(key)
  if (!promise) {
    promise = load()
    // A failed request may be retried later.
    promise.catch(() => cache.delete(key))
    cache.set(key, promise)
  }
  return promise
}

export function loadDetails(entry: CampusEntry): Promise<DetailsDataset> {
  return cached(details, entry.id, () => fetchJson<DetailsDataset>(`${dataPath(entry)}details.json`))
}

export function loadPrograms(entry: CampusEntry): Promise<ProgramsDataset> {
  return cached(programs, entry.id, () => fetchJson<ProgramsDataset>(`${dataPath(entry)}programs.json`))
}
