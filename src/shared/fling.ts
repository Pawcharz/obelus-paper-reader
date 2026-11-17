/**
 * Momentum after a finger swipe, as in phone and browser PDF viewers: the page keeps moving at the
 * finger's speed when it lifts and slows down smoothly; another swipe the same way while it is
 * still moving adds to the speed, and a touch stops it.
 */

export interface TouchSample {
  /** Milliseconds. */
  t: number
  x: number
  y: number
}

/** Only the last part of a swipe counts, so a slow start does not dull a quick flick. */
export const VELOCITY_WINDOW_MS = 100
/** A finger held still this long before lifting means "stop here", not a fling. */
export const STILL_BEFORE_LIFT_MS = 60
/** Slower than this (px per ms) on lifting, the page just stops. */
export const MIN_FLING_SPEED = 0.25
/** Fastest fling, in px per ms, so one wild swipe cannot run off to the end of a long paper. */
export const MAX_FLING_SPEED = 14
/** How quickly a fling slows: its speed falls to about a third every this many ms. */
export const FLING_TIME_MS = 650
/** Below this speed (px per ms) a fling has stopped. */
export const STOP_SPEED = 0.02

/** The finger's speed on lifting, in px per ms, as [vx, vy] in finger direction; [0, 0] if none. */
export function releaseVelocity(samples: TouchSample[], liftT: number): [number, number] {
  if (samples.length < 2) return [0, 0]
  const last = samples[samples.length - 1]
  if (liftT - last.t > STILL_BEFORE_LIFT_MS) return [0, 0]
  const recent = samples.filter((s) => last.t - s.t <= VELOCITY_WINDOW_MS)
  const first = recent.length >= 2 ? recent[0] : samples[samples.length - 2]
  const dt = last.t - first.t
  if (dt <= 0) return [0, 0]
  return [(last.x - first.x) / dt, (last.y - first.y) / dt]
}

/**
 * The scroll speed a fling starts with, in px per ms of scrolling (the opposite way to the
 * finger), or null if the swipe was too slow. A fling still running the same way adds its speed.
 */
export function startFling(fingerV: [number, number], running: [number, number] | null): [number, number] | null {
  let vx = -fingerV[0]
  let vy = -fingerV[1]
  if (Math.hypot(vx, vy) < MIN_FLING_SPEED) return null
  if (running) {
    if (Math.sign(running[1]) === Math.sign(vy) && vy !== 0) vy += running[1]
    if (Math.sign(running[0]) === Math.sign(vx) && vx !== 0) vx += running[0]
  }
  const clamp = (v: number) => Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, v))
  return [clamp(vx), clamp(vy)]
}

/** One step of a fling: how far to scroll in `dt` ms, and the speed afterwards. */
export function flingStep(v: [number, number], dt: number): { dx: number; dy: number; v: [number, number] } {
  const k = Math.exp(-dt / FLING_TIME_MS)
  // Exact distance under exponential slowing, so it does not depend on the frame rate.
  const travel = FLING_TIME_MS * (1 - k)
  return { dx: v[0] * travel, dy: v[1] * travel, v: [v[0] * k, v[1] * k] }
}

/** How far a fling goes in total, in px. */
export function flingDistance(v: number): number {
  return v * FLING_TIME_MS
}
