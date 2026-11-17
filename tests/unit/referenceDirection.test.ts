import { describe, expect, it } from 'vitest'
import { emptyMap, paperTime, referenceDirection, suggestReferenceEdge } from '../../src/shared/mapLogic'
import { authorsFromInfo, guessYear, parseAuthors, parseYear, yearFromPdfDate } from '../../src/shared/pdfDetails'

const worldModels = { year: 2018, arxiv: '1803.10122' }

describe('which way a suggested paper goes on a map', () => {
  it('reads the year and month from an arXiv number', () => {
    expect(paperTime({ arxiv: '1803.10122' })).toBeCloseTo(2018 + 2 / 12)
    expect(paperTime({ arxiv: 'cs/0101001' })).toBeCloseTo(2001)
    expect(paperTime({ year: 2015 })).toBe(2015.5)
    expect(paperTime({ text: 'MuZero (Schrittwieser et al., 2019)' })).toBe(2019.5)
    expect(paperTime({})).toBeNull()
  })

  it('puts earlier papers before and later ones after', () => {
    expect(referenceDirection({ arxiv: '1705.05363' }, worldModels)).toBe('earlier')
    expect(referenceDirection({ year: 2023, arxiv: '2301.04104' }, worldModels)).toBe('later')
    expect(referenceDirection({ text: '[DreamerV3](https://example.org/x.pdf)' }, worldModels)).toBe('unknown')
  })

  it('draws the arrow from the paper being read to later work', () => {
    const map = { ...emptyMap('m', 'World models'), nodes: [{ paperId: 'wm' }] }
    const later = suggestReferenceEdge(map, 'dreamer', { arxiv: '2301.04104' }, 'wm', worldModels)
    expect(later.edges).toEqual([expect.objectContaining({ from: 'wm', to: 'dreamer', status: 'suggested' })])
    const earlier = suggestReferenceEdge(map, 'icm', { arxiv: '1705.05363' }, 'wm', worldModels)
    expect(earlier.edges).toEqual([expect.objectContaining({ from: 'icm', to: 'wm' })])
    // A paper's own references are always earlier, so an unknown date counts as earlier.
    const unknown = suggestReferenceEdge(map, 'x', {}, 'wm', worldModels)
    expect(unknown.edges).toEqual([expect.objectContaining({ from: 'x', to: 'wm' })])
  })
})

describe('details of a PDF no lookup found', () => {
  it('reads authors from the PDF details, leaving out programs and accounts', () => {
    expect(authorsFromInfo('Christopher Olah')).toEqual(['Christopher Olah'])
    expect(authorsFromInfo('A. Smith; B. Jones and C. Lee')).toEqual(['A. Smith', 'B. Jones', 'C. Lee'])
    expect(authorsFromInfo('Administrator')).toEqual([])
    expect(authorsFromInfo('user123')).toEqual([])
  })

  it('takes the first year on the first page, else the year the file was made', () => {
    expect(guessYear('Understanding LSTM Networks Posted on August 27, 2015 ... (1997)', 'D:20180305')).toBe(2015)
    expect(guessYear('No year here', 'D:20180305120000')).toBe(2018)
    expect(yearFromPdfDate('garbage')).toBeNull()
  })

  it('reads typed authors and year', () => {
    expect(parseAuthors(' Christopher Olah , Someone Else ')).toEqual(['Christopher Olah', 'Someone Else'])
    expect(parseYear('2015')).toBe(2015)
    expect(parseYear('')).toBeNull()
    expect(parseYear('15')).toBeNull()
  })
})
