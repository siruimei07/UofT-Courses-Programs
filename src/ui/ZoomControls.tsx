// Zoom group (design-spec 6.4 item 5): − · value · + · Fit width. The value resets to 100 %.
import { useSyncExternalStore } from 'react'
import { useApp, type Store } from '../app/store'
import { formatNumber, useStrings } from '../i18n'
import { zoomStrings } from './strings'

interface ZoomControlsProps {
  zoom: Store<{ zoom: number }>
  onZoomIn(): void
  onZoomOut(): void
  onReset(): void
  onFit(): void
}

export function ZoomControls({ zoom: source, onZoomIn, onZoomOut, onReset, onFit }: ZoomControlsProps) {
  const zoom = useSyncExternalStore(source.subscribe, () => source.get().zoom)
  const t = useStrings(zoomStrings)
  const lang = useApp(state => state.lang)
  const percent = `${formatNumber(Math.round(zoom * 100), lang)}%`
  return (
    <div className="zoom" role="group" aria-label={t.group}>
      <button type="button" className="btn btn-zoom" aria-label={t.zoomOut} title={t.zoomOut} aria-keyshortcuts="-" onClick={onZoomOut}>−</button>
      <button type="button" className="btn btn-zoom zoom-value" title={t.reset} aria-label={`${percent}, ${t.reset}`} aria-keyshortcuts="1" onClick={onReset}>
        {percent}
      </button>
      <button type="button" className="btn btn-zoom" aria-label={t.zoomIn} title={t.zoomIn} aria-keyshortcuts="+" onClick={onZoomIn}>+</button>
      <button type="button" className="btn btn-zoom btn-fit" title={t.fitTitle} aria-keyshortcuts="0" onClick={onFit}>{t.fit}</button>
    </div>
  )
}
