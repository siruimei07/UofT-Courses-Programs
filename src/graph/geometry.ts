// Where everything is for the current display classes, in world units (CSS px at zoom 1).
import type { BandBox, ColumnBox, DisplayClass, Geometry, GeometryOptions, LaneBox, NodeBox, Topology } from './types'

/** Starting values; the design spec tunes them here and nowhere else. */
export const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  laneHeaderWidth: 200,
  bandHeaderHeight: 56,
  lanePaddingY: 10,
  laneMinHeight: 44,
  laneCollapsedHeight: 0,
  columnGap: 12,
  colWidth: { full: 184, compact: 92, mini: 14 },
  rowHeight: { full: 36, compact: 20, mini: 7 },
  miniPitch: 7,
  dotInset: 8,
}

export function computeGeometry(
  topology: Topology,
  cls: readonly DisplayClass[],
  options: Partial<GeometryOptions> = {},
): Geometry {
  const opt: GeometryOptions = { ...DEFAULT_GEOMETRY_OPTIONS, ...options }
  const { columns, width } = layoutColumns(topology, cls, opt)
  const bands = layoutBands(topology, columns, opt)
  const nodes = new Array<NodeBox>(topology.nodes.length)
  const lanes: LaneBox[] = []
  let y = opt.bandHeaderHeight
  for (const lane of topology.lanes) {
    const box = layoutLane(topology.cells[lane.index], y, columns, cls, nodes, opt)
    lanes.push(box)
    y += box.h
  }
  return { nodes, columns, lanes, bands, width, height: y }
}

function layoutColumns(topology: Topology, cls: readonly DisplayClass[], opt: GeometryOptions) {
  const widths = new Array<number>(topology.columnCount).fill(0)
  for (const node of topology.nodes) {
    const c = cls[node.index]
    if (c !== 'hidden') widths[node.col] = Math.max(widths[node.col], opt.colWidth[c])
  }
  let x = opt.laneHeaderWidth
  const columns = widths.map((w): ColumnBox => {
    const box = { x, w }
    // Columns with nothing visible collapse to zero width and take no gap.
    if (w > 0) x += w + opt.columnGap
    return box
  })
  return { columns, width: x }
}

/** A band spans its visible columns plus the trailing gap, so visible bands tile without seams. */
function layoutBands(topology: Topology, columns: readonly ColumnBox[], opt: GeometryOptions): BandBox[] {
  return topology.bands.map(band => {
    let first = -1
    let last = -1
    for (let col = band.startCol; col <= band.endCol; col++) {
      if (columns[col].w === 0) continue
      if (first < 0) first = col
      last = col
    }
    if (first < 0) return { x: columns[band.startCol]?.x ?? opt.laneHeaderWidth, w: 0, visible: false }
    const x = columns[first].x
    return { x, w: columns[last].x + columns[last].w + opt.columnGap - x, visible: true }
  })
}

function layoutLane(
  row: readonly number[][],
  y: number,
  columns: readonly ColumnBox[],
  cls: readonly DisplayClass[],
  nodes: NodeBox[],
  opt: GeometryOptions,
): LaneBox {
  const top = y + opt.lanePaddingY
  let tallest = 0
  let visible = false
  row.forEach((cell, col) => {
    if (!cell.length) return
    tallest = Math.max(tallest, layoutCell(cell, columns[col], top, cls, nodes, opt))
    if (!visible) visible = cell.some(v => cls[v] !== 'hidden')
  })
  if (!visible) return { y, h: opt.laneCollapsedHeight, collapsed: true }
  return { y, h: Math.max(opt.laneMinHeight, tallest + 2 * opt.lanePaddingY), collapsed: false }
}

/**
 * Stacks a cell's nodes in order and returns its height. Full/compact nodes take a whole row;
 * consecutive mini nodes pack into a grid of floor(width / miniPitch) dots per row. Hidden nodes
 * take no space and do not break a mini run.
 */
function layoutCell(
  cell: readonly number[],
  column: ColumnBox,
  top: number,
  cls: readonly DisplayClass[],
  nodes: NodeBox[],
  opt: GeometryOptions,
): number {
  const perRow = Math.max(1, Math.floor(column.w / opt.miniPitch))
  const dotW = Math.min(opt.miniPitch, column.w)
  const miniH = opt.rowHeight.mini
  const inset = Math.min(opt.dotInset, column.w / 2)
  let cursor = top
  let run = 0
  for (const v of cell) {
    const c = cls[v]
    if (c === 'hidden') {
      nodes[v] = { x: column.x, y: cursor, w: 0, h: 0, cx: column.x, cy: cursor, cls: c }
      continue
    }
    if (c === 'mini') {
      const slot = run % perRow
      if (slot === 0) cursor += miniH
      const x = column.x + slot * dotW
      const rowTop = cursor - miniH
      nodes[v] = { x, y: rowTop, w: dotW, h: miniH, cx: x + dotW / 2, cy: rowTop + miniH / 2, cls: c }
      run++
      continue
    }
    run = 0
    const h = opt.rowHeight[c]
    nodes[v] = { x: column.x, y: cursor, w: column.w, h, cx: column.x + inset, cy: cursor + h / 2, cls: c }
    cursor += h
  }
  return cursor - top
}
