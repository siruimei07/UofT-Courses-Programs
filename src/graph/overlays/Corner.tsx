// Corner cell above the lane column (design-spec 9.3): "Subject" and the lane count, or the number
// of lanes holding chain / program courses.
import type { Lang } from '../../app/store'
import { format, formatNumber } from '../../i18n'
import type { GraphStrings } from '../strings'
import type { Counts } from './counts'
import { chainLaneCount } from './counts'

export interface CornerProps {
  counts: readonly Counts[]
  focus: number
  programActive: boolean
  strings: GraphStrings
  lang: Lang
}

export function Corner({ counts, focus, programActive, strings, lang }: CornerProps) {
  const n = (value: number) => formatNumber(value, lang)
  let meta: string
  if (focus >= 0) {
    meta = format(strings.cornerChain, { n: n(chainLaneCount(counts)) })
  } else if (programActive) {
    meta = format(strings.cornerProgram, { n: n(counts.filter(c => c.program > 0).length) })
  } else {
    const visible = counts.filter(c => c.visible > 0).length
    meta = visible < counts.length
      ? format(strings.cornerLanesOf, { v: n(visible), n: n(counts.length) })
      : format(strings.cornerLanes, { n: n(counts.length) })
  }
  return (
    <div className="gc-corner">
      <div className="gc-corner-title">{strings.cornerTitle}</div>
      <div className="gc-corner-meta">{meta}</div>
    </div>
  )
}
