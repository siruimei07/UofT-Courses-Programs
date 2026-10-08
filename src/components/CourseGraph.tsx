import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, BaseEdge, EdgeText, getSmoothStepPath, Handle, Position, ReactFlow, type Edge, type EdgeProps, type NodeChange, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { Check, Focus, Maximize2, Minus, MoveHorizontal, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import type { Course, Status, StudentCourse } from '../domain/types'
import { recordText, statusText } from './StatusBadge'
import '@xyflow/react/dist/style.css'
import { buildSwimlaneGraph, CARD_HEIGHT, CARD_WIDTH, type GraphNode, type CardNode, type LaneNode, type HeadingNode, type Relation } from './graph-layout'
import { useAnimatedNodes, useReducedMotion } from './graph-motion'
export type { Relation } from './graph-layout'

const CourseCard = memo(function CourseCard({ data }: NodeProps<CardNode>) {
  return <div className={`graph-course ${data.selected ? 'active' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <div className="graph-card-top"><strong>{data.course.code}</strong><span>{data.course.credits.toFixed(1)}</span></div>
    <div className="graph-card-title" title={data.course.title}>{data.course.title}</div>
    <div className="graph-card-bottom"><span className={`node-state status-${data.record ?? data.status}`}>{data.record === 'completed' ? <Check size={11} /> : <i />}{data.record ? recordText[data.record] : statusText[data.status]}</span>{data.hidden > 0 ? <span title="部分先修或并修未在当前图中显示">+{data.hidden} 隐藏</span> : null}</div>
    <Handle type="source" position={Position.Right} />
  </div>
})
const Lane = memo(function Lane({ data }: NodeProps<LaneNode>) { return <div className={`graph-lane lane-${data.index % 3}`}><span className="lane-name"><i />{data.subject}<small>{data.count} COURSES</small></span></div> })
const Heading = memo(function Heading({ data }: NodeProps<HeadingNode>) { return <div className="graph-level">{data.label}</div> })

function roundedRoute(points: number[][]) {
  let path = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const before = Math.hypot(b[0] - a[0], b[1] - a[1])
    const after = Math.hypot(c[0] - b[0], c[1] - b[1])
    if (!before || !after) continue
    const radius = Math.min(14, before / 2, after / 2)
    path += ` L ${b[0] + (a[0] - b[0]) * radius / before} ${b[1] + (a[1] - b[1]) * radius / before} Q ${b[0]} ${b[1]} ${b[0] + (c[0] - b[0]) * radius / after} ${b[1] + (c[1] - b[1]) * radius / after}`
  }
  return `${path} L ${points.at(-1)![0]} ${points.at(-1)![1]}`
}

const PathEdge = memo(function PathEdge({ id, sourceX, sourceY, targetX, targetY, data, style, markerEnd, label }: EdgeProps) {
  const gutter = 24 + Number(data?.sourceColumn ?? 0) % 3 * 6
  const routeY = Number(data?.routeY ?? Math.min(sourceY, targetY) - 85)
  const [simplePath] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition: Position.Right, targetPosition: Position.Left, borderRadius: 18, offset: 24 })
  const path = data?.skip || targetX <= sourceX
    ? roundedRoute([[sourceX, sourceY], [sourceX + gutter, sourceY], [sourceX + gutter, routeY], [targetX - 24, routeY], [targetX - 24, targetY], [targetX, targetY]])
    : simplePath
  return <>
    <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={12} />
    {data?.direct && data?.relation !== 'exclusion' ? <path d={path} pathLength={1} className="graph-flow-trail" style={{ stroke: style?.stroke }} /> : null}
    {label ? <EdgeText x={targetX - 34} y={targetY - 17} label={label} labelStyle={{ fontSize: 10, fill: '#49646a' }} labelBgStyle={{ fill: '#fff', fillOpacity: 0.96 }} labelBgPadding={[5, 3]} labelBgBorderRadius={4} /> : null}
  </>
})
const nodeTypes = { course: CourseCard, lane: Lane, heading: Heading }
const edgeTypes = { pathway: PathEdge }
const DEFAULT_VIEWPORT = { x: 16, y: 72, zoom: 0.78 }

interface Props {
  courses: Course[]
  selectedId: string | null
  relatedIds: Set<string>
  statuses: Map<string, Status>
  records: Map<string, StudentCourse['status']>
  onSelect: (id: string) => void
  onClear: () => void
  onExpand: () => void
  relations: Relation[]
}

export default function CourseGraph({ courses, selectedId, relatedIds, statuses, records, onSelect, onClear, onExpand, relations }: Props) {
  const [instance, setInstance] = useState<ReactFlowInstance<GraphNode, Edge> | null>(null)
  const [ordering, setOrdering] = useState<Map<string, number>>()
  const [busy, setBusy] = useState(false)
  const [layoutError, setLayoutError] = useState('')
  const [size, setSize] = useState({ width: 1200, height: 600 })
  const wrapper = useRef<HTMLDivElement>(null)
  const optimizeRevision = useRef(0)
  const reduced = useReducedMotion()
  const motionDuration = reduced ? 0 : 780
  useEffect(() => {
    const element = wrapper.current
    if (!element) return
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setSize(previous => {
        const width = Math.round(entry.contentRect.width)
        const height = Math.round(entry.contentRect.height)
        return width === previous.width && height === previous.height ? previous : { width, height }
      }))
    })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  useEffect(() => () => { optimizeRevision.current++ }, [courses])
  const graph = useMemo(() => buildSwimlaneGraph(courses, selectedId, relatedIds, statuses, records, relations, ordering, { width: Math.max(0, size.width - 32) / 0.86 }), [courses, selectedId, relatedIds, statuses, records, relations, ordering, size.width])
  const nodes = useAnimatedNodes(graph.nodes, reduced)
  const edges = useMemo(() => graph.edges.map(edge => ({ ...edge, type: 'pathway', animated: false })), [graph.edges])
  const ids = useMemo(() => new Set(courses.map(course => course.id)), [courses])
  const onNodeClick = useCallback((_event: React.MouseEvent, node: GraphNode) => { if (node.type === 'course') onSelect(node.id) }, [onSelect])
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    for (const change of changes) if (change.type === 'select' && change.selected && ids.has(change.id)) onSelect(change.id)
  }, [ids, onSelect])
  const focusNode = graph.nodes.find(node => node.id === selectedId)
  const selection = courses.find(course => course.id === selectedId)
  const viewKey = courses.map(course => course.id).join('|')
  const fitWidth = useCallback((duration = motionDuration) => {
    if (!instance) return
    const zoom = Math.max(0.62, Math.min(0.86, (size.width - 32) / graph.width))
    void instance.setViewport({ x: 16, y: 70, zoom }, { duration })
  }, [instance, size.width, graph.width, motionDuration])
  const focusX = focusNode?.position.x
  const focusY = focusNode?.position.y
  // Status updates leave the user's pan and zoom intact.
  useEffect(() => {
    if (!instance) return
    const zoom = Math.max(0.62, Math.min(0.86, (size.width - 32) / graph.width))
    const x = focusX === undefined ? 16 : Math.min(16, size.width * 0.42 - (focusX + CARD_WIDTH / 2) * zoom)
    const y = focusY === undefined ? 70 : Math.min(70, size.height * 0.4 - (focusY + CARD_HEIGHT / 2) * zoom)
    void instance.setViewport({ x, y, zoom }, { duration: motionDuration })
  }, [instance, viewKey, selectedId, size.width, size.height, graph.width, focusX, focusY, motionDuration])
  async function optimize() {
    const revision = ++optimizeRevision.current
    setBusy(true)
    setLayoutError('')
    try {
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
      const result = await new ELK().layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' }, children: courses.map(course => ({ id: course.id, width: CARD_WIDTH, height: CARD_HEIGHT })), edges: graph.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })) })
      if (revision === optimizeRevision.current) setOrdering(new Map(result.children?.map(node => [node.id, node.y ?? 0])))
    } catch { if (revision === optimizeRevision.current) setLayoutError('自动排列暂不可用，已保留当前布局。') } finally { setBusy(false) }
  }
  return <div ref={wrapper} className={`graph-wrap ${selection ? 'is-focused' : ''} ${reduced ? 'reduced-motion' : ''}`} aria-label="课程依赖图画布" data-course-count={courses.length} data-layout-width={Math.round(graph.width)}>
    <ReactFlow<GraphNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setInstance} onNodeClick={onNodeClick} onNodesChange={onNodesChange} nodesDraggable={false} nodesConnectable={false} elementsSelectable defaultViewport={DEFAULT_VIEWPORT} minZoom={0.01} maxZoom={1.6} onlyRenderVisibleElements deleteKeyCode={null} panOnScroll ariaLabelConfig={{ 'node.a11yDescription.default': '按 Tab 浏览课程，按 Enter 选择。' }}>
      <Background color="#c8dadb" gap={24} size={1} variant={BackgroundVariant.Dots} />
    </ReactFlow>
    <div className="graph-context" aria-live="polite">
      <span className="graph-context-icon"><Sparkles size={16} strokeWidth={1.6} /></span>
      <div><strong>{selection ? `${selection.code} 的课程路径` : '学科全览'}</strong><span>{selection ? `${courses.length} 门关联课程 · 无关课程已隐藏` : `${new Set(courses.map(course => course.subject)).size} 个学科 · ${courses.length.toLocaleString()} 门课程`}</span></div>
      {selection ? <button className="graph-clear" onClick={onClear}><X size={14} />取消选择</button> : null}
    </div>
    {layoutError ? <div role="status" className="graph-layout-error">{layoutError}</div> : null}
    <div className="graph-hint">{selection ? '同级先修横向展开' : '按学科分泳道，按级别分列'} · 拖动 / 滚动平移 · 级别不代表学期</div>
    <div className="graph-toolbar">
      <button className="icon-button" aria-label="缩小" onClick={() => void instance?.zoomOut({ duration: motionDuration })}><Minus size={16} /></button>
      <button className="icon-button" aria-label="放大" onClick={() => void instance?.zoomIn({ duration: motionDuration })}><Plus size={16} /></button>
      <span />
      <button className="icon-button" aria-label="适配宽度" title="适配宽度，保持文字可读" onClick={() => fitWidth()}><MoveHorizontal size={17} /></button>
      <button className="icon-button" aria-label="适配全图" title="适配全图" onClick={() => void instance?.fitView({ padding: 0.12, minZoom: 0.01, duration: motionDuration })}><Maximize2 size={16} /></button>
      <button className="icon-button" aria-label="定位选中课程" title="定位选中课程" disabled={!focusNode} onClick={() => { if (focusNode) void instance?.setCenter(focusNode.position.x + CARD_WIDTH / 2, focusNode.position.y + CARD_HEIGHT / 2, { zoom: 0.86, duration: motionDuration }) }}><Focus size={16} /></button>
      <button className="icon-button" aria-label="重置视图" title="重置视图" onClick={() => fitWidth()}><RotateCcw size={16} /></button>
      <button className="icon-button" aria-label="优化连线排列" title={courses.length > 350 ? '请先选择学科或课程，再优化排列' : '优化连线排列'} disabled={busy || courses.length > 350} onClick={() => void optimize()}><Sparkles size={16} className={busy ? 'spinning' : ''} /></button>
    </div>
    {graph.hiddenCount > 0 ? <button className="hidden-relations" onClick={onExpand}>{graph.hiddenCount} 条先修 / 并修引用位于当前视图外 <span>查看关联范围 →</span></button> : null}
  </div>
}
