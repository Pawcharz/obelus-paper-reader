import { describe, expect, it } from 'vitest'
import { classifyPenTouch, clusterStrokes, noteToJoin } from '../../src/shared/inkLogic'
import { InkPoint, MarginNote, Stroke } from '../../src/shared/types'

// Cases from the 14–15 Nov reading logs (PlaNet, pp. 1–3), in page units.
const T0 = Date.parse('2026-11-15T16:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const glyph = (id: string, x: number, y: number, t: number, h = 12): Stroke => ({
  id, page: 0, color: '#000', width: 1, createdAt: at(t),
  points: ([[x, y], [x + 3, y + h], [x + 6, y], [x + 8, y + h * 0.6]] as [number, number][])
    .map(([a, b], i) => [a, b, 0.5, i * 8] as InkPoint)
})
/** A word of n letters, 10 units apart, written from time t on. */
const word = (p: string, x: number, y: number, n: number, t: number, h = 12) =>
  Array.from({ length: n }, (_, i) => glyph(`${p}${i}`, x + i * 10, y, t + i * 0.3, h))
const noteOf = (id: string, strokes: Stroke[], extra: Partial<MarginNote> = {}): MarginNote => {
  const xs = strokes.flatMap((s) => s.points.map((p) => p[0]))
  const ys = strokes.flatMap((s) => s.points.map((p) => p[1]))
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)]
  return {
    id, page: 0, box: [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0], strokeIds: strokes.map((s) => s.id),
    text: 'x', candidates: [], corrected: false, kind: 'note', targetIds: [], createdAt: at(0), updatedAt: at(0), ...extra
  }
}
const lookup = (strokes: Stroke[]) => {
  const m = new Map(strokes.map((s) => [s.id, s]))
  return (id: string) => m.get(id)
}
const startOf = (c: Stroke[]) => Math.min(...c.map((s) => Date.parse(s.createdAt)))

describe('which note new writing carries on', () => {
  it('carries on a note with the next word on the same line, a wide gap away', () => {
    // 14 Nov 23:23: a short word, then 2.5 s later the next word about 30 units to the right.
    const a = word('a', -234, 560, 3, 0)
    const b = word('b', -183, 560, 8, 3)
    expect(noteToJoin(b, [noteOf('A', a)], lookup(a), startOf(b))?.id).toBe('A')
    // Even long after, a gap of two letter heights is still the same line.
    expect(noteToJoin(b, [noteOf('A', a)], lookup(a), startOf(b) + 600_000)?.id).toBe('A')
  })
  it('carries on a note with a new line written under it after a pause', () => {
    // 15 Nov 17:43: a two-line note, and 12 s later a line 8 units under it.
    const l1 = word('p', 616, 282, 12, 0, 16)
    const l2 = word('q', 616, 312, 12, 5, 16)
    const l3 = word('r', 617, 340, 10, 30, 16)
    const n = noteOf('N', [...l1, ...l2])
    expect(noteToJoin(l3, [n], lookup([...l1, ...l2]), startOf(l3))?.id).toBe('N')
  })
  it('puts writing inside the lower of two stacked notes into that one, not the one above', () => {
    // 14 Nov 23:15: the upper note grew to cover both.
    const up = word('u', 0, 100, 6, 0)
    const low = [...word('l', 0, 124, 6, 10), ...word('m', 0, 140, 6, 12)]
    const inside = word('i', 20, 128, 2, 60)
    const notes = [noteOf('UP', up), noteOf('LOW', low)]
    expect(noteToJoin(inside, notes, lookup([...up, ...low]), startOf(inside))?.id).toBe('LOW')
  })
  it('never joins two notes: a line between two stacked notes carries on the one above', () => {
    const up = word('u', 0, 100, 6, 0)
    const low = word('l', 0, 150, 6, 10)
    const mid = word('n', 0, 124, 5, 60)
    const notes = [noteOf('UP', up), noteOf('LOW', low)]
    expect(noteToJoin(mid, notes, lookup([...up, ...low]), startOf(mid))?.id).toBe('UP')
  })
  it('does not let a long arrow join a note it only passes by', () => {
    // 15 Nov 17:36: two strokes reaching from the text into the margin merged three notes.
    const n = word('n', -200, 90, 8, 0)
    const arrow: Stroke = {
      id: 'arrow', page: 0, color: '#000', width: 1, createdAt: at(100),
      points: [[-10, 5, 0.5, 0], [100, 200, 0.5, 400], [300, 360, 0.5, 800]]
    }
    expect(noteToJoin([arrow], [noteOf('N', n)], lookup(n), startOf([arrow]))).toBeUndefined()
  })
  it('keeps writing that ends a little left of a margin note as a note of its own', () => {
    // 15 Nov 17:45: a note written over the text ended 27 units short of a margin note.
    const margin = word('m', 627, 352, 10, 0)
    const text = word('t', 312, 352, 27, 100)
    expect(text[text.length - 1].points[3][0]).toBeLessThan(605)
    expect(noteToJoin(text, [noteOf('M', margin)], lookup(margin), startOf(text))).toBeUndefined()
  })
  it('leaves notes corrected by hand and drawings alone', () => {
    const a = word('a', 0, 100, 3, 0)
    const b = word('b', 40, 100, 3, 2)
    expect(noteToJoin(b, [noteOf('A', a, { corrected: true })], lookup(a), startOf(b))).toBeUndefined()
    expect(noteToJoin(b, [noteOf('A', a, { kind: 'drawing' })], lookup(a), startOf(b))).toBeUndefined()
  })
  it('starts a new note for writing well away from any note', () => {
    const a = word('a', 0, 100, 3, 0)
    const far = word('f', 0, 300, 3, 2)
    expect(noteToJoin(far, [noteOf('A', a)], lookup(a), startOf(far))).toBeUndefined()
  })
})

describe('grouping writing done in one go', () => {
  it('keeps words written one after another together across a wide gap', () => {
    const a = word('a', 0, 100, 3, 0)
    const b = word('b', 90, 100, 3, 1.2)
    expect(clusterStrokes([...a, ...b], true)).toHaveLength(1)
    // Ink that was moved is grouped by where it lies only.
    expect(clusterStrokes([...a, ...b])).toHaveLength(2)
  })
  it('still splits writing done in two places one after another', () => {
    const a = word('a', 0, 100, 3, 0)
    const b = word('b', 0, 300, 3, 1.2)
    expect(clusterStrokes([...a, ...b], true)).toHaveLength(2)
  })
})

describe('touches while writing (14 Nov 23:41)', () => {
  const words = word('w', -158, 369, 5, 0).map((s) => ({ ...s, handwriting: true }))
  const now = T0 + 2000
  const base = { page: 0, now, tapExtent: 7, tapMs: 400, punctuationMs: 1000, linking: false, hitsSomething: false, dismissing: false }
  const touch: InkPoint[] = [[-80, 375, 0.5, 0]]
  it('keeps a touch between words as part of the writing, so the note keeps its mark', () => {
    expect(classifyPenTouch({ ...base, points: touch, writing: words, writingMs: 4000 })).toBe('dot')
  })
  it('still lets the touch pick a note or a mark it lands on, or a link being made', () => {
    expect(classifyPenTouch({ ...base, points: touch, writing: words, writingMs: 4000, hitsSomething: true })).toBe('tap')
    expect(classifyPenTouch({ ...base, points: touch, writing: words, writingMs: 4000, linking: true })).toBe('tap')
  })
  it('is a tap once the writing has stopped', () => {
    expect(classifyPenTouch({ ...base, now: now + 10_000, points: touch, writing: words, writingMs: 4000 })).toBe('tap')
  })
  it('makes a slow tiny touch far from any writing a tap, not a note', () => {
    const slow: InkPoint[] = [[400, 600, 0.5, 0], [403, 602, 0.5, 300]]
    expect(classifyPenTouch({ ...base, points: slow, writing: words, writingMs: 4000 })).toBe('tap')
  })
})
