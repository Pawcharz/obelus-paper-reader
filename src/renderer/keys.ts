/** Whether a key press goes into a text box, where single-letter shortcuts must not fire. */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el || !el.tagName) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable
}

/** Ctrl on Windows, or Cmd where there is one. */
export function mod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

/** A plain key with no Ctrl, Alt or Cmd held, such as "p" for Pen. */
export function plain(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey
}

/** Where deleted files go: the Recycle Bin on Windows, the Trash elsewhere. */
export const TRASH = /Windows/i.test(navigator.userAgent) ? 'Recycle Bin' : 'Trash'
