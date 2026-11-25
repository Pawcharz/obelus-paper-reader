import { describe, expect, it } from 'vitest'
import {
  addPaperSuggestions, addPaperText, chosenSymbols, cleanMathLatex, combineReadings, emptyPaperSymbols, fontStyle, glyphSize,
  joinMathLines, LINE_BREAK, MATH_GLYPH_PX, mathImageLayout, mathNoteText, paperAlternatives, pickAlternative,
  segmentsLatex, segmentsToLatex, splitMathLines, uncertainCount
} from '../../src/shared/mathInk'

describe('two readings', () => {
  it('marks where the readings differ and offers the other version', () => {
    const segs = combineReadings('x _ { t , t } + 1', 'x _ { t } , t + 1')
    expect(segmentsLatex(segs)).toBe('x _ { t , t } + 1')
    expect(uncertainCount(segs)).toBeGreaterThan(0)
    const unsure = segs.filter((s) => s.why === 'readings')
    expect(unsure.every((s) => (s.alts ?? []).length === 1)).toBe(true)
  })
  it('agreeing readings are all certain', () => {
    expect(uncertainCount(combineReadings('a + b', 'a + b'))).toBe(0)
  })
  it('picking an alternative swaps it in and keeps the old one', () => {
    const segs = combineReadings('\\phi ( x )', '\\Phi ( x )')
    const i = segs.findIndex((s) => s.why === 'readings')
    const picked = pickAlternative(segs, i, '\\Phi')
    expect(segmentsLatex(picked)).toBe('\\Phi ( x )')
    expect(picked[i].alts).toContain('\\phi')
    expect(picked[i].picked).toBe(true)
  })
})

describe('paper symbols', () => {
  it('reads styles from TeX font names', () => {
    expect(fontStyle('RAZVEJ+MSBM10')).toBe('mathbb')
    expect(fontStyle('KFCAMB+CMSY10')).toBe('mathcal')
    expect(fontStyle('UVUOJU+CMBX10')).toBe('mathbf')
    expect(fontStyle('ANCPWH+CMMI10')).toBeNull()
  })
  const paper = () => {
    const p = emptyPaperSymbols()
    addPaperText(p, 'E E E', 'X+MSBM10')
    addPaperText(p, 'L L ≥ ∇', 'X+CMSY10')
    addPaperText(p, 'x z x', 'X+CMBX10')
    addPaperText(p, 'Θ Θ Θ θ', 'X+CMMI10')
    return p
  }
  it('suggests blackboard, calligraphic and Greek case, but not bold', () => {
    const p = paper()
    expect(paperAlternatives('E', p)).toEqual(['\\mathbb{E}'])
    expect(paperAlternatives('L', p)).toEqual(['\\mathcal{L}'])
    expect(paperAlternatives('x', p)).toEqual([])
    expect(paperAlternatives('\\theta', p)).toEqual(['\\Theta'])
    expect(paperAlternatives('\\Theta', p)).toEqual([])
  })
  it('only adds alternatives: what was read stays', () => {
    const segs = addPaperSuggestions([{ tex: 'E' }, { tex: '[' }, { tex: 'X' }, { tex: ']' }], paper())
    expect(segmentsLatex(segs)).toBe('E [ X ]')
    expect(segs[0]).toMatchObject({ tex: 'E', alts: ['\\mathbb{E}'], why: 'paper' })
  })
  it('ranks forms you used before first', () => {
    const p = paper()
    addPaperText(p, 'E E E E', 'X+EUSM10') // calligraphic E, more often than blackboard
    expect(paperAlternatives('E', p)[0]).toBe('\\mathcal{E}')
    expect(paperAlternatives('E', p, chosenSymbols(['$\\mathbb{E}[x]$']))[0]).toBe('\\mathbb{E}')
  })
})

describe('several written lines', () => {
  const box = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y1]] as [number, number][]
  const row = (y: number, n: number, x = 0) => Array.from({ length: n }, (_, i) => box(x + i * 15, y, x + i * 15 + 10, y + 10))
  it('splits a derivation into lines', () => {
    const ink = [...row(0, 8), ...row(30, 5, 40), ...row(60, 3, 40)]
    expect(splitMathLines(ink).length).toBe(3)
  })
  it('keeps a fraction together', () => {
    const ink = [...row(0, 3, 10), box(0, 18, 60, 20), ...row(28, 3, 10)]
    expect(splitMathLines(ink).length).toBe(1)
  })
  it('keeps limits under a big operator with it', () => {
    const ink = [box(0, 0, 30, 2), box(2, 2, 4, 40), box(26, 2, 28, 40), ...row(15, 2, 45), ...row(52, 2, 0)]
    expect(splitMathLines(ink).length).toBe(1)
  })
  it('joins lines aligned at their first relation', () => {
    expect(joinMathLines(['a = b + c', '= d'])).toBe('\\begin{aligned} a & = b + c \\\\ & = d \\end{aligned}')
    expect(joinMathLines(['a + b', 'c'])).toBe('\\begin{gathered} a + b \\\\ c \\end{gathered}')
    expect(segmentsToLatex([{ tex: 'x' }, { tex: '=' }, { tex: '1' }, LINE_BREAK, { tex: '=' }, { tex: '2' }]))
      .toBe('\\begin{aligned} x & = 1 \\\\ & = 2 \\end{aligned}')
  })
})

describe('cleanMathLatex', () => {
  // Real model outputs from the equation lab (lab/equation-recognition/benchmark).
  it('joins spaced letters into operators', () => {
    expect(cleanMathLatex('D _ { K L } ( P \\parallel Q ) = \\sum _ { x } P ( x ) l o g \\frac { P ( x ) } { Q ( x ) }'))
      .toBe('D _ { K L } ( P \\parallel Q ) = \\sum _ { x } P ( x ) \\log \\frac { P ( x ) } { Q ( x ) }')
    expect(cleanMathLatex('K = a r g m a x _ { i } \\Gamma _ { i }')).toBe('K = \\arg \\max _ { i } \\Gamma _ { i }')
    expect(cleanMathLatex('E L U ( x ) = m a x ( x , 0 )')).toBe('\\operatorname{ELU} ( x ) = \\max ( x , 0 )')
    expect(cleanMathLatex('[ l n p ( o ) ]')).toBe('[ \\ln p ( o ) ]')
  })
  it('snaps misspelled long names', () => {
    expect(cleanMathLatex('s o t t i m a x ( z )')).toBe('\\operatorname{softmax} ( z )')
    expect(cleanMathLatex('s o f t a n a x ( z )')).toBe('\\operatorname{softmax} ( z )')
    expect(cleanMathLatex('A t t e n t i o n ( Q )')).toBe('\\operatorname{Attention} ( Q )')
  })
  it('leaves words and products that are not operators alone', () => {
    expect(cleanMathLatex('L _ { s i m p l e } = E')).toBe('L _ { s i m p l e } = E')
    expect(cleanMathLatex('D _ { K L }')).toBe('D _ { K L }')
    expect(cleanMathLatex('O H ^ { o u t }')).toBe('O H ^ { o u t }')
    expect(cleanMathLatex('x ^ { 2 } + y ^ { 2 } = r ^ { 2 }')).toBe('x ^ { 2 } + y ^ { 2 } = r ^ { 2 }')
  })
  it('fixes primes, mod and a single-cell matrix', () => {
    expect(cleanMathLatex('W _ { 2 } ^ { \\prime } + b ^ { \\prime \\prime }')).toBe("W _ { 2 } ' + b ''")
    expect(cleanMathLatex('n - 1 ( m o d 4 )')).toBe('n - 1 \\pmod{4}')
    expect(cleanMathLatex('\\begin {matrix} \\frac { 1 } { 2 } \\end {matrix}')).toBe('\\frac { 1 } { 2 }')
    expect(cleanMathLatex('\\begin {matrix} a & b \\end {matrix}')).toBe('\\begin {matrix} a & b \\end {matrix}')
  })
  it('strips $ and think tags', () => {
    expect(cleanMathLatex('<think></think>$x + 1$')).toBe('x + 1')
  })
})

describe('math image layout', () => {
  const line = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y1]] as [number, number][]
  it('measures the typical glyph, not the long strokes', () => {
    const strokes = [line(0, 0, 10, 10), line(20, 0, 30, 10), line(40, 0, 50, 10), line(0, 20, 200, 20)]
    expect(glyphSize(strokes)).toBe(10)
  })
  it('scales glyphs to a constant size, whatever the length', () => {
    const short = [line(0, 0, 10, 10), line(0, 10, 10, 0)]
    const long = Array.from({ length: 30 }, (_, i) => line(i * 15, 0, i * 15 + 10, 10))
    const a = mathImageLayout(short)!, b = mathImageLayout(long)!
    // A glyph of 10 units becomes MATH_GLYPH_PX pixels in both.
    expect(b.map(10, 10)[0] - b.map(0, 0)[0]).toBeCloseTo(MATH_GLYPH_PX)
    expect(a.map(10, 10)[0] - a.map(0, 0)[0]).toBeCloseTo(MATH_GLYPH_PX)
    expect(a.width).toBeLessThan(100)
    expect(b.width).toBeGreaterThan(500)
  })
  it('caps very long ink at 2400 px wide', () => {
    const huge = Array.from({ length: 300 }, (_, i) => line(i * 15, 0, i * 15 + 10, 10))
    expect(mathImageLayout(huge)!.width).toBeLessThanOrEqual(2400)
  })
  it('returns nothing for no ink', () => {
    expect(mathImageLayout([])).toBeNull()
  })
})

describe('mathNoteText', () => {
  it('wraps LaTeX in $…$ on one line', () => {
    expect(mathNoteText('a\n+ b')).toBe('$a + b$')
    expect(mathNoteText('')).toBe('')
  })
})
