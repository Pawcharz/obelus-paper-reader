import { Quote, Rect } from './types'

export interface Word {
  text: string
  rect: Rect
  /** Position in the page's reading order. */
  index: number
}

export interface TextItemLike {
  str: string
  /** Left, baseline Y from the top, width, font height; all in page units. */
  x: number
  baseline: number
  width: number
  fontHeight: number
  /**
   * Where each character starts, from 0 to width, measured with the font's real letter widths.
   * Without it, every character is taken to be equally wide, which puts word edges a letter off.
   */
  charX?: number[]
}

/** Splits PDF text runs into words, estimating positions from each run's width. */
export function wordsFromItems(items: TextItemLike[]): Word[] {
  const words: Word[] = []
  for (const item of items) {
    if (!item.str.trim() || item.width <= 0) continue
    const charW = item.width / item.str.length
    const at = (i: number) => (item.charX && item.charX.length === item.str.length + 1 ? item.charX[i] : i * charW)
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(item.str))) {
      const x0 = at(m.index)
      words.push({
        text: m[0],
        rect: [item.x + x0, item.baseline - item.fontHeight * 0.8, at(m.index + m[0].length) - x0, item.fontHeight],
        index: words.length
      })
    }
  }
  return words
}

export function bottom(r: Rect): number {
  return r[1] + r[3]
}

export function right(r: Rect): number {
  return r[0] + r[2]
}

/** One rectangle per text line covered by the words. */
export function rectsForWords(words: Word[]): Rect[] {
  const sorted = [...words].sort((a, b) => a.index - b.index)
  const rects: Rect[] = []
  for (const w of sorted) {
    const last = rects[rects.length - 1]
    if (last && Math.abs(bottom(last) - bottom(w.rect)) < 2.5 && w.rect[0] >= right(last) - 2) {
      last[2] = right(w.rect) - last[0]
      last[3] = Math.max(last[3], w.rect[3])
    } else {
      rects.push([...w.rect] as Rect)
    }
  }
  return rects
}

export function buildQuote(allWords: Word[], first: number, last: number, context = 32): Quote {
  const textOf = (from: number, to: number): string =>
    allWords.slice(from, to).map((w) => w.text).join(' ')
  return {
    exact: textOf(first, last + 1),
    prefix: textOf(Math.max(0, first - 12), first).slice(-context),
    suffix: textOf(last + 1, last + 13).slice(0, context)
  }
}

export function wordAt(words: Word[], x: number, y: number, pad = 2): Word | null {
  for (const w of words) {
    const [wx, wy, ww, wh] = w.rect
    if (x >= wx - pad && x <= wx + ww + pad && y >= wy - pad && y <= wy + wh + pad) return w
  }
  return null
}

/** The closest word, for when a selection drag ends between words. */
export function nearestWord(words: Word[], x: number, y: number, maxDistance = 30): Word | null {
  let best: Word | null = null
  let bestD = maxDistance
  for (const w of words) {
    const [wx, wy, ww, wh] = w.rect
    const dx = Math.max(wx - x, 0, x - (wx + ww))
    const dy = Math.max(wy - y, 0, y - (wy + wh))
    const d = dy * 3 + dx
    if (d < bestD) {
      bestD = d
      best = w
    }
  }
  return best
}

interface Line {
  words: Word[]
  x0: number
  baseline: number
}

function linesFrom(words: Word[]): Line[] {
  const lines: Line[] = []
  for (const w of words) {
    const last = lines[lines.length - 1]
    const base = bottom(w.rect)
    const h = w.rect[3]
    // Accents can be separate items that sit slightly higher and overlap their letter.
    if (last && Math.abs(last.baseline - base) < h * 0.6 && w.rect[0] >= right(last.words[last.words.length - 1].rect) - h * 1.5) {
      last.words.push(w)
    } else {
      lines.push({ words: [w], x0: w.rect[0], baseline: base })
    }
  }
  return lines
}

/**
 * Finds the bibliography entry at a link's destination. Entries end at the next numbered item,
 * at a hanging-indent reset, or at a vertical gap.
 */
export function referenceEntryAt(words: Word[], destX: number | null, destY: number | null): string {
  if (words.length === 0) return ''
  const y = destY ?? 0
  const x = destX ?? 0
  // A link lands at the top of its entry, right at the bottom edge of the line before it,
  // so the first line whose middle is below the landing point is the start of the entry.
  const startWord = words.find(
    (w) => w.rect[1] + w.rect[3] / 2 >= y - 1 && (destX === null || (w.rect[0] >= x - 8 && w.rect[0] <= x + 60))
  )
  if (!startWord) return ''
  const lines = linesFrom(words.slice(startWord.index))
  const collected: Line[] = [lines[0]]
  const numbered = /^(\[\d{1,4}\]|\d{1,4}\.)$/
  let spacing = 0
  for (let i = 1; i < lines.length && collected.length < 8; i++) {
    const line = lines[i]
    const prev = collected[collected.length - 1]
    if (numbered.test(line.words[0].text)) break
    if (line.baseline <= prev.baseline) break
    const gap = line.baseline - prev.baseline
    if (spacing && gap > spacing * 1.5) break
    if (!spacing) {
      const fontH = prev.words[0].rect[3]
      if (gap > fontH * 2.2) break
      spacing = gap
    }
    const first = collected[0]
    if (collected.length >= 2) {
      const hanging = collected[1].x0 > first.x0 + 3
      if (hanging && Math.abs(line.x0 - first.x0) < 2) break
    }
    collected.push(line)
  }
  return collected.map((l) => l.words.map((w) => w.text).join(' ')).join(' ').replace(/- (?=[a-z])/g, '')
}

/**
 * Marked text that could be a reference: a citation such as "(Ha & Schmidhuber, 2018)", a
 * bibliography entry, an arXiv id or a DOI. Plain prose, such as a circled sentence, is not.
 */
export function looksLikeReference(text: string): boolean {
  if (/\b(arxiv|doi)\b|\b\d{4}\.\d{4,5}\b|10\.\d{4,}\//i.test(text)) return true
  return /\b(19[5-9]\d|20[0-4]\d)[a-z]?\b/.test(text) && /[A-Z][\p{L}'-]+/u.test(text)
}

/** Whether a spot lies in the reference list: after a "References" or "Bibliography" heading on this page or an earlier one. */
export function inReferenceList(pages: (Word[] | undefined)[], page: number, y: number): boolean {
  for (let p = 0; p <= page; p++) {
    const heading = pages[p]?.find((w) => /^(references|bibliography)$/i.test(w.text.replace(/[^\p{L}]/gu, '')))
    if (heading && (p < page || heading.rect[1] < y)) return true
  }
  return false
}
