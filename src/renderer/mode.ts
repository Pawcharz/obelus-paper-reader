import type { AppMode, AppSettings } from '../shared/types'

/**
 * Pen mode for a touchscreen, PC mode for a computer with none. Used until a mode is chosen in
 * Settings; it never switches by itself afterwards.
 */
export function detectMode(): AppMode {
  const touch = navigator.maxTouchPoints > 0 || window.matchMedia?.('(any-pointer: coarse)').matches
  return touch ? 'pen' : 'pc'
}

export function modeOf(s: Pick<AppSettings, 'mode'>): AppMode {
  return s.mode ?? detectMode()
}
