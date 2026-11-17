import { describe, expect, it } from 'vitest'
import { flingDistance, flingStep, MAX_FLING_SPEED, releaseVelocity, startFling } from '../../src/shared/fling'

const swipe = (n: number, dy: number, dtMs: number, t0 = 0) =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * dtMs, x: 100, y: 800 - i * dy }))

describe('a finger swipe keeps the page moving', () => {
  it('measures the speed at the end of the swipe', () => {
    // A slow start, then a quick flick over the last 100 ms: only the flick counts.
    const s = [...swipe(10, 2, 30), ...swipe(6, 40, 16, 300).map((p) => ({ ...p, y: p.y - 18 }))]
    const [, vy] = releaseVelocity(s, s[s.length - 1].t + 5)
    expect(vy).toBeCloseTo(-2.5, 1)
  })

  it('does not fling when the finger stopped before lifting, or barely moved', () => {
    const s = swipe(8, 30, 16)
    expect(releaseVelocity(s, s[s.length - 1].t + 200)).toEqual([0, 0])
    expect(startFling([0, -0.1], null)).toBeNull()
  })

  it('scrolls the opposite way to the finger, adds to a running fling the same way, and has a limit', () => {
    expect(startFling([0, -3], null)).toEqual([-0, 3])
    expect(startFling([0, -3], [0, 4])![1]).toBe(7)
    expect(startFling([0, -3], [0, -4])![1]).toBe(3)
    expect(startFling([0, -30], null)![1]).toBe(MAX_FLING_SPEED)
  })

  it('slows smoothly, the same at any frame rate', () => {
    let v: [number, number] = [0, 3]
    let at60 = 0
    for (let i = 0; i < 600; i++) { const s = flingStep(v, 1000 / 60); at60 += s.dy; v = s.v }
    v = [0, 3]
    let at30 = 0
    for (let i = 0; i < 300; i++) { const s = flingStep(v, 1000 / 30); at30 += s.dy; v = s.v }
    expect(at60).toBeCloseTo(at30, 3)
    expect(at60).toBeCloseTo(flingDistance(3), 0)
    // A quick flick goes a couple of screens.
    expect(flingDistance(4)).toBeGreaterThan(2000)
  })
})
