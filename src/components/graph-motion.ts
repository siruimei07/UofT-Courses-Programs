import { useEffect, useRef, useState } from 'react'
import type { GraphNode } from './graph-layout'

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/** Animate coordinates, so edges and handles travel with their cards. A new target
 * starts at the last rendered frame, including rapid successive selections. */
export function useAnimatedNodes(target: GraphNode[], reduced: boolean) {
  const [nodes, setNodes] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const origins = new Map(current.current.map(node => [node.id, node.position]))
    const moving = target.some(node => {
      const origin = origins.get(node.id)
      return origin && (origin.x !== node.position.x || origin.y !== node.position.y)
    })
    // Large catalog changes use a card entrance + viewport transition instead of
    // rebuilding thousands of internal flow nodes on every animation frame.
    const duration = reduced || !moving || target.length > 400 ? 0 : 840
    let start: number | undefined
    let frame: number
    const tick = (time: number) => {
      start ??= time
      const elapsed = time - start
      const next = duration === 0 || elapsed >= duration + 120 ? target : target.map((node, index) => {
        const origin = origins.get(node.id)
        if (!origin) return node
        const delay = node.type === 'course' ? Math.min(index % 7 * 18, 108) : 0
        const progress = Math.max(0, Math.min(1, (elapsed - delay) / duration))
        const eased = 1 - Math.pow(1 - progress, 4)
        return { ...node, position: { x: origin.x + (node.position.x - origin.x) * eased, y: origin.y + (node.position.y - origin.y) * eased } }
      })
      current.current = next
      setNodes(next)
      if (next !== target) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, reduced])
  return nodes
}
