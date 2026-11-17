import { useEffect, useRef, useState } from 'react'

/** Which edge of the window a side pane sits against. */
export type Side = 'left' | 'right'

function stored<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
    return v ?? fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

/** A side pane's width and whether it is open, both remembered on this computer. */
export function useSidebar(name: string, defaultWidth: number, min: number, max: number) {
  const widthKey = `paper-reader.sidebar.${name}.width`
  const openKey = `paper-reader.sidebar.${name}.open`
  const [width, setWidthState] = useState(() => clamp(Number(stored(widthKey, defaultWidth)) || defaultWidth, min, max))
  const [open, setOpenState] = useState(() => stored<boolean>(openKey, true) !== false)
  const setWidth = (w: number, save = true) => {
    const c = clamp(w, min, max)
    setWidthState(c)
    if (save) store(widthKey, c)
  }
  const setOpen = (o: boolean | ((prev: boolean) => boolean)) =>
    setOpenState((prev) => {
      const next = typeof o === 'function' ? o(prev) : o
      store(openKey, next)
      return next
    })
  return { width, setWidth, open, setOpen, min, max }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * A strip on a pane's inner edge that pen, finger or mouse drags to change the pane's width.
 * The width is saved when the drag ends.
 */
export function ResizeHandle({ side, width, onWidth, testId }: {
  side: Side
  width: number
  onWidth: (w: number, save: boolean) => void
  testId?: string
}) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const last = useRef(width)
  useEffect(() => { last.current = width }, [width])
  const widthAt = (clientX: number) => {
    const s = start.current
    if (!s) return width
    const dx = clientX - s.x
    return side === 'right' ? s.w - dx : s.w + dx
  }
  return (
    <div
      className={`resize-handle ${side}`}
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      title="Drag to change the width"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        onWidth(widthAt(e.clientX), false)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        onWidth(widthAt(e.clientX), true)
        start.current = null
      }}
      onPointerCancel={() => {
        if (start.current) onWidth(last.current, true)
        start.current = null
      }}
    />
  )
}

/** The usual "show or hide the side panel" picture: a window with its side panel shaded. */
export function PanelIcon({ side, open }: { side: Side; open: boolean }) {
  const x = side === 'left' ? 2.5 : 10.5
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1={side === 'left' ? 6 : 10} y1="2.5" x2={side === 'left' ? 6 : 10} y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      {open && <rect x={x} y="3.5" width="3" height="9" fill="currentColor" opacity="0.45" />}
    </svg>
  )
}

/** A button that folds or unfolds a side pane, shown as the side-panel picture. */
export function PanelToggle({ side, open, label, onClick, testId }: {
  side: Side
  open: boolean
  label: string
  onClick: () => void
  testId?: string
}) {
  const text = `${open ? 'Hide' : 'Show'} ${label}`
  return (
    <button className="panel-toggle" data-testid={testId} title={text} aria-label={text} aria-pressed={open} onClick={onClick}>
      <PanelIcon side={side} open={open} />
    </button>
  )
}
