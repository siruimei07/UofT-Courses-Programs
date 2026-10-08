// First-visit start strip (design-spec 6.3 item 4): search hint, up to 6 start-subject chips (each
// carries the subject bullet) and a link to the full subject picker.
import type { SubjectInfo } from '../data/schema'
import { format, useStrings } from '../i18n'
import { cardStrings } from './strings'
import { SubjectBullet, type SubjectTone } from './SubjectBullet'

/** 6.3: up to 6 subject chips. */
export const START_CHIPS = 6

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
      {subjects.slice(0, START_CHIPS).map(subject => (
        <button key={subject.code} type="button" className="chip chip-subject" title={format(t.jumpTo, { name: subject.name })}
          onClick={() => onJump(subject.code)}>
          <SubjectBullet code={subject.code} tone={tones.get(subject.code)} />
        </button>
      ))}
      <button type="button" className="link-button" onClick={onAllSubjects}>{t.allSubjects}</button>
    </div>
  )
}
