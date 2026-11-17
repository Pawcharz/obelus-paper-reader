/** Suggestions while typing a tag: tags that start with or contain what was typed, and near misses. */

/** A tag compared without case, and with spaces, underscores and dashes counted as the same. */
export function tagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_\-]+/g, '-')
}

/** Letters to add, drop, change or swap to turn one word into the other. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

export interface TagSuggestions {
  /** Tags that start with, or contain, what was typed: the first is picked by Enter. */
  complete: string[]
  /** Tags close to what was typed, as if mistyped: only offered, never picked by Enter. */
  didYouMean: string[]
}

/** Existing tags to offer for the typed text, leaving out tags the paper already has. */
export function suggestTags(typed: string, all: string[], have: string[] = []): TagSuggestions {
  const q = tagKey(typed)
  if (!q) return { complete: [], didYouMean: [] }
  const owned = new Set(have.map(tagKey))
  const pool = [...new Set(all)].filter((t) => !owned.has(tagKey(t)))
  const starts = pool.filter((t) => tagKey(t).startsWith(q))
  const contains = pool.filter((t) => !tagKey(t).startsWith(q) && tagKey(t).includes(q))
  const complete = [...starts.sort((a, b) => a.length - b.length || a.localeCompare(b)), ...contains.sort()].slice(0, 6)
  const allowed = q.length <= 3 ? 1 : 2
  const near = pool
    .filter((t) => !complete.includes(t))
    .map((t) => {
      const k = tagKey(t)
      // Mid-word typos count too: "wrold" against the start of "world-models".
      const whole = editDistance(q, k)
      const start = q.length >= 3 ? editDistance(q, k.slice(0, q.length)) : whole
      return { t, d: Math.min(whole, start) }
    })
    .filter((x) => x.d <= allowed)
    .sort((a, b) => a.d - b.d || a.t.localeCompare(b.t))
    .slice(0, 3)
    .map((x) => x.t)
  return { complete, didYouMean: near }
}
