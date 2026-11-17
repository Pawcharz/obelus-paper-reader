import { describe, expect, it } from 'vitest'
import { destBox } from '../../src/shared/linkTarget'
import type { Rect } from '../../src/shared/types'

const w = (x: number, y: number, width = 30, h = 10) => ({ rect: [x, y, width, h] as Rect })

// Two columns: the left one from x 50 to 290, the right one from 310 to 550.
const page = [
  w(50, 100), w(85, 100), w(120, 100), w(310, 100), w(345, 100), // a line in each column
  w(60, 130, 80), w(150, 130, 60), w(270, 130, 18), // an equation, its number "(3)" off to the side
  w(310, 130), w(345, 130),
  w(50, 160), w(85, 160)
]

describe('destBox', () => {
  it('takes the line at the destination, in its own column only', () => {
    const [x, y, width, h] = destBox(page, 50, 98)
    expect(y).toBeCloseTo(97)
    expect(x).toBeCloseTo(47)
    // Ends at the left column's last word (120 + 30), not in the right column.
    expect(x + width).toBeCloseTo(153)
    expect(h).toBeCloseTo(16)
  })

  it('starts in the right column when the destination is there', () => {
    const [x, , width] = destBox(page, 310, 128)
    expect(x).toBeCloseTo(307)
    expect(x + width).toBeCloseTo(378)
  })

  it('leaves out an equation number far to the side', () => {
    const eq = [w(80, 200, 120), w(260, 200, 20)]
    const [x, , width] = destBox(eq, 70, 195)
    expect(x + width).toBeCloseTo(203)
  })

  it('gives a band at the destination when there is no text there', () => {
    expect(destBox([], 40, 300)).toEqual([40, 300, 200, 24])
    expect(destBox([], null, 300)).toEqual([0, 300, 400, 24])
  })
})
