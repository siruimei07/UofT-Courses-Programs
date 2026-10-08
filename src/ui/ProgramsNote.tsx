// "Loading programs…" or "Programs unavailable — retry" while programs.json is not usable: in the
// search list and in the program context strip of a hash program that is still waiting for it.
import type { ProgramsStatus } from '../app/usePrograms'
import { useStrings } from '../i18n'
import { programLoadStrings } from './strings'

interface ProgramsNoteProps {
  status: Exclude<ProgramsStatus, 'ready'>
  className?: string
  onRetry(): void
}

export function ProgramsNote({ status, className, onRetry }: ProgramsNoteProps) {
  const t = useStrings(programLoadStrings)
  if (status !== 'error') return <span className={className} role="status">{t.loading}</span>
  return (
    <span className={className} role="status">
      {t.unavailable}{' '}
      <button type="button" className="link-button link-inline" title={t.retryTitle} onClick={onRetry}>{t.retry}</button>
    </span>
  )
}
