import { describe, expect, it } from 'vitest'
import { editDistance, suggestTags, tagKey } from '../../src/shared/tags'
import { sortPapers } from '../../src/shared/librarySort'
import { paperLabel, type PaperEntry } from '../../src/shared/types'

const all = ['world-models', 'rl-for-llms', 'interpretability', 'learning-dynamics', 'animation']

describe('tag suggestions', () => {
  it('treats case, spaces, underscores and dashes alike', () => {
    expect(tagKey(' World_Models ')).toBe('world-models')
    expect(tagKey('world  models')).toBe('world-models')
  })

  it('completes from the start of a tag, then from inside it', () => {
    expect(suggestTags('world-mo', all).complete).toEqual(['world-models'])
    expect(suggestTags('World Mo', all).complete).toEqual(['world-models'])
    expect(suggestTags('dyn', all).complete).toEqual(['learning-dynamics'])
    expect(suggestTags('', all)).toEqual({ complete: [], didYouMean: [] })
  })

  it('offers near misses separately, for typos', () => {
    const s = suggestTags('wrold-models', all)
    expect(s.complete).toEqual([])
    expect(s.didYouMean).toEqual(['world-models'])
    // A typo early in a word that is still being typed.
    expect(suggestTags('wrold', all).didYouMean).toContain('world-models')
    expect(suggestTags('zzzz', all)).toEqual({ complete: [], didYouMean: [] })
  })

  it('leaves out tags the paper already has', () => {
    expect(suggestTags('world', all, ['World Models']).complete).toEqual([])
  })

  it('counts a swap of two letters as one typo', () => {
    expect(editDistance('wrold', 'world')).toBe(1)
  })
})

describe('short names', () => {
  const paper = (title: string, short_name = ''): PaperEntry => ({
    folder: '', meta: { id: title, title, short_name, authors: [], year: null, venue: '', arxiv: '', doi: '', url: '', tags: [], status: 'unread', read_on: '', added: '', has_pdf: true }
  })

  it('shows the short name instead of the title when there is one', () => {
    expect(paperLabel({ title: 'Mastering Diverse Domains through World Models', short_name: 'DreamerV3' })).toBe('DreamerV3')
    expect(paperLabel({ title: 'World Models', short_name: '  ' })).toBe('World Models')
  })

  it('sorts by the name shown', () => {
    const out = sortPapers([paper('Mastering Diverse Domains through World Models', 'DreamerV3'), paper('Curiosity-driven Exploration')], 'name')
    expect(out.map((p) => paperLabel(p.meta))).toEqual(['Curiosity-driven Exploration', 'DreamerV3'])
  })
})
