import { describe, expect, it } from 'vitest'
import { pinchView } from '../../src/shared/pinch'

const v = { x: 10, y: 20, zoom: 1 }

describe('pinchView', () => {
  it('fingers that do not move leave the view alone', () => {
    const p: [{ x: number; y: number }, { x: number; y: number }] = [{ x: 100, y: 100 }, { x: 200, y: 100 }]
    expect(pinchView(v, p, p, 0.05, 2)).toEqual(v)
  })

  it('spreading the fingers zooms in around the spot between them', () => {
    const out = pinchView(v, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }], 0.05, 2)
    expect(out.zoom).toBeCloseTo(2)
    // The map spot under (150, 100) is still there.
    expect((150 - out.x) / out.zoom).toBeCloseTo((150 - v.x) / v.zoom)
    expect((100 - out.y) / out.zoom).toBeCloseTo((100 - v.y) / v.zoom)
  })

  it('moving both fingers together pans', () => {
    const out = pinchView(v, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 130, y: 60 }, { x: 230, y: 60 }], 0.05, 2)
    expect(out).toEqual({ x: 40, y: -20, zoom: 1 })
  })

  it('zoom stays within its limits', () => {
    const out = pinchView(v, [{ x: 100, y: 100 }, { x: 110, y: 100 }], [{ x: 0, y: 100 }, { x: 400, y: 100 }], 0.05, 2)
    expect(out.zoom).toBe(2)
  })
})
