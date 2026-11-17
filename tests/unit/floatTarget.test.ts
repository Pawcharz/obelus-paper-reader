import { describe, expect, it } from 'vitest'
import { findCaption, floatBox, floatOf, linkLabel, markLinks } from '../../src/shared/floatTarget'
import type { Rect } from '../../src/shared/types'

let index = 0
/** Words of one line, laid out left to right from x with ordinary spaces. */
function line(text: string, x: number, y: number, h = 10): { text: string; rect: Rect; index: number }[] {
  return text.split(' ').map((t) => {
    const w = { text: t, rect: [x, y, t.length * 5, h] as Rect, index: index++ }
    x += t.length * 5 + 3
    return w
  })
}
const bodyLine = (y: number) => line('the model observes the first two time steps and predicts the next', 55, y)

describe('floatOf', () => {
  it('names figures, tables and algorithms, sub-figures included', () => {
    expect(floatOf('Figure 2b')).toEqual({ kind: 'figure', num: '2b' })
    expect(floatOf('(Fig. 3)')).toEqual({ kind: 'figure', num: '3' })
    expect(floatOf('Table 1,')).toEqual({ kind: 'table', num: '1' })
    expect(floatOf('Algorithm 2.')).toEqual({ kind: 'algorithm', num: '2' })
  })
  it('leaves equations, sections and citations alone', () => {
    expect(floatOf('Equation 3')).toBeNull()
    expect(floatOf('Section 4')).toBeNull()
    expect(floatOf('algorithm 13')).toBeNull()
  })
})

describe('linkLabel', () => {
  it('adds the word before a link that is only a number', () => {
    const ws = line('as shown in Figure 2 we', 50, 100)
    const two = ws[4].rect
    expect(linkLabel(ws, two)).toBe('Figure 2')
  })
})

describe('floatBox', () => {
  // Like PlaNet page 4: a header, node labels of a diagram, sub-captions, a caption, then text.
  const page = [
    ...line('Learning Latent Dynamics for Planning from Pixels', 199, 47),
    ...line('a a', 412, 70, 6), ...line('h h h', 412, 103, 6), ...line('s s s', 264, 133, 6),
    ...line('(a) Deterministic model (RNN) (b) Stochastic model (SSM) (c) Recurrent model', 93, 185),
    ...line('Figure 2: Latent dynamics model designs. In this example, the model observes the', 55, 202),
    ...line('third. Circles represent stochastic variables and squares deterministic ones.', 55, 214),
    ...bodyLine(290), ...bodyLine(302), ...bodyLine(314)
  ]
  it('finds the caption, not a mention of the figure in the text', () => {
    const mention = line('as in Figure 2 we see', 55, 400)
    const cap = findCaption([...page, ...mention], 'figure', '2b', 61)
    expect(cap?.y0).toBe(202)
  })
  it('takes the whole figure with its caption, without the page header or the text after', () => {
    const cap = findCaption(page, 'figure', '2', 61)!
    const [, y0, , h] = floatBox(page, 'figure', cap, 792, 61)
    expect(y0).toBeGreaterThan(52)
    expect(y0).toBeLessThan(70)
    expect(y0 + h).toBeGreaterThanOrEqual(224)
    expect(y0 + h).toBeLessThan(290)
  })
  it('finds the top by itself when the link points at the caption', () => {
    const cap = findCaption(page, 'figure', '2', 200)!
    const [, y0] = floatBox(page, 'figure', cap, 792, 200)
    expect(y0).toBeGreaterThan(52)
    expect(y0).toBeLessThan(70)
  })
  it('takes an algorithm below its title, down to where its steps end', () => {
    const alg = [
      ...bodyLine(260), ...bodyLine(272),
      ...line('Algorithm 2: Latent planning with CEM', 55, 313),
      ...line('Input : H Planning horizon distance', 55, 330),
      ...line('1 Initialize factorized belief over action sequences', 47, 344),
      ...line('2 for optimization iteration i = 1..I do', 47, 358),
      ...line('3 return first action mean', 47, 372),
      ...line('12', 290, 740)
    ]
    const cap = findCaption(alg, 'algorithm', '2', 560)!
    const [, y0, , h] = floatBox(alg, 'algorithm', cap, 792, 560)
    expect(y0).toBeLessThanOrEqual(313)
    expect(y0).toBeGreaterThan(280)
    expect(y0 + h).toBeGreaterThanOrEqual(382)
    expect(y0 + h).toBeLessThan(400)
  })
})

describe('markLinks', () => {
  const ws = line('see Equation 3 and the rest of this sentence here', 50, 100)
  const eq: Rect = [ws[1].rect[0], 100, ws[2].rect[0] + ws[2].rect[2] - ws[1].rect[0], 10]
  const links = [{ rect: eq, id: 'eq' }]
  it('a mark that is nearly all link offers the link with the mark', () => {
    const r = markLinks(ws, links, [ws[1].rect, ws[2].rect])
    expect(r.links.map((l) => l.id)).toEqual(['eq'])
    expect(r.mostlyLinks).toBe(true)
  })
  it('a mark with plenty of other text leaves its links to their own taps', () => {
    const r = markLinks(ws, links, ws.map((w) => w.rect))
    expect(r.links).toHaveLength(1)
    expect(r.mostlyLinks).toBe(false)
  })
  it('a mark with no links has none', () => {
    expect(markLinks(ws, links, [ws[6].rect]).links).toHaveLength(0)
  })
})
