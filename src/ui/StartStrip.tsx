// First-visit start strip (design-spec 6.3 item 4): search hint, start-subject chips and a link to
// the full subject picker.
import type { SubjectInfo } from '../data/schema'
import { format, useStrings } from '../i18n'
import { cardStrings } from './strings'
import { toneStyle, type SubjectTone } from './SubjectBullet'

interface StartStripProps {
  subjects: readonly SubjectInfo[]
  tones: ReadonlyMap<string, SubjectTone>
  onJump(subject: string): void
  onAllSubjects(): void
}

export function StartStrip({ subjects, tones, onJump, onAllSubjects }: StartStripProps) {
  const t = useStrings(cardStrings)
  return (
    <div className="start-strip">
      <span className="start-text" title={t.start}>{t.start}</span>
      {subjects.map(subject => (
        <button key={subject.code} type="button" className="chip chip-subject" title={format(t.jumpTo, { name: subject.name })}
          onClick={() => onJump(subject.code)}>
          <span className="chip-swatch" style={{ background: toneStyle(tones.get(subject.code)).background }} aria-hidden="true" />
          <span lang="en">{subject.code}</span>
        </button>
      ))}
      <button type="button" className="link-button" onClick={onAllSubjects}>{t.allSubjects}</button>
    </div>
  )
}
