import { paperLabel, type PaperEntry } from './types'

export type SortKey = 'status' | 'name' | 'title' | 'authors' | 'year' | 'added'

/** Papers you are reading come first, then those you have read, then the rest. */
const STATUS_RANK: Record<string, number> = { reading: 0, read: 1, unread: 2 }

/**
 * Orders the library. By status, each status is newest first: read papers by when they were
 * finished, the others by when they were added. Other columns sort plainly, ties by title.
 * Descending reverses the whole order.
 */
export function sortPapers(papers: PaperEntry[], key: SortKey, descending = false): PaperEntry[] {
  const byTitle = (a: PaperEntry, b: PaperEntry) => a.meta.title.localeCompare(b.meta.title)
  const newest = (a: string, b: string) => (b || '').localeCompare(a || '')
  const compare = (a: PaperEntry, b: PaperEntry): number => {
    switch (key) {
      case 'status': {
        const r = (STATUS_RANK[a.meta.status] ?? 3) - (STATUS_RANK[b.meta.status] ?? 3)
        if (r) return r
        if (a.meta.status === 'read') return newest(a.meta.read_on, b.meta.read_on) || newest(a.meta.added, b.meta.added) || byTitle(a, b)
        return newest(a.meta.added, b.meta.added) || byTitle(a, b)
      }
      case 'title': return byTitle(a, b)
      case 'name': return paperLabel(a.meta).localeCompare(paperLabel(b.meta)) || byTitle(a, b)
      case 'authors': return (a.meta.authors[0] ?? '').localeCompare(b.meta.authors[0] ?? '') || byTitle(a, b)
      case 'year': return (a.meta.year ?? 0) - (b.meta.year ?? 0) || byTitle(a, b)
      case 'added': return newest(a.meta.added, b.meta.added) || byTitle(a, b)
    }
  }
  const out = [...papers].sort(compare)
  return descending ? out.reverse() : out
}
