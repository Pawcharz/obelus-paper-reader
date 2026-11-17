import { describe, expect, it } from 'vitest'
import { sortPapers } from '../../src/shared/librarySort'
import type { PaperEntry } from '../../src/shared/types'

const paper = (title: string, status: string, added: string, read_on = '', year = 2020): PaperEntry =>
  ({ folder: '', meta: { id: title, title, authors: [title], year, status, added, read_on, tags: [] } } as unknown as PaperEntry)

describe('library order', () => {
  const papers = [
    paper('Old unread', 'unread', '2026-11-01'),
    paper('Read long ago', 'read', '2026-10-01', '2026-10-05'),
    paper('Reading', 'reading', '2026-11-02'),
    paper('New unread', 'unread', '2026-11-10'),
    paper('Read yesterday', 'read', '2026-10-02', '2026-11-10')
  ]
  it('puts reading first, then read, then unread, each newest first', () => {
    expect(sortPapers(papers, 'status').map((p) => p.meta.title)).toEqual(['Reading', 'Read yesterday', 'Read long ago', 'New unread', 'Old unread'])
  })
  it('sorts by other columns, and reverses', () => {
    expect(sortPapers(papers, 'title').map((p) => p.meta.title)[0]).toBe('New unread')
    expect(sortPapers(papers, 'added').map((p) => p.meta.title)[0]).toBe('New unread')
    expect(sortPapers(papers, 'status', true).map((p) => p.meta.title)[0]).toBe('Old unread')
  })
})
