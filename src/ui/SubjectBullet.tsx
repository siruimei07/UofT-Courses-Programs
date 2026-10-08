// Subject-code bullet in the lane's division tone (design-spec 7.7). Lanes alternate tone 1 and
// tone 2 inside their division in static display order, matching the lane bars on the map.
import type { CSSProperties } from 'react'
import type { Topology } from '../graph/types'

const DIVISIONS = new Set(['sciences', 'social-sciences', 'humanities', 'professional', 'interdisciplinary'])

export interface SubjectTone {
  division: string
  tone: 1 | 2
}

export function subjectTones(topology: Topology): Map<string, SubjectTone> {
  const seen = new Map<string, number>()
  const tones = new Map<string, SubjectTone>()
  for (const lane of topology.lanes) {
    const division = DIVISIONS.has(lane.division) ? lane.division : 'interdisciplinary'
    const count = seen.get(division) ?? 0
    seen.set(division, count + 1)
    tones.set(lane.subject, { division, tone: count % 2 === 0 ? 1 : 2 })
  }
  return tones
}

export function toneStyle(tone: SubjectTone | undefined): CSSProperties {
  const { division, tone: n } = tone ?? { division: 'interdisciplinary', tone: 1 }
  return { background: `var(--lane-${division}-${n})`, color: `var(--lane-bullet-ink-${n})` }
}

export function divisionBar(division: string): string {
  return `var(--lane-${DIVISIONS.has(division) ? division : 'interdisciplinary'}-1)`
}

export function SubjectBullet({ code, tone }: { code: string; tone: SubjectTone | undefined }) {
  return <span className="bullet" style={toneStyle(tone)} lang="en">{code}</span>
}
