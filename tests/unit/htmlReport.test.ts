import { describe, expect, it } from 'vitest'
import { CONTENT_WIDTH_PX, PAGE_MARGIN_IN, isHtmlFile, pageSizeInches, titleFromHtml } from '../../src/shared/htmlReport'

describe('isHtmlFile', () => {
  it('accepts .html and .htm in any case, nothing else', () => {
    expect(isHtmlFile('C:\\r\\Report.HTML')).toBe(true)
    expect(isHtmlFile('a.htm')).toBe(true)
    expect(isHtmlFile('a.pdf')).toBe(false)
    expect(isHtmlFile('a.html.pdf')).toBe(false)
  })
})

describe('pageSizeInches', () => {
  it('fits the normal content width plus margins, in A4 proportions', () => {
    const s = pageSizeInches(CONTENT_WIDTH_PX)
    expect(s.width).toBeCloseTo(CONTENT_WIDTH_PX / 96 + 2 * PAGE_MARGIN_IN, 2)
    expect(s.height / s.width).toBeCloseTo(Math.SQRT2, 2)
  })
  it('grows for wide content and never shrinks below the normal width', () => {
    expect(pageSizeInches(2400).width).toBeGreaterThan(pageSizeInches(CONTENT_WIDTH_PX).width)
    expect(pageSizeInches(300)).toEqual(pageSizeInches(CONTENT_WIDTH_PX))
    expect(pageSizeInches(NaN)).toEqual(pageSizeInches(CONTENT_WIDTH_PX))
  })
  it('stays within the size PDF viewers accept', () => {
    const s = pageSizeInches(100000)
    expect(s.width).toBeLessThanOrEqual(200)
    expect(s.height).toBeLessThanOrEqual(200)
  })
})

describe('titleFromHtml', () => {
  it('uses <title>, decoding entities and dropping tags', () => {
    expect(titleFromHtml('<html><head><title>  Run 42 &amp; ablations &#8212; v2 </title></head><h1>X</h1>')).toBe('Run 42 & ablations — v2')
  })
  it('falls back to the first <h1>, then to nothing', () => {
    expect(titleFromHtml('<title></title><h1 class="t">Loss <em>curves</em></h1>')).toBe('Loss curves')
    expect(titleFromHtml('<p>no title</p>')).toBe('')
  })
})
