// Evaluated requirement tree (EvalNode): "All of" / "One of" groups, course chips with record
// glyph and met/unmet/unknown status, minimum grades, credit counts and the text-only leaves.
import type { EvalNode } from '../../domain/engine-types'
import { format, useLang, useStrings } from '../../i18n'
import { CourseChip, StatusIcon } from './CourseChip'
import { usePanelEnv } from './context'
import { codeOf, formatCredits } from './format'
import { panelStrings } from './strings'
import type { Relation } from './summary'

interface TreeProps {
  node: EvalNode
  /** Relation of a referenced course to the selected one (colours its glyph). */
  relationOf?: (courseId: string) => Relation
}

const isChipLeaf = (node: EvalNode) => (node.kind === 'course' || node.kind === 'minGrade') && !!node.courseId

/** Single-item groups say nothing; render their only child. */
function collapse(node: EvalNode): EvalNode {
  const children = node.children ?? []
  if ((node.kind === 'all' || node.kind === 'any') && children.length === 1) return collapse(children[0])
  return node
}

export function RuleTree({ node, relationOf }: TreeProps) {
  return (
    <div className="rp-tree">
      <RuleNode node={collapse(node)} relationOf={relationOf} />
    </div>
  )
}

function RuleNode({ node, relationOf }: TreeProps) {
  const s = useStrings(panelStrings)
  const lang = useLang()
  const { record } = usePanelEnv()
  const status = record.size > 0 ? node.status : null

  switch (node.kind) {
    case 'true':
      return null
    case 'course':
    case 'minGrade':
      if (!node.courseId) return null
      return (
        <CourseChip
          id={node.courseId}
          relation={relationOf?.(node.courseId)}
          status={node.status}
          suffix={node.kind === 'minGrade' && node.minimum !== undefined ? format(s.minGrade, { n: node.minimum }) : undefined}
        />
      )
    case 'credits':
      return (
        <span className="rp-leaf">
          <span className="rp-num">{format(s.creditsLeaf, { n: formatCredits(node.minimum ?? 0, lang) })}</span>
          {node.earned !== undefined ? <span className="rp-leaf-meta">{format(s.creditsEarned, { n: formatCredits(node.earned, lang) })}</span> : null}
          {node.text ? <span className="rp-leaf-meta" lang="en">{node.text}</span> : null}
          {status ? <StatusIcon status={status} /> : null}
        </span>
      )
    case 'permission':
      return (
        <span className="rp-leaf">
          <span className="rp-leaf-label">{s.permission}:</span> <span lang="en">{node.text}</span>
          {status ? <StatusIcon status={status} /> : null}
        </span>
      )
    case 'program':
      return (
        <span className="rp-leaf">
          {format(s.programLeaf, { program: codeOf(node.text ?? '') })}
          {status ? <StatusIcon status={status} /> : null}
        </span>
      )
    case 'unknown':
      return (
        <span className="rp-leaf rp-leaf-unknown">
          <span lang="en">{node.text}</span>
          <span className="rp-leaf-meta">{s.unknownLeaf}</span>
        </span>
      )
    case 'applicability': {
      const child = node.children?.[0]
      return (
        <div className="rp-group">
          <div className="rp-group-head">
            <span>{format(s.appliesTo, { cohort: node.text ?? '' })}</span>
            {status ? <StatusIcon status={status} /> : null}
          </div>
          {child ? (
            <div className="rp-group-body">
              <RuleNode node={collapse(child)} relationOf={relationOf} />
            </div>
          ) : null}
        </div>
      )
    }
    case 'all':
    case 'any': {
      const children = (node.children ?? []).map(collapse).filter(child => child.kind !== 'true')
      const inline = children.every(isChipLeaf)
      return (
        <div className={`rp-group rp-group-${node.kind}`}>
          <div className="rp-group-head">
            <span>{node.kind === 'all' ? s.allOf : s.oneOf}</span>
            {status ? <StatusIcon status={status} /> : null}
          </div>
          <ul className={inline ? 'rp-chips rp-group-body' : 'rp-group-body rp-group-list'}>
            {children.map((child, i) => (
              <li key={`${i}:${child.courseId ?? child.kind}`}>
                <RuleNode node={child} relationOf={relationOf} />
              </li>
            ))}
          </ul>
        </div>
      )
    }
  }
}
