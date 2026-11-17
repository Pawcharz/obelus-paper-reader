/**
 * Some ACM PDFs have ligatures with no text mapping, which arrive as U+FFFF. The letters around
 * one usually tell which ligature it was.
 */
export function repairLigatures(text: string): string {
  return text.replace(/\s*￿\s*(\p{L}*)/gu, (_, next: string) => {
    if (/^(ern|ent|ack|ing)/.test(next)) return `tt${next}`
    if (/^(us|ect|er|ic|or|set|in)/.test(next)) return `ff${next}`
    if (/^(ow|ex|uid|at|oat)/.test(next)) return `fl${next}`
    return `fi${next}`
  })
}

/** Picks the part of a bibliography entry that is most likely the title. */
export function guessTitle(reference: string): string {
  let text = repairLigatures(reference).replace(/\s+/g, ' ').trim()
  text = text.replace(/^\s*(\[[^\]]{1,12}\]|\(\d{1,3}\)|\d{1,3}[.)])\s*/, '')
  text = text.replace(/https?:\/\/\S+/g, ' ')

  // Quoted titles are unambiguous.
  const quoted = /[“"]([^”"]{12,})[”"]/.exec(text)
  if (quoted) return quoted[1].replace(/[.,]$/, '').trim()

  const parts = text
    .split(/\.\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Entries start with the authors, so the first part is never the title.
  const pool = parts.length > 1 ? parts.slice(1) : parts
  const candidates = pool.filter((p) => !looksLikeAuthors(p) && !looksLikeVenue(p))
  const best = candidates.find((p) => p.split(/\s+/).length >= 3) ?? candidates[0] ?? text
  return best.replace(/[.,]$/, '').trim()
}

function looksLikeAuthors(s: string): boolean {
  if (/\bet al\b/i.test(s)) return true
  if (/^\(?\d{4}[a-z]?\)?$/.test(s)) return true
  const pieces = s.split(/,| and | & /).map((p) => p.trim()).filter(Boolean)
  if (pieces.length < 2) {
    // A single author, such as "J. Smith".
    return /^([A-Z]\.\s*)+[A-Z][\w'-]+$/.test(s)
  }
  const nameLike = pieces.filter((p) => /^(and\s+)?\p{Lu}[\p{L}'.-]*(\s+\p{Lu}?[\p{L}'.-]*){0,3}$/u.test(p) && p.split(/\s+/).length <= 5)
  return nameLike.length / pieces.length >= 0.8
}

function looksLikeVenue(s: string): boolean {
  return (
    /^(in\s|proceedings|proc\.|arxiv|advances in|journal of|transactions on|ieee|acm|corr\b|preprint)/i.test(s) ||
    /arxiv preprint/i.test(s) ||
    /\bpp?\.\s*\d+/.test(s)
  )
}

/** Word-overlap score used to reject a lookup that returned the wrong paper. */
export function titleSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter(Boolean)
    )
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let common = 0
  for (const w of A) if (B.has(w)) common++
  return common / Math.max(A.size, B.size)
}
