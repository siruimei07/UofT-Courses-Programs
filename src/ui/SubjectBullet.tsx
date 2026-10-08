// Subject-code bullet in the lane's division tone (design-spec 7.7, owner decision 19.8). A
// subject's tone is the graph core's `laneTone` (alternating inside its division in static lane
// order), so search, the subject picker, the start strip and the lane column always agree and no
// filter ever recolours a subject.
import type { CSSProperties } from 'react'
import { laneBulletInkVar, laneDivision, laneToneVar } from '../graph/tokens'
import { laneTone } from '../graph/topology'
import type { Topology } from '../graph/types'

export interface SubjectTone {
  division: string
  tone: 1 | 2
}

export function subjectTones(topology: Topology): Map<string, SubjectTone> {
  const tones = new Map<string, SubjectTone>()
  for (const lane of topology.lanes) {
    tones.set(lane.subject, { division: laneDivision(lane.division), tone: laneTone(topology, lane.index) })
  }
  return tones
}

const FALLBACK: SubjectTone = { division: laneDivision(''), tone: 1 }

export function toneStyle(tone: SubjectTone | undefined): CSSProperties {
  const { division, tone: n } = tone ?? FALLBACK
  return { background: laneToneVar(division, n), color: laneBulletInkVar(n) }
}

export function divisionBar(division: string): string {
  return laneToneVar(division, 1)
}

export function SubjectBullet({ code, tone }: { code: string; tone: SubjectTone | undefined }) {
  return <span className="bullet" style={toneStyle(tone)} lang="en">{code}</span>
}
