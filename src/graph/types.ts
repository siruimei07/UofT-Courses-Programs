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
  /**
   * Labels of transitive chain nodes: 'all' = full (code + title), 'direct' = compact (code only).
   * Resolved by the app ("chain titles: auto", design-spec 8.2); the Titles toggle forces 'all'.
   */
  chainTitles: 'all' | 'direct'
  /** Titles toggle: overview nodes are `full` instead of `compact`. */
  titles: boolean
}

// ---------------------------------------------------------------------------
// Geometry: where everything is, in world units (CSS px at zoom 1).

export interface GeometryOptions {
  laneHeaderWidth: number
  bandHeaderHeight: number
  /** Top and bottom padding inside a labelled lane. */
  lanePaddingY: number
  laneMinHeight: number
  /** Extra minimum height of the first lane of a division (division label). */
  divisionLabelHeight: number
  /** Lane whose visible nodes are all `mini` while dimming is active. */
  laneSlimHeight: number
  /** Lane whose nodes are all hidden (0 removes the lane). */
  laneCollapsedHeight: number
  bandPadLeft: number
  /** Replaces the last visible column's trailing gap inside a band. */
  bandPadRight: number
  /** Label end → next column's left edge. */
  columnGap: number
  /** Gap after a mini-only column. */
  miniColumnGap: number
  /** Maximum track width per class; measured label widths shrink tracks below this. */
  colWidth: Record<Exclude<DisplayClass, 'hidden'>, number>
  rowHeight: Record<Exclude<DisplayClass, 'hidden'>, number>
  /** Row height of the focus node (plate); grows with wrapped title lines. */
  focusRowHeight: number
  /** Horizontal and vertical pitch of packed mini dots. */
  miniPitch: number
  /** Gap between the last labelled row and the mini grid of a cell. */
  miniGapAbove: number
  miniPerRowMax: number
  /**
   * A cell whose labelled stack is taller than this wraps into balanced, top-aligned tracks inside
   * its column (column-major). Nodes of one column never share an edge, so tracks keep the
   * left-to-right rule intact.
   */
  cellMaxHeight: { full: number; compact: number }
  /** Gap between wrapped tracks of one column (kept < columnGap / 3). */
  trackGap: number
  /** Dot centre from the column's (track's) left edge. */
  dotInset: number
  /** Label start from the column's (track's) left edge. */
  labelX: number
  /** Maximum measured title or code width of a full label. */
  fullLabelMax: number
}

/**
 * Measured label width in world px (design-spec 8.1): compact = code width; full =
 * max(code, truncated title); focus = max(code + credit, wrapped title) + 6. Supplied by the
 * renderer's text module so geometry stays pure.
 */
export type LabelMeasure = (index: number, cls: Exclude<DisplayClass, 'hidden' | 'mini'>, isFocus: boolean) => number

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
  /** Track index inside its cell (0 when the cell does not wrap). */
  track: number
  /** Mini dot that does not fit a slim lane's single row: not drawn, not hit-testable. */
  overflow: boolean
}

export interface ColumnBox {
  x: number
  w: number
  /** Number of wrapped tracks (1 = no wrap) and the width of one track. */
  tracks: number
  trackW: number
  kind: 'labelled' | 'mini' | 'empty'
}

export interface LaneBox {
  y: number
  h: number
  collapsed: boolean
  /** Dimming is active and every visible node of the lane is `mini`. */
  slim: boolean
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

// ---------------------------------------------------------------------------
// Routes: highlighted edges after corridor routing and fan bundling (routes.ts, design-spec 8.8-8.9).

export type PathSegment =
  | { op: 'M' | 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }

export interface RoutedPath {
  /** Index into Topology.edges, or -1 for a bundle trunk. */
  edge: number
  role: EdgeRole
  kind: EdgeKind
  /** 'trunk' and 'branch' come from fan bundling; 'fork' marks an "any of" junction stub. */
  shape: 'edge' | 'trunk' | 'branch' | 'fork'
  segments: PathSegment[]
}

export interface RouteInput {
  /**
   * Groups of the focus's direct prerequisites (node indices) that form one parsed `any` rule;
   * they are drawn through a fork junction. Empty when the rule is unknown or has no `any`.
   */
  anyGroups: number[][]
}

export interface Routes {
  paths: RoutedPath[]
  /** Highlighted edges that could not avoid an obstacle and were drawn as plain curves. */
  fallbacks: number
}
