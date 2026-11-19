import { describe, expect, it } from 'vitest'
import { estimateNoteHeight, fitWithNotes, placeNote, splitDollarMath, tidyMargin, typedFontSize } from '../../src/shared/typedNotes'
import type { MarginNote, Rect, Target } from '../../src/shared/types'

const W = 612
const H = 792
const M = 306

function note(id: string, box: Rect, targetIds: string[] = []): MarginNote {
  return { id, page: 0, box, strokeIds: [], text: 'x', candidates: [], corrected: false, kind: 'note', targetIds, createdAt: '', updatedAt: '', input: 'typed' }
}

describe('typed note size', () => {
  it('reads at about 12 px at the default view, at every size step', () => {
    expect(typedFontSize(1.2) * 1.2).toBeCloseTo(12, 0)
    expect(typedFontSize(0.78)).toBeCloseTo(15.4, 1)
    expect(typedFontSize(2)).toBe(8)
    expect(typedFontSize(1, 'L')).toBeGreaterThan(typedFontSize(1, 'M'))
    expect(typedFontSize(1, 'S')).toBeLessThan(typedFontSize(1, 'M'))
  })
  it('estimates more lines for longer text', () => {
    const one = estimateNoteHeight('short', 200, 10)
    const many = estimateNoteHeight('a much longer note that certainly wraps onto several lines of text in the margin', 120, 10)
    expect(many).toBeGreaterThan(one * 2)
    expect(estimateNoteHeight('', 200, 10, 3)).toBeGreaterThan(one * 2)
  })
})

describe('placing a typed note', () => {
  const base = { pageWidth: W, pageHeight: H, margin: M, width: 200, height: 40 }
  it('goes in the right margin level with a mark in a single column', () => {
    const p = placeNote({ ...base, others: [], markRects: [[72, 300, 400, 10]] })
    expect(p.fits).toBe(true)
    expect(p.box[0]).toBeGreaterThan(W)
    expect(p.box[1]).toBe(300)
  })
  it('goes in the left margin for a mark in the left column', () => {
    const p = placeNote({ ...base, others: [], markRects: [[60, 300, 200, 10]] })
    expect(p.box[0] + p.box[2]).toBeLessThan(0)
  })
  it('slides down, then up, past notes in the way', () => {
    const right = W + 4
    const p = placeNote({ ...base, others: [[right, 290, 200, 60]], markRects: [[72, 300, 400, 10]] })
    expect(p.fits).toBe(true)
    expect(p.box[1]).toBeGreaterThanOrEqual(354)
  })
  it('uses the other margin when the near one is full around the mark', () => {
    const right = W + 4
    const others: Rect[] = [[right, 0, 200, H]]
    const p = placeNote({ ...base, others, markRects: [[72, 300, 400, 10]] })
    expect(p.fits).toBe(true)
    expect(p.box[0] + p.box[2]).toBeLessThan(0)
  })
  it('prefers a margin in view, and says when it had to place out of view', () => {
    const inView = placeNote({ ...base, others: [], markRects: [[60, 300, 200, 10]], view: { x0: 0, x1: W + 220 } })
    expect(inView.box[0]).toBeGreaterThan(W)
    expect(inView.outOfView).toBe(false)
    const none = placeNote({ ...base, others: [], markRects: [[60, 300, 200, 10]], view: { x0: 0, x1: W } })
    expect(none.outOfView).toBe(true)
  })
  it('never runs past the bottom of the page', () => {
    const p = placeNote({ ...base, others: [], markRects: [[72, 780, 400, 10]] })
    expect(p.box[1] + p.box[3]).toBeLessThanOrEqual(H)
  })
  it('overlaps, and says so, only when nothing is free', () => {
    const p = placeNote({ ...base, others: [[W + 4, 0, 300, H], [-M, 0, M, H]], markRects: [[72, 300, 400, 10]] })
    expect(p.fits).toBe(false)
    expect(p.box[1]).toBe(300)
  })
})

describe('Tidy margin', () => {
  it('stacks notes in the order of their marks, without overlaps, each near its mark', () => {
    const targets: Target[] = [
      { id: 'a', kind: 'text', page: 0, rects: [[72, 100, 300, 10]], createdAt: '' },
      { id: 'b', kind: 'text', page: 0, rects: [[72, 110, 300, 10]], createdAt: '' }
    ]
    const notes = [note('n1', [W + 4, 100, 200, 50], ['a']), note('n2', [W + 4, 105, 200, 50], ['b']), note('n3', [W + 4, 600, 200, 30])]
    const boxes = tidyMargin(notes, targets, W, H)
    const y = (id: string) => (boxes.get(id) ?? notes.find((n) => n.id === id)!.box)[1]
    expect(y('n1')).toBe(100)
    expect(y('n2')).toBeGreaterThanOrEqual(154)
    expect(y('n3')).toBe(600)
  })
  it('pushes notes up from the bottom of the page', () => {
    const notes = [note('n1', [W + 4, 760, 200, 30]), note('n2', [W + 4, 770, 200, 30])]
    const boxes = tidyMargin(notes, [], W, H)
    const b2 = boxes.get('n2') ?? notes[1].box
    const b1 = boxes.get('n1') ?? notes[0].box
    expect(b2[1] + b2[3]).toBeLessThanOrEqual(H)
    expect(b1[1] + b1[3]).toBeLessThanOrEqual(b2[1])
  })
})

describe('Fit page + notes', () => {
  it('fits the page and a note column, and reaches out to notes further out', () => {
    const bare = fitWithNotes(1000, W, M, [])
    expect(bare.left).toBe(0)
    expect(bare.zoom).toBeCloseTo(1000 / (W + 160), 5)
    const withLeft = fitWithNotes(1000, W, M, [[-150, 10, 140, 20]])
    expect(withLeft.left).toBeLessThan(-150)
    expect(withLeft.zoom).toBeLessThan(bare.zoom)
  })
})

describe('dollar maths in typed notes', () => {
  it('keeps prices as text and reads maths', () => {
    expect(splitDollarMath('costs $5 and $10')).toEqual([{ math: false, text: 'costs $5 and $10' }])
    expect(splitDollarMath('see $x_t$ here')).toEqual([{ math: false, text: 'see ' }, { math: true, text: 'x_t' }, { math: false, text: ' here' }])
    expect(splitDollarMath('a \\$ sign')).toEqual([{ math: false, text: 'a $ sign' }])
  })
})
