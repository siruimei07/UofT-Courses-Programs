// Segmented control (design-spec 6.2): a radiogroup with a roving tab stop. Arrow keys move and
// select; disabled segments (planned campuses) stay focusable by pointer only and explain why.
import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when the label is an icon. */
  ariaLabel?: string
  title?: string
  disabled?: boolean
  /** Official English text inside a zh UI. */
  lang?: string
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange(value: T): void
  className?: string
}

export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step || !enabled.length) return
    event.preventDefault()
    const at = Math.max(0, enabled.findIndex(({ option }) => option.value === value))
    const next = enabled[(at + step + enabled.length) % enabled.length]
    onChange(next.option.value)
    refs.current[next.index]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={`seg ${className ?? ''}`} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={element => { refs.current[index] = element }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            aria-label={option.ariaLabel}
            title={option.title}
            lang={option.lang}
            tabIndex={checked ? 0 : -1}
            className="seg-item"
            onClick={() => { if (!option.disabled && !checked) onChange(option.value) }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
