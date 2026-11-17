import type { Rect } from './types'

// ---- Figures, tables and algorithms: the whole float, found by its caption ----

interface TextWord { text: string; rect: Rect }

/** A run of words on one line, cut where a column gap or a wide space splits the line. */
export interface Segment { words: TextWord[]; x0: number; y0: number; x1: number; y1: number }

export type FloatKind = 'figure' | 'table' | 'algorithm'

/** The float a link names from its words, e.g. "Figure 2b" → figure 2; null for equations, sections and the rest. */
export function floatOf(label: string): { kind: FloatKind; num: string } | null {
  // Capitalised, as papers name their floats; "an algorithm [13]" is a citation.
  const m = /\b(Fig(?:ure)?s?|Tab(?:le)?s?|Alg(?:orithm)?s?|FIG(?:URE)?|TABLE|ALGORITHM)\.?\s*~?\s*([A-Z]?\d+[a-z]?)/.exec(label)
  if (!m) return null
  const k = m[1].toLowerCase()
  return { kind: k.startsWith('fig') ? 'figure' : k.startsWith('tab') ? 'table' : 'algorithm', num: m[2] }
}

/** The text a link covers, with the word just before it when the link is only a number ("Figure" + "2"). */
export function linkLabel(words: (TextWord & { index: number })[], rect: Rect): string {
  const inside = words.filter((w) => centreIn(w.rect, rect)).sort((a, b) => a.index - b.index)
  if (inside.length === 0) return ''
  const text = inside.map((w) => w.text).join(' ')
  if (/^\(?\d/.test(text)) {
    const before = words.find((w) => w.index === inside[0].index - 1)
    if (before) return `${before.text} ${text}`
  }
  return text
}

export function centreIn(r: Rect, box: Rect): boolean {
  const cx = r[0] + r[2] / 2
  const cy = r[1] + r[3] / 2
  return cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3]
}

export function segments(words: TextWord[]): Segment[] {
  const mid = (w: TextWord) => w.rect[1] + w.rect[3] / 2
  const sorted = [...words].sort((a, b) => mid(a) - mid(b))
  const lines: TextWord[][] = []
  for (const w of sorted) {
    const line = lines[lines.length - 1]
    if (line && Math.abs(mid(w) - mid(line[0])) < Math.min(w.rect[3], line[0].rect[3]) * 0.4) line.push(w)
    else lines.push([w])
  }
  const out: Segment[] = []
  for (const line of lines) {
    line.sort((a, b) => a.rect[0] - b.rect[0])
    let cur: TextWord[] = []
    const flush = () => {
      if (!cur.length) return
      out.push({
        words: cur,
        x0: Math.min(...cur.map((w) => w.rect[0])),
        y0: Math.min(...cur.map((w) => w.rect[1])),
        x1: Math.max(...cur.map((w) => w.rect[0] + w.rect[2])),
        y1: Math.max(...cur.map((w) => w.rect[1] + w.rect[3]))
      })
      cur = []
    }
    for (const w of line) {
      const prev = cur[cur.length - 1]
      // A space wider than a couple of letters: a column gap (often under 20 units), or a gap in an equation or table.
      if (prev && w.rect[0] - (prev.rect[0] + prev.rect[2]) > Math.max(w.rect[3], prev.rect[3]) * 1.2) flush()
      cur.push(w)
    }
    flush()
  }
  return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
}

const KEYWORD: Record<FloatKind, RegExp> = { figure: /^fig(ure)?\.?$/i, table: /^tab(le)?\.?$/i, algorithm: /^alg(orithm)?\.?$/i }

/** The caption line of a float: a line that starts with "Figure 2:" (or "Table 1.", "Algorithm 2"), nearest to `nearY`. */
export function findCaption(words: TextWord[], kind: FloatKind, num: string, nearY: number): Segment | null {
  const base = num.replace(/[a-z]$/, '')
  let best: Segment | null = null
  for (const s of segments(words)) {
    const [a, b] = s.words
    if (!a || !b || !KEYWORD[kind].test(a.text)) continue
    if (b.text.replace(/[:.]$/, '') !== base) continue
    // "Figure 2 shows…" in running text is not a caption: a caption's number ends in ":" or ".",
    // except an algorithm's, whose title often follows straight on.
    if (kind !== 'algorithm' && !/[:.]$/.test(b.text)) continue
    if (!best || Math.abs(s.y0 - nearY) < Math.abs(best.y0 - nearY)) best = s
  }
  return best
}

function overlapsX(s: Segment, x0: number, x1: number): boolean {
  return Math.min(s.x1, x1) - Math.max(s.x0, x0) > 0
}

/** A line of running text: enough real words, of letters, at about the caption's size. */
function texty(s: Segment, h: number): boolean {
  const ws = s.words.filter((w) => w.rect[3] >= h * 0.75)
  if (ws.length < 3) return false
  return ws.filter((w) => /[a-z]{2,}/i.test(w.text)).length / ws.length >= 0.6
}

function body(s: Segment, h: number, colW: number): boolean {
  return texty(s, h) && s.words.length >= 6 && s.x1 - s.x0 >= colW * 0.7
}

/**
 * The whole float around a caption, in page units: a figure above its caption (with the caption,
 * without the page's running header), an algorithm below its title, a table on whichever side of
 * its caption is not running text.
 */
export function floatBox(words: TextWord[], kind: FloatKind, caption: Segment, pageHeight: number, destY: number | null = null): Rect {
  const segs = segments(words)
  const h = caption.y1 - caption.y0
  const ci = segs.findIndex((s) => s.y0 === caption.y0 && s.x0 === caption.x0)
  // The caption's own paragraph.
  const para = [caption]
  for (let i = ci + 1; i < segs.length; i++) {
    const s = segs[i]
    const last = para[para.length - 1]
    if (!overlapsX(s, caption.x0, Math.max(...para.map((p) => p.x1)))) continue
    if (s.y0 - last.y1 > h * 0.8) break
    para.push(s)
  }
  let x0 = Math.min(...para.map((s) => s.x0))
  let x1 = Math.max(...para.map((s) => s.x1))
  let y0 = caption.y0
  let y1 = Math.max(...para.map((s) => s.y1))
  const colW = x1 - x0
  const header = pageHeight * 0.075
  const above = segs.filter((s) => s.y1 <= caption.y0 + 0.5 && overlapsX(s, x0, x1)).sort((a, b) => b.y0 - a.y0)
  const below = segs.filter((s) => s.y0 >= y1 - 0.5 && !para.includes(s)).sort((a, b) => a.y0 - b.y0)

  const takeAbove = () => {
    // A link that points well above the caption points at the float's top: trust it.
    if (destY !== null && destY < caption.y0 - h) {
      // …but never into the page's running header just above.
      const headerEnd = Math.max(0, ...above.filter((s) => s.y1 < header).map((s) => s.y1 + 3))
      const top = Math.max(headerEnd, destY - 8)
      for (const s of above) if (s.y0 >= top) { x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x1) }
      y0 = top
      return
    }
    // Otherwise up to the running text before the float, or the page's header.
    let top = 0
    for (let i = 0; i < above.length; i++) {
      const s = above[i]
      if (s.y1 < header) { top = s.y1 + 3; break }
      const prev = above[i + 1]
      const regular = prev && s.y0 - prev.y0 < h * 1.9
      if (regular && ((texty(s, h) && body(prev, h, colW)) || (body(s, h, colW) && texty(prev, h)))) { top = s.y1 + 3; break }
      x0 = Math.min(x0, s.x0)
      x1 = Math.max(x1, s.x1)
    }
    y0 = top
  }
  const takeBelow = (firstGap: number, maxGap: number, beside: (s: Segment) => boolean) => {
    let last = y1
    const near = below.filter(beside)
    for (let i = 0; i < near.length; i++) {
      const s = near[i]
      if (s.y0 - last > (i === 0 ? firstGap : maxGap)) break
      const next = near[i + 1]
      if (body(s, h, colW) && next && texty(next, h) && next.y0 - s.y0 < h * 1.9) break
      x0 = Math.min(x0, s.x0)
      x1 = Math.max(x1, s.x1)
      last = Math.max(last, s.y1)
    }
    y1 = last
  }

  if (kind === 'figure') takeAbove()
  else if (kind === 'algorithm') {
    // Its steps follow the title, closely spaced; numbered steps may start a little to its left.
    const left = caption.x0 - 30
    takeBelow(h * 1.5, h * 1.5, (s) => s.x0 >= left && s.x0 < caption.x0 + 250)
  } else {
    // A table whose link points well above its caption has its caption below it.
    const next = below.find((s) => overlapsX(s, x0, x1))
    const captionBelow = destY !== null && destY < caption.y0 - h * 2
    if (!captionBelow && next && !body(next, h, colW)) takeBelow(h * 5, h * 2.5, (s) => overlapsX(s, x0, x1))
    else takeAbove()
  }
  y0 = Math.max(0, y0 - 2)
  return [x0 - 4, y0, x1 - x0 + 8, y1 - y0 + 4]
}

// ---- A mark over links ----

/**
 * The links a mark covers, and whether they are most of it. When at least 30% of the marked text
 * is not a link, a tap on a link is for the link and a tap elsewhere for the mark; otherwise there
 * is hardly anywhere left to tap the mark, so one tap offers both.
 */
export function markLinks<L extends { rect: Rect }>(words: TextWord[], links: L[], rects: Rect[]): { links: L[]; mostlyLinks: boolean } {
  const inMark = words.filter((w) => rects.some((r) => centreIn(w.rect, r)))
  const area = (r: Rect) => r[2] * r[3]
  const linked = links.filter((l) => inMark.some((w) => centreIn(w.rect, l.rect)) || rects.some((r) => centreIn(l.rect, r)))
  if (linked.length === 0) return { links: [], mostlyLinks: false }
  let total: number
  let covered: number
  if (inMark.length) {
    total = inMark.reduce((s, w) => s + area(w.rect), 0)
    covered = inMark.filter((w) => linked.some((l) => centreIn(w.rect, l.rect))).reduce((s, w) => s + area(w.rect), 0)
  } else {
    total = rects.reduce((s, r) => s + area(r), 0)
    covered = linked.reduce((s, l) => s + area(l.rect), 0)
  }
  return { links: linked.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]), mostlyLinks: covered / total > 0.7 }
}
