/** Small line icons for the side rail, drawn in the current text colour. */

const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

/** The app's logo: an obelus, the editor's mark for "look again at this passage". Same drawing as resources/obelus-icon.svg. */
export function ObelusLogo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Obelus" className="app-logo">
      <rect width="64" height="64" rx="14" fill="#1B2440" />
      <rect x=".5" y=".5" width="63" height="63" rx="13.5" fill="none" stroke="#fff" strokeOpacity=".16" />
      <g transform="rotate(-12 32 32)">
        <rect x="11" y="28.5" width="42" height="7" rx="3.5" fill="#F5F2EA" />
        <circle cx="32" cy="14.5" r="6.5" fill="#FF7A2F" />
        <circle cx="32" cy="49.5" r="6.5" fill="#FF7A2F" />
      </g>
    </svg>
  )
}

export function LibraryIcon() {
  return (
    <svg {...base}>
      <rect x="4" y="4" width="4" height="16" rx="1" />
      <rect x="9" y="4" width="4" height="16" rx="1" />
      <path d="M14.5 5.2l3.9-1 3.5 14.6-3.9 1z" />
    </svg>
  )
}

export function MapsIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3.5" width="7" height="5" rx="1" />
      <rect x="14" y="3.5" width="7" height="5" rx="1" />
      <rect x="8.5" y="15.5" width="7" height="5" rx="1" />
      <path d="M6.5 8.5v3h11v-3M12 11.5v4" />
    </svg>
  )
}

export function RecordIcon({ on }: { on: boolean }) {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" fill={on ? 'currentColor' : 'none'} />
    </svg>
  )
}

export function PersonIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
    </svg>
  )
}

export function GearIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

export function PencilIcon() {
  return (
    <svg {...base} width={16} height={16}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  )
}

export function PenModeIcon() {
  return (
    <svg {...base}>
      <path d="M4 20l1.2-4.8L15.6 4.8a2 2 0 012.8 0l.8.8a2 2 0 010 2.8L8.8 18.8z" />
      <path d="M13.5 7l3.5 3.5" />
    </svg>
  )
}

export function KeyboardIcon() {
  return (
    <svg {...base}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12" />
    </svg>
  )
}
