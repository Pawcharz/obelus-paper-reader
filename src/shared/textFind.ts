// ---- Find in side notes: counting matches, and placing them in the shown note ----

/** Where each match of `q` starts in `text`, ignoring letter case, one after another without overlap. */
export function matchStarts(text: string, q: string): number[] {
  const t = text.toLowerCase()
  const n = q.toLowerCase()
  const out: number[] = []
  if (!n) return out
  for (let at = t.indexOf(n); at >= 0; at = t.indexOf(n, at + n.length)) out.push(at)
  return out
}

/**
 * About the text a side note shows, from its Markdown: link targets, emphasis marks, heading and
 * list markers and math dollars left out, so Find counts what can be seen.
 */
export function shownText(title: string, body: string): string {
  const text = body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`+|\$+)/g, '')
    .replace(/(^|[^\w])[*_]([^*_\n]+)[*_](?=[^\w]|$)/g, '$1$2')
  return `${title}\n${text}`
}

/** A match in a run of text pieces: from piece `from[0]` at offset `from[1]` to piece `to[0]` at `to[1]` (exclusive). */
export interface PieceSpan { from: [number, number]; to: [number, number] }

/** The matches of `q` in pieces of text read one after another, as spans of pieces, so a match may cross pieces. */
export function matchSpans(pieces: string[], q: string): PieceSpan[] {
  const starts: number[] = []
  let all = ''
  for (const p of pieces) {
    starts.push(all.length)
    all += p
  }
  const at = (pos: number, end: boolean): [number, number] => {
    // The piece holding the position; an end lands at the end of the piece before rather than at 0 of the next.
    let i = 0
    while (i + 1 < pieces.length && (end ? starts[i + 1] < pos : starts[i + 1] <= pos)) i++
    return [i, pos - starts[i]]
  }
  return matchStarts(all, q).map((s) => ({ from: at(s, false), to: at(s + q.length, true) }))
}

// ---- Side-note links to a quote on a page: [Eq. 3](text:4:Training objective) ----

/** The page (counted from 1) and quote of a `text:<page>:<quote>` link; null when it is not one or is malformed. */
export function parseTextLink(href: string): { page: number; quote: string } | null {
  const m = /^text:\s*(\d+)\s*:(.+)$/is.exec(href.trim())
  if (!m) return null
  let quote = m[2]
  try { quote = decodeURIComponent(quote) } catch { /* left as written */ }
  quote = quote.trim()
  const page = Number.parseInt(m[1], 10)
  if (page < 1 || !quote || !/[\p{L}\p{N}]/u.test(quote)) return null
  return { page, quote }
}

/** Letters and digits only, lower case, with ligatures such as "ﬁ" spelled out. */
function letters(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * The words of a page that make up a quote, matched on letters and digits alone, so case, spaces,
 * punctuation and words hyphenated across a line break do not matter. Null when it is not there.
 */
export function findQuote<W extends { text: string; index: number }>(words: W[], quote: string): W[] | null {
  const q = letters(quote)
  if (!q) return null
  const sorted = [...words].sort((a, b) => a.index - b.index)
  let all = ''
  const owner: number[] = []
  sorted.forEach((w, i) => {
    const t = letters(w.text)
    all += t
    for (let k = 0; k < t.length; k++) owner.push(i)
  })
  const at = all.indexOf(q)
  if (at < 0) return null
  return sorted.slice(owner[at], owner[at + q.length - 1] + 1)
}

/**
 * The page (from 1) a link into another paper points at: `#page=N` in the address, as PDF viewers
 * use, or a page at the end of the link text, as in "World Models, p. 10". 0 when there is none.
 */
export function linkPage(text: string, url: string): number {
  const m = /#page=(\d+)/i.exec(url) ?? /\b(?:p|pp|page)\.?\s*(\d+)(?:\s*[-–]\s*\d+)?\s*\)?\s*$/i.exec(text.trim())
  const n = m ? Number(m[1]) : 0
  return n >= 1 && n < 10000 ? n : 0
}
