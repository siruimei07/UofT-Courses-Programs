// Shortcuts help (design-spec 6.9.3, "?"): a two-column table of the keys in 11.3. Closes on Esc,
// an outside click or the close button, and returns focus to where it was.
import { Fragment, useEffect, useRef } from 'react'
import { useStrings } from '../i18n'
import { CloseIcon } from './icons'
import { commonStrings, shortcutStrings } from './strings'

type Text = (typeof shortcutStrings)['en']

const GLOBAL: [string[][], keyof Text][] = [
  [[['/'], ['Ctrl', 'K']], 'search'],
  [[['Esc']], 'escape'],
  [[['+'], ['=']], 'zoomIn'],
  [[['-']], 'zoomOut'],
  [[['0']], 'fit'],
  [[['1']], 'reset'],
  [[['F']], 'frame'],
  [[['?']], 'help'],
]

const GRAPH: [string[][], keyof Text][] = [
  [[['←', '↑', '→', '↓']], 'arrows'],
  [[['Enter'], ['Space']], 'select'],
  [[['Shift', '← ↑ → ↓']], 'pan'],
  [[['PageUp'], ['PageDown']], 'page'],
  [[['Home'], ['End']], 'homeEnd'],
  [[['Tab']], 'tab'],
]

function Keys({ combos, or }: { combos: string[][]; or: string }) {
  return (
    <>
      {combos.map((combo, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="keys-or"> {or} </span>}
          {combo.map((key, at) => <Fragment key={key}>{at > 0 && (combo.length > 2 ? ' ' : ' + ')}<kbd>{key}</kbd></Fragment>)}
        </Fragment>
      ))}
    </>
  )
}

export function ShortcutsHelp({ onClose }: { onClose(): void }) {
  const t = useStrings(shortcutStrings)
  const common = useStrings(commonStrings)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      previous?.focus?.()
    }
  }, [onClose])

  const section = (title: string, rows: [string[][], keyof Text][]) => (
    <table className="shortcuts-table">
      <caption>{title}</caption>
      <tbody>
        {rows.map(([combos, key]) => (
          <tr key={key}>
            <th scope="row"><Keys combos={combos} or={t.or} /></th>
            <td>{t[key]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className="popover shortcuts" role="dialog" aria-modal="false" aria-labelledby="shortcuts-title" ref={rootRef}>
      <div className="shortcuts-head">
        <h2 id="shortcuts-title">{t.title}</h2>
        <button ref={closeRef} type="button" className="btn btn-icon" aria-label={common.close} title={common.close} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="shortcuts-body">
        {section(t.global, GLOBAL)}
        {section(t.graph, GRAPH)}
      </div>
    </div>
  )
}
