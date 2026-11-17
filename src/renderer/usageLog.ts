import type { UsageEvent, UsageVia } from '../shared/types'
import { isTyping } from './keys'

/**
 * The usage log: while switched on, every key, button and pen action is written to a file with
 * its exact time, to learn which actions follow which during real reading. Typed text is never
 * recorded, only that typing happened.
 */

let enabled = false
let queue: UsageEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
/** The kind of pointer that last touched the screen, so a click can say whether it was pen, finger or mouse. */
let lastPointer: UsageVia = 'mouse'

export function usageLogging(): boolean {
  return enabled
}

export function pointerVia(): UsageVia {
  return lastPointer
}

function localTime(ms: number): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

export function flushUsage(): void {
  if (timer) { clearTimeout(timer); timer = null }
  if (queue.length === 0) return
  const batch = queue
  queue = []
  void window.api.logUsage(batch).catch(() => undefined)
}

/** Records one action. Does nothing while logging is off. */
export function logEvent(type: string, detail: Record<string, unknown> = {}): void {
  if (!enabled) return
  const ms = Date.now()
  queue.push({ ms, time: localTime(ms), session, seq: ++seq, type, ...detail })
  if (queue.length >= 50) flushUsage()
  else if (!timer) timer = setTimeout(flushUsage, 1000)
}

export function setUsageLogging(on: boolean): void {
  if (on === enabled) return
  if (on) {
    enabled = true
    logEvent('log.on', { screen: `${window.innerWidth}x${window.innerHeight}` })
  } else {
    logEvent('log.off')
    flushUsage()
    enabled = false
  }
}

/** A key as a person would name it, such as "Ctrl+Shift+T" or "ArrowRight". */
export function keyName(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}

/** What a tap or click landed on: its test name, or the button's label. */
function describeTarget(el: HTMLElement): Record<string, unknown> | null {
  const hit = el.closest<HTMLElement>('[data-testid], button, a, select, input, textarea, [role="button"]')
  if (!hit) return null
  const id = hit.dataset.testid
  const label = (hit.getAttribute('aria-label') || hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return { target: id ?? hit.tagName.toLowerCase(), ...(label && hit.tagName !== 'INPUT' && hit.tagName !== 'TEXTAREA' ? { label } : {}) }
}

let typingSince = 0
let typingCount = 0
let typingTarget = ''

function endTyping(): void {
  if (typingCount === 0) return
  logEvent('typing', { target: typingTarget, keys: typingCount, durationMs: Date.now() - typingSince })
  typingCount = 0
}

/** Listens to every key and click in the window. Installed once, at start. */
export function installUsageCapture(): void {
  window.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse'
  }, true)
  window.addEventListener('keydown', (e) => {
    if (!enabled || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
    const shortcut = e.ctrlKey || e.altKey || e.metaKey || e.key.length > 1
    if (isTyping(e) && (!shortcut || ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))) {
      // Typed text stays private: only how much was typed, and where.
      const target = (e.target as HTMLElement).dataset?.testid ?? (e.target as HTMLElement).tagName.toLowerCase()
      if (typingCount === 0 || target !== typingTarget) { endTyping(); typingSince = Date.now(); typingTarget = target }
      typingCount++
      return
    }
    endTyping()
    logEvent('key', { key: keyName(e), via: 'key', ...(isTyping(e) ? { inBox: true } : {}), ...(e.repeat ? { repeat: true } : {}) })
  }, true)
  window.addEventListener('click', (e) => {
    if (!enabled) return
    const what = describeTarget(e.target as HTMLElement)
    if (!what) return
    endTyping()
    logEvent('click', { ...what, via: e.detail === 0 ? 'key' : lastPointer })
  }, true)
  window.addEventListener('beforeunload', () => { endTyping(); flushUsage() })
  document.addEventListener('visibilitychange', () => { if (document.hidden) { endTyping(); flushUsage() } })
}
