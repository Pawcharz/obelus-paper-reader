import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import katex from 'katex'
import { readableText, wordsToLatex } from '../../src/shared/mathText'
import { TextItemLike, Word, wordsFromItems } from '../../src/shared/pageText'

// Personal data, kept out of the public repository: these tests skip themselves without it.
const fixture = join(__dirname, '../fixtures/ibmm-equations.json')
const haveFixture = existsSync(fixture)
// Text items from the IBMM paper, page 4, around its equations (1) and (2), exactly as PDF.js gives them.
const items = (existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : []) as TextItemLike[]
const words = wordsFromItems(items)

/** The words whose middle lies inside a box, in reading order, as a circle would pick them. */
function inBox(x0: number, y0: number, x1: number, y1: number): Word[] {
  return words.filter((w) => {
    const cx = w.rect[0] + w.rect[2] / 2
    const cy = w.rect[1] + w.rect[3] / 2
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
  })
}

const renders = (tex: string) => expect(() => katex.renderToString(tex, { throwOnError: true })).not.toThrow()
const squash = (tex: string) => tex.replace(/\s+/g, '')

describe.skipIf(!haveFixture)('maths from PDF symbol positions', () => {
  it('rebuilds equation (1), with its sum limits, bars, fraction and big brackets', () => {
    const tex = wordsToLatex(inBox(360, 505, 500, 541))
    expect(squash(tex)).toBe(squash(String.raw`E_{i} = \sum_{n = 0}^{k - 1} \bar{p}_{n} - \left( \bar{p}_{0} + \frac{n}{k} \left( \bar{p}_{k - 1} - \bar{p}_{0} \right) \right)`))
    renders(tex)
  })

  it('rebuilds equation (2)', () => {
    const tex = wordsToLatex(inBox(360, 540, 512, 575))
    expect(squash(tex)).toBe(squash(String.raw`E_{o} = \sum_{n = k}^{N} \bar{p}_{n} - \left( \bar{p}_{k} + \frac{n - k}{N - k} \left( \bar{p}_{N} - \bar{p}_{k} \right) \right) ,`))
    renders(tex)
  })

  it('reads a circled fraction on its own as a fraction', () => {
    const tex = wordsToLatex(inBox(440, 544, 465, 568))
    expect(squash(tex)).toBe(squash(String.raw`\frac{n - k}{N - k}`))
    renders(tex)
  })

  it('reads part of an equation, a bracket with subscripts inside', () => {
    const tex = wordsToLatex(inBox(452, 515, 487, 532))
    expect(squash(tex)).toBe(squash(String.raw`\bar{p}_{k - 1} - \bar{p}_{0}`))
    renders(tex)
  })

  it('writes maths inside a sentence as $…$ and leaves the words as they are', () => {
    const line = words.filter((w) => Math.abs(w.rect[1] + w.rect[3] * 0.8 - 493.5) < 3 && w.rect[0] > 310)
    const text = readableText(line)
    expect(text).toBe(String.raw`$[ x_{i} ]_{i \geq N - k}$ of the motion. This can be formulated as follows.`)
    renders(text.slice(1, text.indexOf('$', 1)))
  })

  it('leaves plain prose alone', () => {
    const prose = wordsFromItems([{ str: 'the quick brown fox, et al. 2023.', x: 0, baseline: 10, width: 150, fontHeight: 10 }])
    expect(readableText(prose)).toBe('the quick brown fox, et al. 2023.')
  })
})

describe.skipIf(!haveFixture)('telling displayed equations from maths in a sentence, on the real page', () => {
  it('treats the sentence with [xᵢ] as text and equation (2) as an equation', async () => {
    const { isEquationCircle } = await import('../../src/shared/inkLogic')
    const inline = words.filter((w) => w.rect[0] > 310 && w.rect[0] < 360 && Math.abs(w.rect[1] + w.rect[3] * 0.8 - 493.5) < 3)
    expect(isEquationCircle(inline, words)).toBe(false)
    expect(isEquationCircle(inBox(440, 544, 465, 568), words)).toBe(true)
  })
})
