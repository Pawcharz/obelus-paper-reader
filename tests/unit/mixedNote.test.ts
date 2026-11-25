import { describe, expect, it } from 'vitest'
import { forceKind, inkScore, judgeWords, piecesText, planPieces, readingScore } from '../../src/shared/mixedNote'
import type { InkPoint, NotePiece, RecognizedWord, Stroke } from '../../src/shared/types'

let n = 0
const stroke = (pts: [number, number][]): Stroke => ({
  id: `s${n++}`, page: 0, color: '#000', width: 1, createdAt: '2026-11-24T00:00:00Z',
  points: pts.map(([x, y], i) => [x, y, 0.5, i] as InkPoint)
})
/** A letter-sized squiggle at x, on a line whose letters span y..y+10. */
const letter = (x: number, y = 0) => stroke([[x, y + 10], [x + 3, y], [x + 6, y + 10], [x + 8, y + 4]])
const word = (x: number, letters: number, y = 0) => Array.from({ length: letters }, (_, i) => letter(x + i * 9, y))
const w = (line: number, text: string, x0: number, x1: number, real: boolean, y0 = 0, y1 = 12): RecognizedWord =>
  ({ line, text, real, box: [x0, y0, x1 - x0, y1 - y0] })

describe('reading score', () => {
  it('real words are text, symbol-heavy non-words lean to maths', () => {
    expect(readingScore({ line: 0, text: 'posterior', real: true }).score).toBeLessThan(0)
    expect(readingScore({ line: 0, text: '(0+15=)', real: false }).score).toBeGreaterThan(1.5)
    expect(readingScore({ line: 0, text: 'p(x)', real: false }).score).toBeGreaterThanOrEqual(1)
    expect(readingScore({ line: 0, text: 'posteriorr', real: false }).score).toBeLessThan(0.5)
  })
  it('things from real notes that are text', () => {
    for (const t of ['-', '/', '..', '->', 'Multi-step', 'model-based', 'random/stochastic,', "I'm", "don't", 'A3C', 'D4PG', '(Wand', 'M)', '-look-at', '200']) {
      expect(readingScore({ line: 0, text: t, real: false }).score, t).toBeLessThan(1.5)
    }
    expect(readingScore({ line: 0, text: '+', real: false }).signals).toContain('lone symbol')
  })
})

describe('ink score', () => {
  const box = (id: string, x0: number, y0: number, x1: number, y1: number) => ({ id, x0, y0, x1, y1 })
  const line = Array.from({ length: 8 }, (_, i) => box(`l${i}`, i * 12, 0, i * 12 + 9, 10))
  it('sees a subscript, a tall bracket and a fraction bar', () => {
    expect(inkScore([box('a', 0, 0, 9, 10), box('sub', 10, 10, 14, 16)], line, 10).signals).toContain('script above or below the line')
    // An apostrophe is thin: not a script.
    expect(inkScore([box('a', 0, 0, 9, 10), box('apo', 10, -2, 10.8, 2)], line, 10).signals).not.toContain('script above or below the line')
    expect(inkScore([box('b', 0, -8, 4, 22)], line, 10).signals).toContain('tall symbol')
    expect(inkScore([box('num', 2, -12, 10, -3), box('bar', 0, -1, 20, 0), box('den', 2, 2, 10, 11)], line, 10).signals).toContain('fraction bar')
  })
  it('plain letters on the line give nothing', () => {
    expect(inkScore(line.slice(0, 3), line, 10).score).toBe(0)
  })
})

describe('mixed notes', () => {
  // "the  p(x)=1  is tight": real words around a symbol-heavy non-word.
  const the = word(0, 3), maths = word(40, 5), is = word(100, 2), tight = word(130, 5)
  const strokes = [...the, ...maths, ...is, ...tight]
  const words = [w(0, 'the', 0, 26, true), w(0, 'p(x)=1', 40, 84, false), w(0, 'is', 100, 116, true), w(0, 'tight', 130, 174, true)]

  it('labels words and turns maths words into one span', () => {
    const judged = judgeWords(strokes, words)
    expect(judged[0].map((j) => j.kind)).toEqual(['text', 'math', 'text', 'text'])
    expect(judged[0][1].strokeIds).toEqual(maths.map((s) => s.id))
    const pieces = planPieces(judged)!
    expect(pieces.map((p) => p.kind)).toEqual(['text', 'math', 'text', 'text'])
    expect(piecesText(pieces, (p) => (p.kind === 'math' ? '$p(x)=1$' : p.text))).toBe('the $p(x)=1$ is tight')
  })

  it('leaves a plain text note alone', () => {
    const plain = [w(0, 'the', 0, 26, true), w(0, 'posterior', 40, 84, true)]
    expect(planPieces(judgeWords([...the, ...maths], plain))).toBeNull()
  })

  it('a doubtful word between maths words is maths too', () => {
    const ws = [w(0, 'a=', 0, 26, false), w(0, 'b', 40, 84, false), w(0, '+1', 100, 116, false), w(0, 'tight', 130, 174, true)]
    expect(judgeWords(strokes, ws)[0].map((j) => j.kind)).toEqual(['math', 'math', 'math', 'text'])
  })

  it('your choice wins over the automatic label', () => {
    const forced = forceKind(undefined, tight.map((s) => s.id), 'math')
    expect(judgeWords(strokes, words, forced)[0][3].kind).toBe('math')
    const back = forceKind(forced, tight.map((s) => s.id), 'text')
    expect(back).toHaveLength(1)
    expect(judgeWords(strokes, words, back)[0][3].kind).toBe('text')
  })

  it('a short name stuck onto bracketed maths joins it, and a ? after it stays text', () => {
    // "what is pa(o1:T|a1:T)?" — "pa" is a real (Polish) word written right against the bracket.
    const what = word(0, 4), is = word(45, 2), pd = word(70, 2), args = word(88, 6)
    const hook = stroke([[148, 0], [152, -2], [155, 3], [151, 6]]), dot = stroke([[151, 10], [151.4, 10.4]])
    const all = [...what, ...is, ...pd, ...args, hook, dot]
    const ws = [w(0, 'what', 0, 34, true), w(0, 'is', 45, 61, true), w(0, 'pa', 70, 86, true), w(0, '(o1:T|a1:T)?', 88, 156, false)]
    const judged = judgeWords(all, ws)[0]
    expect(judged.map((j) => [j.word.text, j.kind])).toEqual([['what', 'text'], ['is', 'text'], ['pa', 'math'], ['(o1:T|a1:T)', 'math'], ['?', 'text']])
    expect(judged[4].strokeIds.sort()).toEqual([hook.id, dot.id].sort())
    expect(judged[2].unsure).toBe(true)
    expect(judged[0].unsure).toBe(false)
    const pieces = planPieces([judged], all)!
    expect(piecesText(pieces, (p) => (p.kind === 'math' ? '$p_d(o|a)$' : p.text))).toBe('what is $p_d(o|a)$?')
  })

  it('a name a bit closer to the bracket than a word gap joins it; at about a word gap it is asked about', () => {
    // Gaps between words: 11 each. "Pd" to "(": 8 (0.73 of usual) joins; 10 (0.9) stays text, unsure.
    const run = (gap: number) => {
      const a = word(0, 3), b = word(38, 3), c = word(76, 3), pd = word(114, 2)
      const x = 114 + 17 + gap
      const args = word(x, 4)
      const ws = [w(0, 'and', 0, 26, true), w(0, 'the', 38, 64, true), w(0, 'and', 76, 102, true),
        w(0, 'Pd', 114, 131, true), w(0, '(o1:T|a1:T)', x, x + 35, false)]
      return judgeWords([...a, ...b, ...c, ...pd, ...args], ws)[0][3]
    }
    expect(run(8).kind).toBe('math')
    const far = run(10)
    expect(far.kind).toBe('text')
    expect(far.unsure).toBe(true)
  })

  it('a ! after maths stays in it as a factorial, and is asked about at the end of a line', () => {
    const so = word(0, 2), n = word(30, 3)
    const bar = stroke([[60, 0], [60, 7]]), dot = stroke([[60, 10], [60.3, 10.3]])
    const all = [...so, ...n, bar, dot]
    const ws = [w(0, 'so', 0, 16, true), w(0, '(n+1)!', 30, 62, false)]
    const judged = judgeWords(all, ws)[0]
    expect(judged.map((j) => [j.word.text, j.kind])).toEqual([['so', 'text'], ['(n+1)!', 'math']])
    expect(judged[1].strokeIds).toContain(bar.id)
    expect(judged[1].unsure).toBe(true)
  })

  it('maths lines directly under each other become one span', () => {
    const l0 = word(0, 6, 0), l1 = word(0, 4, 30), l2 = word(0, 3, 60)
    const ws = [w(0, 'a=b+c', 0, 50, false, 0, 12), w(1, '=d+1', 0, 32, false, 30, 42), w(2, 'done', 0, 24, true, 60, 72)]
    const pieces = planPieces(judgeWords([...l0, ...l1, ...l2], ws)) as NotePiece[]
    expect(pieces.map((p) => (p.text === '\n' ? 'NL' : p.kind))).toEqual(['math', 'NL', 'text'])
    expect(pieces[0].strokeIds).toHaveLength(10)
  })
})

describe('rules tuned on synthetic mixed notes', () => {
  const kinds = (all: Stroke[], ws: RecognizedWord[]) => judgeWords(all, ws)[0].map((j) => [j.word.text, j.kind])
  /** A flat dash from x0 to x1 at mid height of a letter line. */
  const dash = (x0: number, x1: number) => stroke([[x0, 5], [(x0 + x1) / 2, 5.3], [x1, 5]])

  it('reading: maths names, variables, one-letter words, short terms', () => {
    expect(readingScore({ line: 0, text: 'tan', real: true }).signals).toContain('maths function name')
    expect(readingScore({ line: 0, text: 'log,', real: true }).signals).toContain('maths function name')
    // "det." in a real note meant deterministic: not a maths name.
    expect(readingScore({ line: 0, text: 'det.', real: true }).signals).not.toContain('maths function name')
    expect(readingScore({ line: 0, text: 'sin?0', real: false }).score).toBeGreaterThanOrEqual(1.5)
    expect(readingScore({ line: 0, text: 'x', real: true }).signals).toEqual(['single letter'])
    for (const t of ['a', 'I', 'w', 'z']) expect(readingScore({ line: 0, text: t, real: true }).signals, t).toEqual(['one-letter word'])
    expect(readingScore({ line: 0, text: 'P(ANB)', real: false }).signals).toContain('function applied')
    expect(readingScore({ line: 0, text: 'x-7', real: false }).score).toBeGreaterThanOrEqual(1.5)
    expect(readingScore({ line: 0, text: 'C-O', real: true }).score).toBeLessThan(0)
  })

  it('a relation sign on its own is maths with what it relates, unless that is a real word', () => {
    const a = word(0, 3), dx = word(40, 2), eq = word(64, 1), two = word(80, 1), b = word(100, 4)
    const ws = [w(0, 'the', 0, 26, true), w(0, 'dx', 40, 57, true), w(0, '=', 64, 72, false), w(0, '2', 80, 88, false), w(0, 'here', 100, 135, true)]
    expect(kinds([...a, ...dx, ...eq, ...two, ...b], ws)).toEqual([['the', 'text'], ['dx', 'math'], ['=', 'math'], ['2', 'math'], ['here', 'text']])
    // "=" glued to the word before: the number after it joins ("2^= 1024").
    const ws2 = [w(0, 'the', 0, 26, true), w(0, '2^=', 40, 72, false), w(0, '1024', 80, 88, false), w(0, 'here', 100, 135, true)]
    expect(kinds([...a, ...dx, ...eq, ...two, ...b], ws2).map((k) => k[1])).toEqual(['text', 'math', 'math', 'text'])
  })

  it('a maths name before a rare short word applies to it, before a common one it is a misread word', () => {
    const a = word(0, 3), b = word(40, 2), c = word(64, 4)
    const all = [...a, ...b, ...c]
    expect(kinds(all, [w(0, 'tan', 0, 26, true), w(0, 'Li', 40, 57, true), w(0, 'here', 64, 99, true)]).map((k) => k[1])).toEqual(['math', 'math', 'text'])
    expect(planPieces(judgeWords(all, [w(0, 'tan', 0, 26, true), w(0, 'it', 40, 57, true), w(0, 'here', 64, 99, true)]))).toBeNull()
  })

  it('formula - remark: a dash read into the formula, and the words after it, go back to the text', () => {
    const f = word(0, 4), d = dash(48, 58), ex = word(66, 5), tail = word(130, 3)
    const all = [...f, d, ...ex, ...tail]
    const judged = judgeWords(all, [w(0, 'F=ma-Explain', 0, 110, false), w(0, 'now', 130, 156, true)])[0]
    expect(judged.map((j) => [j.word.text, j.kind])).toEqual([['F=ma', 'math'], ['-', 'text'], ['Explain', 'text'], ['now', 'text']])
    expect(judged[0].strokeIds).toEqual(f.map((s) => s.id))
    expect(judged[1].strokeIds).toEqual([d.id])
    // A dash at the end of the formula, and one before it.
    const end = judgeWords([...f, d], [w(0, 'a+b=1-', 0, 58, false)])[0]
    expect(end.map((j) => [j.word.text, j.kind])).toEqual([['a+b=1', 'math'], ['-', 'text']])
    const d0 = dash(0, 10), g = word(18, 4)
    const lead = judgeWords([d0, ...g], [w(0, '-x=y+1', 0, 60, false)])[0]
    expect(lead.map((j) => [j.word.text, j.kind])).toEqual([['-', 'text'], ['x=y+1', 'math']])
  })

  it('a dash next to maths stays text unless maths is on both sides', () => {
    const n = word(0, 2), d = dash(30, 40), x = word(60, 4)
    const ws = [w(0, 'n+1=2', 0, 17, false), w(0, '-', 30, 40, false), w(0, 'nice', 60, 95, true)]
    expect(kinds([...n, d, ...x], ws).map((k) => k[1])).toEqual(['math', 'text', 'text'])
  })

  it('a comma after a one-letter variable is split off', () => {
    const lead = word(0, 3), xx = word(40, 3), r = letter(70), comma = stroke([[80, 9], [79.5, 11], [78.5, 13]])
    const ws = [w(0, 'the', 0, 26, true), w(0, 'x+y=', 40, 66, false), w(0, 'r,', 70, 81, false)]
    const judged = judgeWords([...lead, ...xx, r, comma], ws)[0]
    expect(judged.map((j) => [j.word.text, j.kind])).toEqual([['the', 'text'], ['x+y=', 'math'], ['r', 'math'], [',', 'text']])
  })

  it('a single letter counts a script written after it, not a stroke over it', () => {
    const line = [...word(0, 3), ...word(40, 4)]
    const x = letter(80), sup = stroke([[89, -6], [91, -8], [93, -3]])
    expect(judgeWords([...line, x, sup], [w(0, 'the', 0, 26, true), w(0, 'from', 40, 75, true), w(0, 'x', 80, 94, true)])[0][2].kind).toBe('math')
    // A "T": its bar spans the letter.
    const stem = stroke([[84, 0], [84, 10]]), bar = stroke([[80, -4], [88, -4.5]])
    const t = judgeWords([...line, stem, bar], [w(0, 'the', 0, 26, true), w(0, 'from', 40, 75, true), w(0, 'T', 80, 88, true)])[0][2]
    expect(t.kind).toBe('text')
    // A variable letter left as text is asked about.
    expect(t.unsure).toBe(true)
  })

  it('"I" with a fraction bar is a fraction', () => {
    const line = [...word(0, 3), ...word(40, 4)]
    const one = stroke([[84, -14], [84, -4]]), bar = stroke([[78, -1], [92, -1.2]]), two = stroke([[80, 2], [88, 2], [80, 11], [88, 11]])
    const judged = judgeWords([...line, one, bar, two], [w(0, 'the', 0, 26, true), w(0, 'from', 40, 75, true), w(0, 'I', 78, 92, true)])
    expect(judged[0][2].kind).toBe('math')
  })
})
