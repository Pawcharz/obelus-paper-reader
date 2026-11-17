import { describe, expect, it } from 'vitest'
import { fixTrailingMarks, trailingMark } from '../../src/shared/inkLogic'
import { InkPoint, Stroke } from '../../src/shared/types'

let n = 0
const s = (pts: [number, number][]): Stroke => ({
  id: `s${++n}`, page: 0, color: '#000', width: 1, createdAt: '',
  points: pts.map(([x, y], i) => [x, y, 0.5, i * 8] as InkPoint)
})
/** Letters of height 8 on a baseline at y = 108. */
const letters = (x0: number, count: number) =>
  Array.from({ length: count }, (_, i) => s([[x0 + i * 8, 100], [x0 + i * 8 + 3, 108], [x0 + i * 8 + 6, 100]]))
// Shapes measured from the PlaNet notes: a hook with a dot under it, and a straight bar with one.
const hook = (x: number) => s([[x, 96], [x + 4, 93], [x + 8, 96], [x + 7, 101], [x + 4, 104], [x + 4, 108]])
const bar = (x: number) => s([[x, 92], [x + 0.5, 100], [x + 1, 107]])
const dot = (x: number, y = 113) => s([[x, y], [x + 1.5, y + 1.5]])

describe('a "?" or "!" seen in the ink', () => {
  it('finds a question mark and an exclamation mark at the end of a line', () => {
    expect(trailingMark([...letters(0, 5), hook(44), dot(47)])).toBe('?')
    expect(trailingMark([...letters(0, 5), bar(44), dot(44)])).toBe('!')
  })
  it('does not take the dot of an "i" or a full stop for one', () => {
    // A dot above the stem, as in "i".
    expect(trailingMark([...letters(0, 5), bar(44), dot(44, 86)])).toBe('')
    // A full stop on the line after a letter.
    expect(trailingMark([...letters(0, 5), dot(42, 106)])).toBe('')
  })
  it('ignores a "?" that has more writing after it', () => {
    expect(trailingMark([...letters(0, 3), hook(28), dot(31), ...letters(48, 3)])).toBe('')
  })
  it('puts the mark in place of what the recognizer read, and offers the fixed word first', () => {
    const lines = [[...letters(0, 5), s([[0, 120], [8, 128]])], [...letters(0, 5), hook(44), dot(47)]]
    const r = fixTrailingMarks('what do they mean\nobjective.', [['what'], ['do'], ['they'], ['mean'], ['objective.', 'objective']], lines)
    expect(r.text).toBe('what do they mean\nobjective?')
    expect(r.candidates[4]).toEqual(['objective?', 'objective.', 'objective'])
  })
  it('leaves a line that already ends in the mark, and text whose lines do not match the ink', () => {
    const line = [...letters(0, 5), hook(44), dot(47)]
    expect(fixTrailingMarks('why?', [['why?']], [line]).text).toBe('why?')
    expect(fixTrailingMarks('one\ntwo', [], [line]).text).toBe('one\ntwo')
  })
})
