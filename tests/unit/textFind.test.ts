import { describe, expect, it } from 'vitest'
import { findQuote, linkPage, matchSpans, matchStarts, parseTextLink, shownText } from '../../src/shared/textFind'

describe('matchStarts', () => {
  it('finds every match, ignoring case, without overlaps', () => {
    expect(matchStarts('Sequences and sequences', 'sequences')).toEqual([0, 14])
    expect(matchStarts('aaaa', 'aa')).toEqual([0, 2])
    expect(matchStarts('abc', '')).toEqual([])
  })
})

describe('shownText', () => {
  it('leaves out what Markdown hides, so counts match what is seen', () => {
    const t = shownText('Notes', '## World model\n- see [the paper](https://x.org/world) and **world** models\n$x$')
    expect(matchStarts(t, 'world')).toHaveLength(2)
    expect(t).toContain('see the paper and world models')
  })
})

describe('matchSpans', () => {
  it('places a match inside one piece', () => {
    expect(matchSpans(['abc', 'def'], 'de')).toEqual([{ from: [1, 0], to: [1, 2] }])
  })
  it('places a match that crosses pieces, as with bold text in a sentence', () => {
    expect(matchSpans(['long ', 'sequences', ' here'], 'long sequences')).toEqual([{ from: [0, 0], to: [1, 9] }])
  })
  it('ends a match at the end of its piece, not at the start of the next', () => {
    expect(matchSpans(['ab', 'cd'], 'ab')).toEqual([{ from: [0, 0], to: [0, 2] }])
  })
})

describe('parseTextLink', () => {
  it('reads the page and the quote, which may hold colons', () => {
    expect(parseTextLink('text:4:Training objective')).toEqual({ page: 4, quote: 'Training objective' })
    expect(parseTextLink('text:12:Loss: the KL term')).toEqual({ page: 12, quote: 'Loss: the KL term' })
    expect(parseTextLink('text:4:Training%20objective')).toEqual({ page: 4, quote: 'Training objective' })
  })
  it('turns down malformed links', () => {
    expect(parseTextLink('text:0:x')).toBeNull()
    expect(parseTextLink('text:4:')).toBeNull()
    expect(parseTextLink('text:abc:x')).toBeNull()
    expect(parseTextLink('page:4')).toBeNull()
  })
})

describe('findQuote', () => {
  const ws = (s: string) => s.split(' ').map((text, index) => ({ text, index }))
  it('matches ignoring case, spaces and punctuation', () => {
    const page = ws('We define the training objective, as follows (3)')
    expect(findQuote(page, 'Training   Objective')?.map((w) => w.text)).toEqual(['training', 'objective,'])
  })
  it('matches a word hyphenated across a line break, and ligatures', () => {
    const page = ws('the ﬁnal objec- tive is')
    expect(findQuote(page, 'final objective')?.map((w) => w.index)).toEqual([1, 2, 3])
  })
  it('gives null when the quote is not on the page', () => {
    expect(findQuote(ws('nothing here'), 'world model')).toBeNull()
  })
})

describe('linkPage', () => {
  it('reads the page from the link text or the address', () => {
    expect(linkPage('World Models, p. 10', 'https://arxiv.org/abs/1803.10122')).toBe(10)
    expect(linkPage('Ha & Schmidhuber (2018), pp. 4–5', 'https://arxiv.org/abs/1803.10122')).toBe(4)
    expect(linkPage('World Models', 'https://arxiv.org/pdf/1803.10122#page=7')).toBe(7)
    expect(linkPage('page 3', 'https://x.org')).toBe(3)
  })
  it('finds no page in an ordinary reference', () => {
    expect(linkPage('PPO (Schulman et al., 2017)', 'https://arxiv.org/abs/1707.06347')).toBe(0)
    expect(linkPage('Amos et al., 2018', 'https://arxiv.org/abs/1804.06318')).toBe(0)
  })
})
