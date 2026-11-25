import { describe, expect, it } from 'vitest'
import { adjustRegion, joinLines, outlineBlocks, outlinePath } from '../../src/shared/markShape'
import type { Rect } from '../../src/shared/types'

describe('outlineBlocks', () => {
  // Lines 12 high, 14 apart: the end of one line, a full line, the start of the next.
  const tail: Rect = [200, 100, 300, 12]
  const full: Rect = [70, 114, 430, 12]
  const head: Rect = [70, 128, 150, 12]

  it('puts lines that follow each other in one block, stretched to meet halfway', () => {
    const blocks = outlineBlocks([head, tail, full])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual([[200, 100, 300, 13], [70, 113, 430, 14], [70, 127, 150, 13]])
  })
  it('starts a new block after a skipped line or a paragraph space', () => {
    expect(outlineBlocks([tail, [70, 114, 150, 12]])).toHaveLength(1) // next line
    expect(outlineBlocks([tail, [70, 128, 150, 12]])).toHaveLength(2) // a line skipped
    expect(outlineBlocks([tail, [70, 121, 150, 12]])).toHaveLength(2) // a paragraph space
  })
  it('keeps lines with no width in common apart, such as one column and the next', () => {
    expect(outlineBlocks([[300, 100, 100, 12], [70, 114, 120, 12]])).toHaveLength(2)
  })
  it('evens out ragged line ends and a line missing its start', () => {
    const ragged: Rect[] = [[300, 100, 196, 12], [90, 114, 412, 12], [70, 128, 425, 12], [70, 142, 300, 12]]
    const [block] = outlineBlocks(ragged)
    const lefts = block.map((r) => r[0])
    const rights = block.map((r) => r[0] + r[2])
    expect(lefts).toEqual([300, 70, 70, 70]) // the first line keeps its start; the second gets its missing start back
    expect(rights).toEqual([502, 502, 502, 370]) // the last line keeps its end; the others share one right edge
  })
  it('snaps a first line or last line that nearly reaches the edge', () => {
    const [block] = outlineBlocks([[75, 100, 425, 12], [70, 114, 420, 12]])
    expect(block.map((r) => [r[0], r[0] + r[2]])).toEqual([[70, 500], [70, 500]])
  })
  it('leaves a single line as it is', () => {
    expect(outlineBlocks([tail])).toEqual([[tail]])
  })
})

describe('outlinePath', () => {
  const corners = (d: string): number => (d.match(/Q/g) ?? []).length
  it('goes round one line as a rounded box', () => {
    const d = outlinePath([[0, 0, 100, 12]])
    expect(corners(d)).toBe(4)
    expect(d.endsWith('Z')).toBe(true)
  })
  it('goes round the stepped shape of a mark that starts and ends mid-line', () => {
    const [block] = outlineBlocks([[200, 100, 300, 12], [70, 114, 430, 12], [70, 128, 150, 12]])
    // Right edge is straight down (two corners), left steps out (two more), bottom steps in (two).
    expect(corners(outlinePath(block))).toBe(8)
  })
  it('keeps every corner inside the lines it goes round', () => {
    const [block] = outlineBlocks([[200, 100, 300, 12], [70, 114, 430, 12]])
    const nums = outlinePath(block).match(/-?[\d.]+/g)!.map(Number)
    const xs = nums.filter((_, i) => i % 2 === 0)
    const ys = nums.filter((_, i) => i % 2 === 1)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(70)
    expect(Math.max(...xs)).toBeLessThanOrEqual(500)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(100)
    expect(Math.max(...ys)).toBeLessThanOrEqual(126)
  })
})

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
