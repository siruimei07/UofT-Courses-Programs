// Contracts shared by the graph modules. Pure data; no React, no DOM.
//
//   topology.ts      dataset → Topology            (once per dataset)
//   presentation.ts  Topology + app state → Presentation   (on every state change)
//   geometry.ts      Topology + Presentation → Geometry     (on every presentation change)
//   renderer.ts      draws Topology + Presentation + Geometry on a canvas

export type EdgeKind = 'prereq' | 'coreq'

/** Directed layout edge between node indices: `from` must be taken before (or with) `to`. */
export interface LayoutEdge {
  from: number
  to: number
  kind: EdgeKind
}

export interface TopoNode {
  index: number
  id: string
  code: string
  title: string
  subject: string
  level: number
  lane: number
  band: number
  /** Global column; for every layout edge col(from) < col(to). */
  col: number
  /** Position inside its (lane, col) cell, 0-based, static. */
  order: number
}

/**
 * A reference kept out of the layout: `cycle` breaks a prerequisite loop, `backward` is a
 * reference from a higher-level course to a lower-level one (in the real data always an "or"
 * alternative such as "… or 77% in FSL406H5"). They are never drawn as curves; the details
 * panel lists them.
 */
export interface ExcludedEdge extends LayoutEdge {
  reason: 'cycle' | 'backward'
}

export interface Band {
  index: number
  /** 100, 200, 300, 400 (000-level courses live in the 100 band). Every course sits in the band of its own level. */
  level: number
  startCol: number
  /** Inclusive. */
  endCol: number
  courseCount: number
}

export interface Lane {
  index: number
  /** `${campus}:${subject}` so lanes stay unique once several campuses are loaded. */
  key: string
  subject: string
  name: string
  department: string
  division: string
  /** Node indices in this lane. */
  nodes: number[]
}

export interface Topology {
  nodes: TopoNode[]
  /** Index by course id. */
  indexById: Map<string, number>
  edges: LayoutEdge[]
  /** References kept out of the layout (self-loops are dropped silently). */
  excludedEdges: ExcludedEdge[]
  /** Adjacency over `edges`: predecessors / successors per node index. */
  preds: number[][]
  succs: number[][]
  lanes: Lane[]
  bands: Band[]
  columnCount: number
  /** `cells[lane][col]` = node indices ordered by `order`. */
  cells: number[][][]
}

// ---------------------------------------------------------------------------
// Presentation: what each node/edge means right now.

export type DisplayClass = 'full' | 'compact' | 'mini' | 'hidden'

export type NodeRole =
  | 'focus'
  | 'prereq-direct'
  | 'prereq'
  | 'unlock-direct'
  | 'unlock'
  | 'program'
  | 'none'

export type EdgeRole =
  | 'prereq-direct'
  | 'prereq'
  | 'unlock-direct'
  | 'unlock'
  | 'program'
  | 'faint'
  | 'hidden'

export type RecordStatus = 'completed' | 'inProgress' | 'planned'
export type Eligibility = 'met' | 'unmet' | 'unknown'

export interface Presentation {
  /** Per node index. */
  cls: DisplayClass[]
  role: NodeRole[]
  record: (RecordStatus | null)[]
  /** Eligibility of not-yet-taken courses given the student record (null = no record). */
  eligibility: (Eligibility | null)[]
  inProgram: boolean[]
  /** Per layout edge index (same order as Topology.edges). */
  edgeRole: EdgeRole[]
  /** True when some course or program is focused, i.e. unrelated nodes are greyed. */
  dimming: boolean
}

export interface PresentationInput {
  focusId: string | null
  /** 'direct' limits the chains to immediate prerequisites / unlocks. */
  depth: 'all' | 'direct'
  hideUnrelated: boolean
  hideCompleted: boolean
  showAllEdges: boolean
  /** Visible levels (100/200/300/400); null = all. */
  levels: ReadonlySet<number> | null
  /** Visible subjects; null = all. */
  subjects: ReadonlySet<string> | null
  /** Course ids referenced by the selected program; null = no program. */
  programIds: ReadonlySet<string> | null
  record: ReadonlyMap<string, RecordStatus>
  eligibility: ReadonlyMap<string, Eligibility> | null
}

// ---------------------------------------------------------------------------
// Geometry: where everything is, in world units (CSS px at zoom 1).

export interface GeometryOptions {
  laneHeaderWidth: number
  bandHeaderHeight: number
  lanePaddingY: number
  laneMinHeight: number
  /** Lane height when every node in it is hidden (0 removes the lane). */
  laneCollapsedHeight: number
  columnGap: number
  colWidth: Record<Exclude<DisplayClass, 'hidden'>, number>
  rowHeight: Record<Exclude<DisplayClass, 'hidden'>, number>
  /** Horizontal grid pitch for packed mini dots (vertical pitch is rowHeight.mini). */
  miniPitch: number
  /**
   * A cell taller than this wraps into extra side-by-side tracks inside its column. Nodes of
   * one column never share an edge, so tracks keep the left-to-right rule intact.
   */
  cellMaxHeight: number
  /** Horizontal gap between tracks of one cell. */
  trackGap: number
  /** Horizontal inset of the dot inside its column. */
  dotInset: number
}

export interface NodeBox {
  /** Label box (world units). */
  x: number
  y: number
  w: number
  h: number
  /** Dot centre. */
  cx: number
  cy: number
  cls: DisplayClass
}

export interface ColumnBox {
  x: number
  w: number
}

export interface LaneBox {
  y: number
  h: number
  collapsed: boolean
}

export interface BandBox {
  x: number
  w: number
  visible: boolean
}

export interface Geometry {
  nodes: NodeBox[]
  columns: ColumnBox[]
  lanes: LaneBox[]
  bands: BandBox[]
  /** Full world size including lane header column and band header row. */
  width: number
  height: number
}
