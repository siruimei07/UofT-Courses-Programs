// View menu (design-spec 6.4 item 3 and 6.9.3): the map toggles as checkbox items in standard and
// compact frames, with a badge counting the active ones.
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useApp } from '../app/store'
import { format, formatNumber, useStrings } from '../i18n'
import { CheckIcon, ChevronDownIcon } from './icons'
import { toolbarStrings } from './strings'
import type { ToggleSpec } from './Toolbar'
import { usePopover } from './usePopover'

export function ViewMenu({ toggles }: { toggles: readonly ToggleSpec[] }) {
  const t = useStrings(toolbarStrings)
  const lang = useApp(state => state.lang)
  const popover = usePopover()
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const active = toggles.filter(toggle => toggle.pressed).length

  useEffect(() => {
    if (popover.open) items.current.find(item => item && item.getAttribute('aria-disabled') !== 'true')?.focus()
  }, [popover.open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const list = items.current.filter((item): item is HTMLButtonElement => item !== null)
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    list[(at + step + list.length) % list.length]?.focus()
  }

  return (
    <div className="menu-root" ref={popover.rootRef}>
      <button ref={popover.triggerRef} type="button" className="chip chip-menu" aria-haspopup="menu" aria-expanded={popover.open}
        onClick={popover.toggle}>
        {t.view}
        {active > 0 && <span className="chip-badge" aria-label={format(t.viewActive, { n: active })}>{formatNumber(active, lang)}</span>}
        <ChevronDownIcon size={14} />
      </button>
      {popover.open && (
        <div className="popover menu" role="menu" aria-label={t.view} onKeyDown={onKeyDown}>
          {toggles.map((toggle, index) => (
            <button key={toggle.key} ref={element => { items.current[index] = element }} type="button" role="menuitemcheckbox"
              className="menu-item" aria-checked={toggle.pressed} aria-disabled={toggle.disabled || undefined}
              title={toggle.disabled ? toggle.disabledTitle : toggle.title}
              onClick={() => { if (!toggle.disabled) toggle.onToggle() }}>
              <span className="menu-check" aria-hidden="true">{toggle.pressed && <CheckIcon size={13} />}</span>
              {toggle.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
