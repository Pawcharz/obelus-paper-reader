import { describe, expect, it } from 'vitest'
import { adjustRegion, joinLines } from '../../src/shared/markShape'
import type { Rect } from '../../src/shared/types'

describe('joinLines', () => {
  it('joins the pieces of an equation, with its sub- and superscripts, into one box', () => {
    const pieces: Rect[] = [
      [100, 50, 60, 12], // {(o_t, a_t, r_t
      [162, 44, 14, 7], // L+k (above)
      [162, 54, 14, 7], // t=k (below)
      [180, 46, 8, 8], // B
      [180, 54, 12, 7], // i=1
      [196, 50, 18, 12] // ~ D
    ]
    expect(joinLines(pieces)).toEqual([[100, 44, 114, 18]])
  })

  it('joins a superscript that only touches the line', () => {
    expect(joinLines([[100, 50, 40, 12], [141, 42, 10, 8]])).toEqual([[100, 42, 51, 20]])
  })

  it('keeps two lines apart when a subscript at the end of the first one reaches the second', () => {
    const out = joinLines([
      [60, 100, 200, 10], // "We consider sequences {o_t, a_t, r_t}"
      [262, 96, 5, 6], // T
      [262, 106, 14, 6], // t=1, hanging down to the next line
      [40, 112, 230, 10] // "step t, image observations o_t, continuous"
    ])
    expect(out).toEqual([[60, 96, 216, 16], [40, 112, 230, 10]])
  })

  it('keeps two lines of text as two boxes', () => {
    const out = joinLines([[50, 100, 40, 10], [95, 100, 40, 10], [50, 114, 40, 10]])
    expect(out).toEqual([[50, 100, 85, 10], [50, 114, 40, 10]])
  })

  it('keeps words in two columns apart', () => {
    expect(joinLines([[50, 100, 40, 10], [300, 100, 40, 10]])).toHaveLength(2)
  })
})

describe('adjustRegion', () => {
  const r: [number, number, number, number] = [100, 100, 50, 40]
  it('moves the whole region, staying on the page', () => {
    expect(adjustRegion(r, 'move', 20, -10, 600, 800)).toEqual([120, 90, 50, 40])
    expect(adjustRegion(r, 'move', -500, 0, 600, 800)).toEqual([0, 100, 50, 40])
  })
  it('resizes from a corner, keeping the opposite corner still', () => {
    expect(adjustRegion(r, 'se', 30, 20, 600, 800)).toEqual([100, 100, 80, 60])
    expect(adjustRegion(r, 'nw', -10, -5, 600, 800)).toEqual([90, 95, 60, 45])
  })
  it('never gets smaller than 12 units', () => {
    expect(adjustRegion(r, 'ne', -100, 100, 600, 800)).toEqual([100, 128, 12, 12])
  })
})
