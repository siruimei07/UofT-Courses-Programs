// Colours the canvas reads from CSS custom properties (design-spec 3.1). Re-read whenever the
// resolved theme changes, so canvas code never hard-codes the palette. Forced colours (Windows high
// contrast) map everything onto system colours (12).

export interface RenderTokens {
  surface: string
  band: string
  line: string
  ruleStrong: string
  ink: string
  ink2: string
  ink3: string
  focusRing: string
  preInk: string
  unlInk: string
  progWash: string
  selWash: string
  selGlow: string
  selPlate: string
  selPlateInk: string

  nodeDefault: string
  nodeMini: string
  nodeSelectedRing: string
  nodePrereqDirect: string
  nodePrereqTransitive: string
  nodeUnlockDirect: string
  nodeUnlockTransitive: string
  nodeProgram: string
  nodeCompleted: string
  nodeInProgress: string
  nodePlanned: string
  nodeAvailable: string

  edgeFaint: string
  edgeHover: string
  edgePrereqDirect: string
  edgePrereqTransitive: string
  edgeUnlockDirect: string
  edgeUnlockTransitive: string
  edgeProgram: string
  edgeUnrelated: string

  /** Division id → [tone 1, tone 2] (7.7). */
  lanes: Record<string, [string, string]>
  forced: boolean
  dark: boolean
}

const NAMES: Record<Exclude<keyof RenderTokens, 'lanes' | 'forced' | 'dark'>, string> = {
  surface: '--surface',
  band: '--band',
  line: '--line',
  ruleStrong: '--rule-strong',
  ink: '--ink',
  ink2: '--ink-2',
  ink3: '--ink-3',
  focusRing: '--focus-ring',
  preInk: '--pre-ink',
  unlInk: '--unl-ink',
  progWash: '--prog-wash',
  selWash: '--sel-wash',
  selGlow: '--sel-glow',
  selPlate: '--sel-plate',
  selPlateInk: '--sel-plate-ink',
  nodeDefault: '--node-default',
  nodeMini: '--node-mini',
  nodeSelectedRing: '--node-selected-ring',
  nodePrereqDirect: '--node-prereq-direct',
  nodePrereqTransitive: '--node-prereq-transitive',
  nodeUnlockDirect: '--node-unlock-direct',
  nodeUnlockTransitive: '--node-unlock-transitive',
  nodeProgram: '--node-program',
  nodeCompleted: '--node-completed',
  nodeInProgress: '--node-in-progress',
  nodePlanned: '--node-planned',
  nodeAvailable: '--node-available',
  edgeFaint: '--edge-faint',
  edgeHover: '--edge-hover',
  edgePrereqDirect: '--edge-prereq-direct',
  edgePrereqTransitive: '--edge-prereq-transitive',
  edgeUnlockDirect: '--edge-unlock-direct',
  edgeUnlockTransitive: '--edge-unlock-transitive',
  edgeProgram: '--edge-program',
  edgeUnrelated: '--edge-unrelated',
}

export const DIVISIONS = ['sciences', 'social-sciences', 'professional', 'humanities', 'interdisciplinary'] as const
export const FALLBACK_DIVISION = 'interdisciplinary'

/** Division id used for lane tones; unknown divisions use the interdisciplinary family. */
export function laneDivision(division: string): string {
  return (DIVISIONS as readonly string[]).includes(division) ? division : FALLBACK_DIVISION
}

/** CSS variable of a lane tone, for DOM overlays (`var(--lane-sciences-1)`). */
export function laneToneVar(division: string, tone: 1 | 2): string {
  return `var(--lane-${laneDivision(division)}-${tone})`
}

export function laneBulletInkVar(tone: 1 | 2): string {
  return `var(--lane-bullet-ink-${tone})`
}

/** System colours used when the property is missing (never a palette value). */
const MISSING_INK = 'CanvasText'
const MISSING_SURFACE = 'Canvas'
const SURFACE_KEYS = new Set(['surface', 'band', 'selPlateInk'])
const TRANSPARENT_KEYS = new Set(['progWash', 'selWash', 'selGlow'])

/** Forced colours (12): CanvasText for nodes, labels and edges, Highlight for the chain, GrayText for minis. */
export function forcedTokens(base: RenderTokens): RenderTokens {
  const text = 'CanvasText'
  const highlight = 'Highlight'
  const grey = 'GrayText'
  const lanes = Object.fromEntries(DIVISIONS.map(d => [d, [text, text]])) as Record<string, [string, string]>
  return {
    ...base,
    surface: 'Canvas', band: 'Canvas', line: grey, ruleStrong: text, ink: text, ink2: text, ink3: grey,
    focusRing: highlight, preInk: text, unlInk: text, progWash: 'transparent', selWash: 'transparent', selGlow: 'transparent',
    selPlate: highlight, selPlateInk: 'HighlightText',
    nodeDefault: text, nodeMini: grey, nodeSelectedRing: highlight, nodePrereqDirect: highlight, nodePrereqTransitive: highlight,
    nodeUnlockDirect: highlight, nodeUnlockTransitive: highlight, nodeProgram: text, nodeCompleted: text, nodeInProgress: text,
    nodePlanned: text, nodeAvailable: text,
    edgeFaint: grey, edgeHover: text, edgePrereqDirect: highlight, edgePrereqTransitive: highlight, edgeUnlockDirect: highlight,
    edgeUnlockTransitive: highlight, edgeProgram: text, edgeUnrelated: grey,
    lanes,
    forced: true,
  }
}

export function forcedColorsActive(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(forced-colors: active)').matches
}

export function readTokens(theme: 'light' | 'dark', root: HTMLElement = document.documentElement): RenderTokens {
  const style = getComputedStyle(root)
  const read = (name: string) => style.getPropertyValue(name).trim()
  const values = {} as Record<keyof typeof NAMES, string>
  for (const [key, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
    const value = read(name)
    values[key] = value || (TRANSPARENT_KEYS.has(key) ? 'transparent' : SURFACE_KEYS.has(key) ? MISSING_SURFACE : MISSING_INK)
  }
  const lanes: Record<string, [string, string]> = {}
  for (const division of DIVISIONS) {
    lanes[division] = [read(`--lane-${division}-1`) || MISSING_INK, read(`--lane-${division}-2`) || MISSING_INK]
  }
  const tokens: RenderTokens = { ...values, lanes, forced: false, dark: theme === 'dark' }
  return forcedColorsActive() ? forcedTokens(tokens) : tokens
}
