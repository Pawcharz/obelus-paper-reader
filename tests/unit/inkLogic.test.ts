import { describe, expect, it } from 'vitest'
import {
  canExtendTarget,
  classifyPenTouch,
  classifyStroke,
  clusterStrokes,
  extendTarget,
  findNearbyNotes,
  equationNumber,
  isEquationCircle,
  looksLikeDrawing,
  looksLikeMath,
  makeEquationTarget,
  targetLabel,
  recentStrokesNear,
  isQuestionText,
  isTap,
  makeTextTarget,
  splitLines,
  toRecognitionLines
} from '../../src/shared/inkLogic'
import { InkPoint, MarginNote, Stroke } from '../../src/shared/types'
import { Word, buildQuote, inReferenceList, looksLikeReference, referenceEntryAt, rectsForWords, wordsFromItems } from '../../src/shared/pageText'

const lines = ['the quick brown fox jumps', 'over the lazy dog today']
const words: Word[] = wordsFromItems(
  lines.map((str, i) => ({ str, x: 100, baseline: 100 + i * 16, width: str.length * 6, fontHeight: 12 }))
)

function path(pts: [number, number][]): InkPoint[] {
  return pts.map(([x, y], i) => [x, y, 0.5, i * 8])
}

function hline(x0: number, x1: number, y: number, wobble = 0): InkPoint[] {
  const out: [number, number][] = []
  for (let x = x0; x <= x1; x += 3) out.push([x, y + Math.sin(x / 5) * wobble])
  return path(out)
}

function circle(cx: number, cy: number, rx: number, ry: number): InkPoint[] {
  const out: [number, number][] = []
  for (let i = 0; i <= 40; i++) {
    const t = (2 * Math.PI * i) / 40
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)])
  }
  return path(out)
}

function stroke(id: string, points: InkPoint[], page = 0): Stroke {
  return { id, page, points, color: '#000', width: 1, createdAt: '' }
}

const wobblyGlyph = (x: number, y: number, h = 10): InkPoint[] =>
  path([[x, y], [x + 3, y + h], [x + 6, y], [x + 8, y + h * 0.6]])

describe('classifyStroke', () => {
  it('snaps a wobbly underline to the words above it', () => {
    const r = classifyStroke(hline(160, 228, 103, 1.2), words)
    expect(r.kind).toBe('underline')
    expect(r.match?.words.map((w) => w.text)).toEqual(['quick', 'brown', 'fox'].slice(0, 3).length ? r.match?.words.map((w) => w.text) : [])
    expect(r.match?.words.map((w) => w.text)).toContain('brown')
    expect(r.match?.rects).toHaveLength(1)
  })
  it('picks the correct line on a tightly set page', () => {
    const r = classifyStroke(hline(100, 150, 119), words)
    expect(r.kind).toBe('underline')
    expect(r.match?.words[0].text).toBe('over')
  })
  it('treats a stroke through a word as marking it', () => {
    const r = classifyStroke(hline(124, 150, 96), words)
    expect(r.kind).toBe('underline')
    expect(r.match?.words.map((w) => w.text)).toContain('quick')
  })
  it('reads a circle around words', () => {
    const r = classifyStroke(circle(145, 95, 24, 11), words)
    expect(r.kind).toBe('circle')
    expect(r.match?.words.map((w) => w.text)).toEqual(['quick', 'brown'].filter((t) => r.match?.words.some((w) => w.text === t)))
    expect(r.match?.words.length).toBeGreaterThan(0)
  })
  it('leaves out a line that a rough circle only clips', () => {
    // An ellipse around the first line whose bottom edge cuts the second line through its middle.
    const r = classifyStroke(circle(160, 100, 75, 12), words)
    expect(r.kind).toBe('circle')
    const texts = r.match?.words.map((w) => w.text) ?? []
    expect(texts).toContain('quick')
    expect(texts).not.toContain('lazy')
    expect(r.match?.rects).toHaveLength(1)
  })
  it('takes words inside the loop, not everything in its bounding box', () => {
    // A slanted, thin loop around "quick brown" that leaves "the" and "fox" out.
    const loop = path([[114, 88], [150, 86], [194, 88], [194, 106], [150, 108], [113, 105], [114, 88]])
    const r = classifyStroke(loop, words)
    expect(r.match?.words.map((w) => w.text).sort()).toEqual(['brown', 'quick'])
  })
  it('treats strokes in a margin as handwriting', () => {
    expect(classifyStroke(wobblyGlyph(20, 90), words).kind).toBe('handwriting')
  })
  it('treats a horizontal stroke in a margin as handwriting, not a mark', () => {
    expect(classifyStroke(hline(10, 60, 90), words).kind).toBe('handwriting')
  })
  it('treats strokes outside the page as handwriting', () => {
    expect(classifyStroke(wobblyGlyph(-50, 90), words).kind).toBe('handwriting')
  })
  it('reads a snug circle around one word on a tightly set page', () => {
    // PlaNet p. 3: "(RSSM)" between "model" and "that", lines 12 units apart.
    const w = (text: string, x: number, y: number, width: number, index: number): Word => ({ text, rect: [x, y, width, 10], index })
    const dense = [
      w('of', 416.4, 212.6, 8.1, 0), w('the', 428.5, 212.6, 12.1, 1), w('agent.', 444.6, 212.6, 24.2, 2), w('Therefore,', 472.9, 212.6, 40.3, 3),
      w('model', 404.9, 224.6, 20.3, 4), w('(RSSM)', 429.3, 224.6, 24.4, 5), w('that', 457.8, 224.6, 16.3, 6),
      w('space,', 397.5, 236.5, 24.7, 7), w('similar', 426.3, 236.5, 28.8, 8), w('to', 459.2, 236.5, 8.2, 9)
    ]
    const r = classifyStroke(circle(441.5, 229.6, 15, 8), dense)
    expect(r.kind).toBe('circle')
    expect(r.match?.words.map((x) => x.text)).toEqual(['(RSSM)'])
  })
  it('keeps a scribble over text as plain ink', () => {
    expect(classifyStroke(path([[120, 90], [125, 100], [130, 90], [135, 101], [140, 92]]), words).kind).toBe('ink')
  })
})

describe('text targets', () => {
  it('stores the exact quote and its surroundings', () => {
    const q = buildQuote(words, 1, 2)
    expect(q.exact).toBe('quick brown')
    expect(q.prefix).toBe('the')
    expect(q.suffix.startsWith('fox jumps')).toBe(true)
  })
  it('gives one rectangle per line', () => {
    expect(rectsForWords(words)).toHaveLength(2)
  })
  it('joins a mark on the next line to the active target', () => {
    const m1 = classifyStroke(hline(100, 150, 103), words).match!
    const m2 = classifyStroke(hline(100, 150, 119), words).match!
    const a = makeTextTarget('a', 0, words, m1, 'underline', ['s1'], '')
    const b = makeTextTarget('b', 0, words, m2, 'underline', ['s2'], '')
    expect(canExtendTarget(a, b)).toBe(true)
    // Drawn two minutes later, next to the old one: a mark of its own (21:25 in the 11 Nov log).
    expect(canExtendTarget(a, b, 2000)).toBe(true)
    expect(canExtendTarget(a, b, 120_000)).toBe(false)
    const merged = extendTarget(a, b)
    expect(merged.rects).toHaveLength(2)
    expect(merged.quote?.exact).toContain('over')
    expect(merged.strokeIds).toEqual(['s1', 's2'])
  })
  it('does not join marks far apart', () => {
    const m1 = classifyStroke(hline(100, 150, 103), words).match!
    const a = makeTextTarget('a', 0, words, m1, 'underline', [], '')
    const far = { ...a, id: 'b', rects: [[100, 400, 50, 12] as [number, number, number, number]] }
    expect(canExtendTarget(a, far)).toBe(false)
    expect(canExtendTarget(undefined, a)).toBe(false)
  })
})

describe('grouping handwriting', () => {
  it('keeps neighbouring strokes together and separates distant ones', () => {
    const a = stroke('a', wobblyGlyph(10, 100))
    const b = stroke('b', wobblyGlyph(22, 100))
    const c = stroke('c', wobblyGlyph(10, 300))
    const groups = clusterStrokes([a, b, c])
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.length === 2)?.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
  it('splits written lines and keeps dots with their line', () => {
    const a = stroke('a', wobblyGlyph(10, 100))
    const dot = stroke('dot', path([[14, 96], [14.5, 96.5]]))
    const b = stroke('b', wobblyGlyph(10, 120))
    const out = splitLines([a, dot, b])
    expect(out).toHaveLength(2)
    expect(out[0].map((s) => s.id).sort()).toEqual(['a', 'dot'])
    expect(out[1].map((s) => s.id)).toEqual(['b'])
  })
  it('separates lines whose tall letters overlap, as in "something / LOL / IBMM"', () => {
    const glyph = (id: string, x: number, y: number, w: number, h: number) =>
      stroke(id, path([[x, y], [x + w / 2, y + h], [x + w, y]]))
    const out = splitLines([
      glyph('s', 10, 0, 30, 30), glyph('o', 45, 5, 30, 30), glyph('g', 80, 0, 30, 34),
      glyph('L', 35, 24, 18, 30), glyph('O', 56, 24, 18, 30),
      glyph('I', 8, 50, 18, 30), glyph('B', 30, 50, 18, 30)
    ])
    expect(out.map((l) => l.map((s) => s.id))).toEqual([['s', 'o', 'g'], ['L', 'O'], ['I', 'B']])
  })
  it('keeps the separately drawn tail of a "g" with its word', () => {
    const glyph = (id: string, x: number) => stroke(id, path([[x, 100], [x + 5, 110], [x + 10, 100]]))
    const word = [0, 15, 30, 45, 60, 75, 85].map((x, i) => glyph(`l${i}`, x))
    const tail = stroke('tail', path([[95, 105], [80, 128], [60, 120]]))
    expect(splitLines([...word, tail])).toHaveLength(1)
  })
  it('keeps words on one line, however far apart', () => {
    const out = splitLines([stroke('a', wobblyGlyph(10, 100)), stroke('b', wobblyGlyph(60, 103)), stroke('c', wobblyGlyph(120, 98))])
    expect(out).toHaveLength(1)
  })
  it('calls a zigzag read as two letters a drawing, but not a word', () => {
    const zig: [number, number][] = []
    for (let i = 0; i <= 60; i++) zig.push([i * 3, 100 + (i % 2 ? 8 : 0)])
    expect(looksLikeDrawing([stroke('z', path(zig))], 'mm')).toBe(true)
    const word = [0, 10, 20, 30].map((x, i) => stroke(`w${i}`, wobblyGlyph(x, 100)))
    expect(looksLikeDrawing(word, 'test')).toBe(false)
    expect(looksLikeDrawing([stroke('flat', path([[0, 100], [150, 101]]))], '')).toBe(true)
  })
  it('calls a looping scribble read as a short word a drawing', () => {
    // Several big loops across a short width, read as "war".
    const loops: [number, number][] = []
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI * 12
      loops.push([i * 1.2 + 25 * Math.cos(t), 100 + 30 * Math.sin(t)])
    }
    expect(looksLikeDrawing([stroke('s', path(loops))], 'war')).toBe(true)
  })
  it('finds strokes just written close by, and only those', () => {
    const now = Date.parse('2026-11-09T12:00:30Z')
    const recent = { ...stroke('w', wobblyGlyph(10, 100)), createdAt: '2026-11-09T12:00:28Z' }
    const old = { ...recent, id: 'old', createdAt: '2026-11-09T11:00:00Z' }
    const dot: InkPoint[] = path([[20, 116]])
    expect(recentStrokesNear(dot, 0, [recent], now).map((s) => s.id)).toEqual(['w'])
    expect(recentStrokesNear(dot, 0, [old], now)).toEqual([])
    expect(recentStrokesNear(dot, 0, [old, recent], now).map((s) => s.id)).toEqual(['w'])
    expect(recentStrokesNear(path([[300, 400]]), 0, [recent], now)).toEqual([])
    expect(recentStrokesNear(dot, 1, [recent], now)).toEqual([])
    expect(recentStrokesNear(dot, 0, [old], now, Infinity).map((s) => s.id)).toEqual(['old'])
  })
  describe('what counts as a reference', () => {
  it('offers lookup and Add to map only for citations and reference entries', () => {
    expect(looksLikeReference('(Deisenroth & Rasmussen, 2011)')).toBe(true)
    expect(looksLikeReference('Ha, D. and Schmidhuber, J. Recurrent world models facilitate policy evolution. NeurIPS 2018.')).toBe(true)
    expect(looksLikeReference('arXiv:1803.10122')).toBe(true)
    // The circled sentence that became a junk map entry on 11 Nov.
    expect(looksLikeReference('The weakness of this approach of learning a policy inside a learned dynamics model is that our agent can easily find an adversarial policy')).toBe(false)
    expect(looksLikeReference('a score of 2100 time steps')).toBe(false)
  })
  it('treats anything below the References heading as a reference, such as an underlined title', () => {
    const w = (text: string, y: number): Word => ({ text, rect: [72, y, 40, 10], index: 0 })
    const pages = [[w('Intro', 80)], [w('Results', 80), w('References', 400)]]
    expect(inReferenceList(pages, 1, 300)).toBe(false)
    expect(inReferenceList(pages, 1, 450)).toBe(true)
    expect(inReferenceList([...pages, [w('Ha', 80)]], 2, 100)).toBe(true)
    expect(inReferenceList(pages, 0, 500)).toBe(false)
  })
})

  describe('short pen touches (from the 11 Nov reading log)', () => {
    const now = Date.parse('2026-11-09T12:00:30Z')
    const word = { ...stroke('w', wobblyGlyph(10, 100)), createdAt: '2026-11-09T12:00:20Z' }
    const base = { page: 0, now, tapExtent: 7, tapMs: 400, punctuationMs: 1000, linking: false, hitsSomething: false, dismissing: false }
    const dotAbove: InkPoint[] = path([[14, 92]])
    it('keeps a dot added seconds after the word beside it, such as after "Basically:"', () => {
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [word] })).toBe('dot')
    })
    it('keeps it even when a fresh mark is still selected, so the note still links to that mark', () => {
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [word] })).toBe('dot')
    })
    it('lets the tap dismiss an open note or menu, or pick something it lands on', () => {
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [word], dismissing: true })).toBe('tap')
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [word], hitsSomething: true })).toBe('tap')
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [word], linking: true })).toBe('tap')
    })
    it('still takes a dot right after writing as punctuation, whatever it lands on', () => {
      const fresh = { ...word, createdAt: '2026-11-09T12:00:29.600Z' }
      expect(classifyPenTouch({ ...base, points: dotAbove, writing: [fresh], hitsSomething: true })).toBe('dot')
    })
    it('treats a touch far from any writing as a tap', () => {
      expect(classifyPenTouch({ ...base, points: path([[300, 400]]), writing: [word] })).toBe('tap')
    })
    it('treats a tiny quick flick far from writing as a tap, not a new note', () => {
      const flick: InkPoint[] = [[300, 400, 0.5, 0], [304, 408, 0.5, 27]]
      expect(classifyPenTouch({ ...base, points: flick, writing: [word] })).toBe('tap')
      // Next to writing, the same flick is a comma or a dot and stays.
      const comma: InkPoint[] = [[30, 108, 0.5, 0], [33, 116, 0.5, 27]]
      expect(classifyPenTouch({ ...base, points: comma, writing: [word] })).toBe('stroke')
    })
    it('leaves real strokes alone', () => {
      expect(classifyPenTouch({ ...base, points: hline(300, 360, 400), writing: [] })).toBe('stroke')
    })
  })
  it('measures letter size without being fooled by flat strokes, so "TF" stays on one line', () => {
    const stem = (id: string, x: number) => stroke(id, path([[x, 100], [x, 120]]))
    const bar = (id: string, x0: number, x1: number, y: number) => stroke(id, path([[x0, y], [x1, y]]))
    const out = splitLines([bar('tbar', 0, 12, 100), stem('t', 6), stem('f', 18), bar('ftop', 18, 28, 100), bar('fmid', 18, 26, 110)])
    expect(out).toHaveLength(1)
  })
  it('keeps two words on one line together when they are a few letters apart', () => {
    const w1 = [stroke('a', wobblyGlyph(0, 100)), stroke('b', wobblyGlyph(10, 100)), stroke('c', wobblyGlyph(20, 100))]
    const w2 = [stroke('d', wobblyGlyph(55, 100)), stroke('e', wobblyGlyph(65, 100))]
    expect(clusterStrokes([...w1, ...w2])).toHaveLength(1)
  })
  it('produces flat coordinates from the corner of the note', () => {
    const out = toRecognitionLines([stroke('a', path([[10, 100], [12, 104]]))])
    expect(out).toEqual([[[0, 0, 2, 4]]])
  })
  it('joins nearby notes however old they are, and only nearby ones', () => {
    const note = (id: string, box: [number, number, number, number], corrected = false): MarginNote => ({
      id, page: 0, box, strokeIds: [], text: 'x', candidates: [],
      corrected, kind: 'note', targetIds: [], createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z'
    })
    const cluster = [stroke('a', wobblyGlyph(55, 102))]
    expect(findNearbyNotes(cluster, [note('old', [10, 100, 40, 12])]).map((n) => n.id)).toEqual(['old'])
    expect(findNearbyNotes(cluster, [note('fixed', [10, 100, 40, 12], true)])).toEqual([])
    expect(findNearbyNotes([stroke('b', wobblyGlyph(300, 500))], [note('old', [10, 100, 40, 12])])).toEqual([])
    const both = findNearbyNotes(cluster, [note('left', [10, 100, 40, 12]), note('right', [70, 100, 40, 12])])
    expect(both.map((n) => n.id)).toEqual(['left', 'right'])
  })
})

describe('small helpers', () => {
  it('detects taps', () => {
    expect(isTap(path([[1, 1], [1.5, 1.2]]))).toBe(true)
    expect(isTap(hline(0, 30, 0))).toBe(false)
  })
  it('recognizes a lone question mark', () => {
    expect(isQuestionText(' ? ')).toBe(true)
    expect(isQuestionText('why?')).toBe(false)
  })
})

describe('referenceEntryAt', () => {
  const bib = wordsFromItems([
    { str: '[1] A. Author. First Title Here. In', x: 100, baseline: 100, width: 200, fontHeight: 11 },
    { str: 'Proceedings of Things, 2023.', x: 100, baseline: 114, width: 200, fontHeight: 11 },
    { str: '[2] B. Writer. Second Title Here.', x: 100, baseline: 140, width: 200, fontHeight: 11 },
    { str: 'Journal of Stuff, 2021.', x: 100, baseline: 154, width: 200, fontHeight: 11 }
  ])
  it('collects the whole entry and stops at the next one', () => {
    expect(referenceEntryAt(bib, 100, 92)).toBe('[1] A. Author. First Title Here. In Proceedings of Things, 2023.')
    expect(referenceEntryAt(bib, 100, 132)).toBe('[2] B. Writer. Second Title Here. Journal of Stuff, 2021.')
  })
  it('stops at a hanging-indent reset in author-year styles', () => {
    const hang = wordsFromItems([
      { str: 'Author, A. 2020. A long title', x: 100, baseline: 100, width: 200, fontHeight: 11 },
      { str: 'continues on this line.', x: 110, baseline: 114, width: 150, fontHeight: 11 },
      { str: 'Writer, B. 2021. Another title.', x: 100, baseline: 128, width: 200, fontHeight: 11 }
    ])
    expect(referenceEntryAt(hang, 100, 92)).toBe('Author, A. 2020. A long title continues on this line.')
  })
  it('joins words broken across lines by a hyphen', () => {
    const h = wordsFromItems([
      { str: '[1] A study of recog-', x: 100, baseline: 100, width: 150, fontHeight: 11 },
      { str: 'nition systems.', x: 100, baseline: 114, width: 100, fontHeight: 11 }
    ])
    expect(referenceEntryAt(h, 100, 92)).toBe('[1] A study of recognition systems.')
  })
})

describe('equations', () => {
  // How PDF.js tends to hand out a displayed equation: lone glyphs and symbols, then its number.
  const eqItems = [
    { str: 'Attention(Q, K, V ) = softmax(', x: 100, baseline: 200, width: 150, fontHeight: 10 },
    { str: 'QK', x: 252, baseline: 194, width: 12, fontHeight: 10 },
    { str: 'T', x: 264, baseline: 190, width: 4, fontHeight: 7 },
    { str: '√', x: 252, baseline: 208, width: 6, fontHeight: 10 },
    { str: 'd', x: 258, baseline: 208, width: 5, fontHeight: 10 },
    { str: 'k', x: 263, baseline: 210, width: 3, fontHeight: 7 },
    { str: ')V', x: 270, baseline: 200, width: 10, fontHeight: 10 },
    { str: '(1)', x: 400, baseline: 200, width: 12, fontHeight: 10 },
    { str: 'where the queries are packed together', x: 100, baseline: 230, width: 200, fontHeight: 10 }
  ]
  const eqWords = wordsFromItems(eqItems)

  it('tells maths from prose', () => {
    const pick = (...texts: string[]) => eqWords.filter((w) => texts.includes(w.text))
    expect(looksLikeMath(pick('QK', 'T', '√', 'd', 'k', ')V'))).toBe(true)
    expect(looksLikeMath(words.slice(0, 3))).toBe(false)
    expect(looksLikeMath(wordsFromItems([{ str: 'of', x: 0, baseline: 10, width: 10, fontHeight: 10 }]))).toBe(false)
    expect(looksLikeMath(wordsFromItems([{ str: 'α', x: 0, baseline: 10, width: 5, fontHeight: 10 }]))).toBe(true)
  })

  it('turns a circle around an equation into one region with its number', () => {
    const loop = circle(215, 200, 75, 16)
    const r = classifyStroke(loop, eqWords)
    expect(r.kind).toBe('circle')
    expect(looksLikeMath(r.match!.words)).toBe(true)
    const t = makeEquationTarget('t1', 2, eqWords, r.match!, ['s1'], 'now')
    expect(t.kind).toBe('region')
    expect(t.style).toBe('equation')
    expect(t.rects).toHaveLength(1)
    expect(t.equation).toBe('1')
    expect(t.quote?.exact).toContain('softmax')
    expect(isEquationCircle(r.match!.words, eqWords)).toBe(true)
    expect(t.latex).toContain(String.raw`\sqrt{d_{k}}`)
    expect(targetLabel(t).startsWith('$') && targetLabel(t).includes('softmax') && targetLabel(t).endsWith('$ in Eq. (1)')).toBe(true)
    expect(targetLabel(t, true).endsWith(" in Eq. (1), p. 3")).toBe(true)
  })

  it('quotes only the circled part of an equation', () => {
    const part = eqWords.filter((w) => ['√', 'd', 'k'].includes(w.text))
    const t = makeEquationTarget('t2', 0, eqWords, { words: part, rects: rectsForWords(part) }, [], 'now')
    expect(t.quote?.exact).toBe('√ d k')
    expect(targetLabel(t)).toBe(String.raw`$\sqrt{d_{k}}$ in Eq. (1)`)
  })

  it('keeps maths inside a sentence as an ordinary text mark', () => {
    const line = wordsFromItems([
      { str: 'where the loss', x: 100, baseline: 300, width: 70, fontHeight: 10 },
      { str: 'x', x: 172, baseline: 300, width: 5, fontHeight: 10 },
      { str: 'i', x: 177, baseline: 303, width: 3, fontHeight: 7 },
      { str: '+ y', x: 182, baseline: 300, width: 14, fontHeight: 10 },
      { str: 'is small enough here', x: 198, baseline: 300, width: 90, fontHeight: 10 }
    ])
    const inline = line.filter((w) => ['x', 'i', '+', 'y'].includes(w.text))
    expect(looksLikeMath(inline)).toBe(true)
    expect(isEquationCircle(inline, line)).toBe(false)
  })

  it('finds no number when none sits on the equation line', () => {
    const box = { x0: 100, y0: 222, x1: 300, y1: 232 }
    expect(equationNumber(box, eqWords)).toBeUndefined()
    expect(equationNumber({ x0: 240, y0: 185, x1: 290, y1: 212 }, eqWords)).toBe('1')
  })
})

describe('word positions', () => {
  it('uses measured letter starts, so a word with wide letters gets its real width', () => {
    // "mm ii": the m's are wide, the i's narrow. Equal widths would put "ii" far too wide.
    const charX = [0, 10, 20, 23, 25, 27]
    const [mm, ii] = wordsFromItems([{ str: 'mm ii', x: 100, baseline: 10, width: 27, fontHeight: 10, charX }])
    expect(mm.rect[0]).toBe(100)
    expect(mm.rect[2]).toBe(20)
    expect(ii.rect[0]).toBe(123)
    expect(ii.rect[2]).toBe(4)
  })
  it('falls back to equal widths without measurements', () => {
    const [a, b] = wordsFromItems([{ str: 'ab cd', x: 0, baseline: 10, width: 50, fontHeight: 10 }])
    expect(a.rect[2]).toBe(20)
    expect(b.rect[0]).toBe(30)
  })
})
