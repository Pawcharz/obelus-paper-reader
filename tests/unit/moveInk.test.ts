import { describe, expect, it } from 'vitest'
import { deleteInk, moveInk, scaleInk, strokesInLasso } from '../../src/shared/inkLogic'
import type { InkPoint, MarginNote, Stroke } from '../../src/shared/types'

const glyph = (id: string, x: number, y: number): Stroke => ({
  id, page: 0, color: '#000', width: 1, createdAt: '',
  points: ([[x, y], [x + 3, y + 10], [x + 6, y], [x + 8, y + 6]] as [number, number][]).map(([a, b], i) => [a, b, 0.5, i * 8] as InkPoint)
})
const word = (prefix: string, x: number, y: number) => [0, 1, 2].map((i) => glyph(`${prefix}${i}`, x + i * 10, y))
const note = (id: string, strokes: Stroke[], targetIds: string[] = []): MarginNote => {
  const xs = strokes.flatMap((s) => s.points.map((p) => p[0]))
  const ys = strokes.flatMap((s) => s.points.map((p) => p[1]))
  return {
    id, page: 0, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)],
    strokeIds: strokes.map((s) => s.id), text: 'x', candidates: [], corrected: false, kind: 'note', targetIds, createdAt: 'c', updatedAt: 'c'
  }
}
let n = 0
const ids = () => `new${++n}`

describe('selecting ink with a loop', () => {
  it('takes strokes mostly inside the loop, and only on that page', () => {
    const strokes = [...word('a', 0, 100), ...word('b', 60, 100)]
    const loop: [number, number][] = [[50, 90], [100, 90], [100, 120], [50, 120]]
    expect(strokesInLasso(strokes, 0, loop)).toEqual(['b0', 'b1', 'b2'])
    expect(strokesInLasso(strokes, 1, loop)).toEqual([])
    expect(strokesInLasso(strokes, 0, loop, new Set(['b1']))).toEqual(['b0', 'b2'])
  })
})

describe('moving ink regroups the notes around it', () => {
  it('splits a note when one of its words is moved away; both keep the link', () => {
    const first = word('a', 0, 100)
    const second = word('b', 40, 100)
    const d = { ink: { strokes: [...first, ...second] }, annotations: { marginNotes: [note('m1', [...first, ...second], ['t1'])] } }
    const read = moveInk(d, 0, new Set(['b0', 'b1', 'b2']), 0, 80, ids, 'now')
    const notes = d.annotations.marginNotes
    expect(notes).toHaveLength(2)
    const kept = notes.find((x) => x.id === 'm1')!
    expect(kept.strokeIds).toEqual(['a0', 'a1', 'a2'])
    const split = notes.find((x) => x.id !== 'm1')!
    expect(split.strokeIds).toEqual(['b0', 'b1', 'b2'])
    expect(split.targetIds).toEqual(['t1'])
    expect(split.box[1]).toBe(180)
    expect(read.sort()).toEqual([kept.id, split.id].sort())
  })
  it('joins two notes when one is moved right next to the other', () => {
    const first = word('a', 0, 100)
    const second = word('b', 0, 200)
    const d = { ink: { strokes: [...first, ...second] }, annotations: { marginNotes: [note('m1', first, ['t1']), note('m2', second, ['t2'])] } }
    moveInk(d, 0, new Set(['b0', 'b1', 'b2']), 40, -100, ids, 'now')
    expect(d.annotations.marginNotes).toHaveLength(1)
    expect(d.annotations.marginNotes[0].strokeIds).toHaveLength(6)
    expect(d.annotations.marginNotes[0].targetIds.sort()).toEqual(['t1', 't2'])
  })
  it('keeps a note moved whole as it was, typed text included, without reading it again', () => {
    const first = word('a', 0, 100)
    const d = { ink: { strokes: first }, annotations: { marginNotes: [{ ...note('m1', first, ['t1']), text: 'typed', corrected: true }] } }
    expect(moveInk(d, 0, new Set(['a0', 'a1', 'a2']), 0, 300, ids, 'now')).toEqual([])
    expect(d.annotations.marginNotes[0]).toMatchObject({ id: 'm1', targetIds: ['t1'], text: 'typed', corrected: true })
    expect(d.annotations.marginNotes[0].box[1]).toBe(400)
  })
  it('splits what is left behind when the middle word is taken out', () => {
    const [a, b, c] = [word('a', 0, 100), word('b', 40, 100), word('c', 80, 100)]
    const d = { ink: { strokes: [...a, ...b, ...c] }, annotations: { marginNotes: [note('m1', [...a, ...b, ...c])] } }
    // With the middle word gone, the outer two are too far apart to be one note.
    moveInk(d, 0, new Set(['b0', 'b1', 'b2']), 0, 200, ids, 'now')
    expect(d.annotations.marginNotes).toHaveLength(3)
  })
  it('just moves ink that belongs to no note', () => {
    const arrow = glyph('s', 0, 0)
    const d = { ink: { strokes: [arrow] }, annotations: { marginNotes: [] as MarginNote[] } }
    expect(moveInk(d, 0, new Set(['s']), 5, 5, ids, 'now')).toEqual([])
    expect(d.ink.strokes[0].points[0]).toEqual([5, 5, 0.5, 0])
    expect(d.annotations.marginNotes).toHaveLength(0)
  })
})

describe('deleting selected ink', () => {
  it('shrinks the note, or removes it when nothing is left', () => {
    const first = word('a', 0, 100)
    const d = { ink: { strokes: first }, annotations: { marginNotes: [note('m1', first)] } }
    expect(deleteInk(d, new Set(['a2']))).toEqual(['m1'])
    expect(d.annotations.marginNotes[0].strokeIds).toEqual(['a0', 'a1'])
    deleteInk(d, new Set(['a0', 'a1']))
    expect(d.annotations.marginNotes).toHaveLength(0)
    expect(d.ink.strokes).toHaveLength(0)
  })
})

describe('scaling ink', () => {
  it('shrinks a note in the left margin towards the text, line widths too, keeping its text', () => {
    const w = word('a', -100, 100)
    const d = { ink: { strokes: w }, annotations: { marginNotes: [{ ...note('m1', w, ['t1']), text: 'abc', corrected: true }] } }
    const before = d.annotations.marginNotes[0].box
    expect(scaleInk(d, 0, new Set(['a0', 'a1', 'a2']), 0.5, ids, 'now')).toEqual([])
    const after = d.annotations.marginNotes[0]
    expect(after).toMatchObject({ id: 'm1', text: 'abc', corrected: true, targetIds: ['t1'] })
    // The right edge, next to the printed text, and the top stay put.
    expect(after.box[0] + after.box[2]).toBeCloseTo(before[0] + before[2], 1)
    expect(after.box[1]).toBeCloseTo(before[1], 1)
    expect(after.box[2]).toBeCloseTo(before[2] / 2, 1)
    expect(d.ink.strokes[0].width).toBe(0.5)
  })
  it('resizes about a given point, such as the corner opposite the one dragged', () => {
    const w = word('a', 700, 100)
    const d = { ink: { strokes: w }, annotations: { marginNotes: [note('m1', w)] } }
    const [x, y, bw, bh] = d.annotations.marginNotes[0].box
    // The top-left corner was dragged, so the bottom-right one stays put.
    scaleInk(d, 0, new Set(['a0', 'a1', 'a2']), 0.5, ids, 'now', [x + bw, y + bh])
    const after = d.annotations.marginNotes[0].box
    expect(after[0] + after[2]).toBeCloseTo(x + bw, 1)
    expect(after[1] + after[3]).toBeCloseTo(y + bh, 1)
    expect(after[2]).toBeCloseTo(bw / 2, 1)
  })
  it('grows ink in the right margin from its left edge', () => {
    const w = word('a', 700, 100)
    const d = { ink: { strokes: w }, annotations: { marginNotes: [note('m1', w)] } }
    const before = d.annotations.marginNotes[0].box
    scaleInk(d, 0, new Set(['a0', 'a1', 'a2']), 1.25, ids, 'now')
    const after = d.annotations.marginNotes[0].box
    expect(after[0]).toBeCloseTo(before[0], 1)
    expect(after[2]).toBeCloseTo(before[2] * 1.25, 1)
  })
})
