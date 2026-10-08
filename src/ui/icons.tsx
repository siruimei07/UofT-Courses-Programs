// Small stroke icons for the chrome. They inherit currentColor and are hidden from assistive tech;
// every button that shows one carries its own text or aria-label.
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  )
}

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}><circle cx="7" cy="7" r="4.5" /><path d="M10.4 10.4 14 14" /></Icon>
)

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}><path d="m4 6 4 4 4-4" /></Icon>
)

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}><path d="m3.5 8.5 3 3 6-7" /></Icon>
)

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></Icon>
)

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" /></Icon>
)

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Icon>
)

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}><path d="M13.2 9.8A5.6 5.6 0 0 1 6.2 2.8a5.6 5.6 0 1 0 7 7Z" /></Icon>
)

/** Stacked layers: a program is a set of courses. */
export const ProgramIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 2.5 14 5.5 8 8.5 2 5.5Z" /><path d="m2 8.5 6 3 6-3" /><path d="m2 11 6 3 6-3" /></Icon>
)

/** Checklist: the student's own courses. */
export const RecordIcon = (props: IconProps) => (
  <Icon {...props}><path d="m2.5 4.5 1.2 1.2 2-2.2M2.5 10.5l1.2 1.2 2-2.2M8 4.8h5.5M8 10.8h5.5" /></Icon>
)

export const KeyboardIcon = (props: IconProps) => (
  <Icon {...props}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" /></Icon>
)

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props}><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></Icon>
)
