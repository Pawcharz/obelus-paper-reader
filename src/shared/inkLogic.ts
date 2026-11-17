import { InkPoint, MarginNote, Rect, Stroke, Target } from './types'
import { bottom, buildQuote, rectsForWords, right, Word } from './pageText'
import { hasMath, readableText, wordsToLatex } from './mathText'

export type StrokeKind = 'underline' | 'circle' | 'handwriting' | 'ink'

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function boxOf(points: InkPoint[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

export function unionBoxes(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1))
  }
}

export function boxToRect(b: Box): Rect {
  return [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0]
}

function rectToBox(r: Rect): Box {
  return { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] }
}

function intersects(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
}

function inflate(b: Box, dx: number, dy: number): Box {
  return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy }
}

function onTextFraction(points: InkPoint[], words: Word[]): number {
  if (points.length === 0 || words.length === 0) return 0
  let hits = 0
  for (const [x, y] of points) {
    for (const w of words) {
      const [wx, wy, ww, wh] = w.rect
      if (x >= wx - 2 && x <= wx + ww + 2 && y >= wy - 1 && y <= wy + wh + wh * 0.6) {
        hits++
        break
      }
    }
  }
  return hits / points.length
}

export interface MarkMatch {
  words: Word[]
  rects: Rect[]
}

function matchUnderline(points: InkPoint[], words: Word[]): MarkMatch | null {
  const b = boxOf(points)
  const y = (b.y0 + b.y1) / 2
  const candidates = words
    .map((w) => {
      const overlap = Math.min(b.x1, right(w.rect)) - Math.max(b.x0, w.rect[0])
      return { w, overlap, d: Math.abs(y - bottom(w.rect)) }
    })
    .filter(
      ({ w, overlap, d }) =>
        overlap >= w.rect[2] * 0.4 && d <= w.rect[3] * 0.9 && y >= w.rect[1] + w.rect[3] * 0.3
    )
  if (candidates.length === 0) return null
  const best = candidates.reduce((a, c) => (c.d < a.d ? c : a))
  const lineWords = candidates
    .filter((c) => Math.abs(bottom(c.w.rect) - bottom(best.w.rect)) < 2.5)
    .map((c) => c.w)
  return { words: lineWords, rects: rectsForWords(lineWords) }
}

/** Ends near where it started after travelling around, unlike an underline that goes one way. */
function isClosedLoop(points: InkPoint[]): boolean {
  if (points.length < 8) return false
  const b = boxOf(points)
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  if (h < 6) return false
  const first = points[0]
  const last = points[points.length - 1]
  let length = 0
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return Math.hypot(first[0] - last[0], first[1] - last[1]) <= Math.hypot(w, h) * 0.3 && length > 1.6 * w
}

/** Whether a point lies inside a drawn loop, treating the stroke as closed. */
function insideLoop(points: InkPoint[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function matchCircle(points: InkPoint[], words: Word[]): MarkMatch | null {
  const b = boxOf(points)
  const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0)
  const first = points[0]
  const last = points[points.length - 1]
  if (diag < 8 || Math.hypot(first[0] - last[0], first[1] - last[1]) > diag * 0.3) return null
  // A word counts when most of it lies inside the drawn loop itself, not just inside the loop's
  // bounding box, so a rough circle that clips the edge of a line leaves that line out.
  const enclosed = words.filter((w) => {
    const [wx, wy, ww, wh] = w.rect
    let inside = 0
    let total = 0
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        total++
        if (insideLoop(points, wx + (ww * (i + 0.5)) / 5, wy + (wh * (j + 0.5)) / 3)) inside++
      }
    }
    return inside / total >= 0.6
  })
  if (enclosed.length === 0) return null
  return { words: enclosed, rects: rectsForWords(enclosed) }
}

function isHorizontal(points: InkPoint[]): boolean {
  const b = boxOf(points)
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  return w >= 8 && h <= Math.max(6, w * 0.18)
}

/**
 * Whether a loop runs around the words it encloses rather than through them, as a scribble over
 * text does. Only the enclosed words count: a snug circle on a tightly set page passes over the
 * lines above and below and the words beside it, and that does not make it a scribble.
 */
function goesAround(points: InkPoint[], loop: MarkMatch): boolean {
  let through = 0
  for (const [x, y] of points) {
    if (loop.words.some(({ rect: [wx, wy, ww, wh] }) => x > wx + ww * 0.15 && x < wx + ww * 0.85 && y > wy + wh * 0.2 && y < wy + wh * 0.8)) through++
  }
  return through / points.length < 0.4
}

export interface Classified {
  kind: StrokeKind
  match?: MarkMatch
}

/** Spec section 4: where a stroke is decides what it means. */
export function classifyStroke(points: InkPoint[], words: Word[]): Classified {
  // A loop around a whole line is wide and flat, which looks horizontal, but it ends where it began.
  if (isClosedLoop(points)) {
    const loop = matchCircle(points, words)
    if (loop && goesAround(points, loop)) return { kind: 'circle', match: loop }
  }
  if (isHorizontal(points)) {
    const match = matchUnderline(points, words)
    if (match) return { kind: 'underline', match }
  }
  const circle = matchCircle(points, words)
  if (circle && goesAround(points, circle)) return { kind: 'circle', match: circle }
  return onTextFraction(points, words) < 0.25 ? { kind: 'handwriting' } : { kind: 'ink' }
}

/** Short words of ordinary prose, so a circled "of" or "is" is not taken for a variable. */
const SHORT_WORDS = new Set(['a', 'i', 'an', 'of', 'in', 'on', 'to', 'is', 'as', 'at', 'be', 'by', 'we', 'or', 'if', 'it', 'so', 'no', 'do', 'he', 'up'])
const MATH_CHAR = /[=+−×·÷∑∏∫∂∇√∞≤≥≈≠≡∝∈∉⊂⊆⊃∪∩∀∃→←↦⇒⇔^_|‖⟨⟩{}[\]/*<>~Ͱ-Ͽ∀-⋿⟀-⟯⦀-⫿]|[\u{1d400}-\u{1d7ff}]/u

/** One token of PDF text looks like maths: a symbol, a Greek letter, or a lone short variable. */
function mathToken(text: string): boolean {
  const t = text.replace(/[.,;:]+$/, '')
  if (t === '') return false
  if (t === '-' || t === '(' || t === ')') return true
  if (MATH_CHAR.test(t)) return true
  const bare = t.replace(/[()]/g, '')
  return bare.length > 0 && bare.length <= 2 && !SHORT_WORDS.has(bare.toLowerCase())
}

/**
 * Whether the words a loop encloses are mostly maths. PDFs store equations as scattered glyphs,
 * so they come out as many one-letter tokens and symbols rather than words of prose.
 */
export function looksLikeMath(words: Word[]): boolean {
  if (words.length === 0) return false
  const maths = words.filter((w) => mathToken(w.text)).length
  return maths >= 1 && maths / words.length >= 0.5
}

/**
 * Whether a word sits on a displayed equation: a line of its own made mostly of maths, rather than
 * a formula inside a sentence. Everything at the word's height across the page counts as its line.
 */
export function onDisplayLine(word: Word, allWords: Word[]): boolean {
  // Widened by half a height each way, so a small subscript still finds the sentence it sits in.
  const top = word.rect[1] - word.rect[3] / 2
  const bottomY = word.rect[1] + word.rect[3] * 1.5
  const line = allWords.filter((w) => {
    const cy = w.rect[1] + w.rect[3] / 2
    return cy >= top && cy <= bottomY && !EQUATION_NUMBER.test(w.text)
  })
  if (line.length === 0) return false
  const width = (ws: Word[]) => ws.reduce((sum, w) => sum + w.rect[2], 0)
  // Plain words only: "softmax(" or "Attention(Q," are names inside the maths, not prose.
  const prose = line.filter((w) => /^[A-Za-z]{3,}[.,;:]?$/.test(w.text))
  // A displayed equation has at most a word or two, like "where" or "for all".
  return prose.length <= 2 || width(prose) / Math.max(width(line), 1e-6) < 0.25
}

/**
 * A circle becomes an equation box only around a displayed equation, or part of one. Maths inside
 * a sentence stays an ordinary text mark, so its quote reads like the sentence.
 */
export function isEquationCircle(words: Word[], allWords: Word[]): boolean {
  if (!looksLikeMath(words)) return false
  const display = words.filter((w) => onDisplayLine(w, allWords)).length
  return display / words.length > 0.5
}

const EQUATION_NUMBER = /^\((\d+(?:\.\d+)*[a-z]?)\)[.,]?$/

/**
 * The number of a displayed equation, such as "(3)" or "(2.1)", written on the same line as the
 * equation, inside the loop or to its right.
 */
export function equationNumber(box: Box, allWords: Word[]): string | undefined {
  const mid = (box.y0 + box.y1) / 2
  const found = allWords
    .map((w) => ({ w, m: EQUATION_NUMBER.exec(w.text) }))
    .filter(({ w, m }) => {
      if (!m) return false
      const cy = w.rect[1] + w.rect[3] / 2
      return cy >= box.y0 - 2 && cy <= box.y1 + 2 && right(w.rect) >= box.x0
    })
    .sort((a, b) => Math.abs(a.w.rect[1] + a.w.rect[3] / 2 - mid) - Math.abs(b.w.rect[1] + b.w.rect[3] / 2 - mid))
  return found[0]?.m?.[1]
}

/**
 * A circle around maths becomes one equation region instead of a mark per glyph: a single box,
 * a quote kept for searching, the equation number when there is one, and later a picture.
 */
export function makeEquationTarget(
  id: string,
  page: number,
  allWords: Word[],
  match: MarkMatch,
  strokeIds: string[],
  createdAt: string
): Target {
  const box = inflate(unionBoxes(match.rects.map(rectToBox)), 2, 2)
  const indexes = match.words.map((w) => w.index)
  const number = equationNumber(box, allWords)
  const around = buildQuote(allWords, Math.min(...indexes), Math.max(...indexes))
  // Only what was circled, so part of an equation quotes that part, not the glyphs between.
  const circled = [...match.words].sort((a, b) => a.index - b.index)
  const exact = circled.map((w) => w.text).join(' ')
  const latex = wordsToLatex(circled)
  return {
    id,
    kind: 'region',
    page,
    quote: { ...around, exact },
    rects: [boxToRect(box)],
    style: 'equation',
    ...(number ? { equation: number } : {}),
    ...(latex ? { latex } : {}),
    strokeIds,
    createdAt
  }
}

/** How a mark is named in menus and lists. */
export function targetLabel(t: Target, withPage = false): string {
  if (t.kind === 'text') return `“${t.display ?? t.quote?.exact ?? ''}”`
  if (t.kind === 'region') {
    const where = withPage ? `, p. ${(t.page ?? 0) + 1}` : ''
    if (t.style === 'equation') {
      // The circled maths itself, written as maths, then which equation it belongs to.
      const eq = t.equation ? `Eq. (${t.equation})` : 'equation'
      return t.latex ? `$${t.latex}$ in ${eq}${where}` : `${t.equation ? eq : 'Equation'}${where}`
    }
    return `Region${where}`
  }
  return t.kind === 'page' ? `Page ${(t.page ?? 0) + 1}` : 'Whole paper'
}

export function makeTextTarget(
  id: string,
  page: number,
  allWords: Word[],
  match: MarkMatch,
  style: Target['style'],
  strokeIds: string[],
  createdAt: string
): Target {
  const indexes = match.words.map((w) => w.index)
  const display = readableQuote(allWords, Math.min(...indexes), Math.max(...indexes))
  return {
    id,
    kind: 'text',
    page,
    quote: buildQuote(allWords, Math.min(...indexes), Math.max(...indexes)),
    ...(display ? { display } : {}),
    rects: match.rects,
    style,
    strokeIds,
    createdAt
  }
}

/** How soon after the last mark a mark on the next line still continues it. */
export const MARK_EXTEND_MS = 8000

/**
 * Adds a mark on the next line to the active target, so one quote can span several lines.
 * Only right after it: a mark drawn minutes later next to an old one is a mark of its own.
 */
export function canExtendTarget(active: Target | undefined, next: Target, msSinceActive = 0): boolean {
  if (!active || active.kind !== 'text' || next.kind !== 'text') return false
  if (msSinceActive > MARK_EXTEND_MS) return false
  if (active.page !== next.page || active.style !== next.style) return false
  const a = active.rects?.[active.rects.length - 1]
  const b = next.rects?.[0]
  if (!a || !b) return false
  const dy = b[1] - a[1]
  return dy > a[3] * 0.5 && dy < a[3] * 2.2
}

/** The quoted words with their maths as $LaTeX$, or undefined when they hold no maths. */
export function readableQuote(allWords: Word[], first: number, last: number): string | undefined {
  const text = readableText(allWords.slice(first, last + 1))
  return hasMath(text) ? text : undefined
}

export function extendTarget(active: Target, next: Target): Target {
  const display = active.display || next.display
    ? `${active.display ?? active.quote?.exact ?? ''} ${next.display ?? next.quote?.exact ?? ''}`.trim()
    : undefined
  return {
    ...active,
    ...(display ? { display } : {}),
    quote: {
      exact: `${active.quote?.exact ?? ''} ${next.quote?.exact ?? ''}`.trim(),
      prefix: active.quote?.prefix ?? '',
      suffix: next.quote?.suffix ?? ''
    },
    rects: [...(active.rects ?? []), ...(next.rects ?? [])],
    strokeIds: [...(active.strokeIds ?? []), ...(next.strokeIds ?? [])]
  }
}

/**
 * The typical letter height. Flat strokes, like the bar of a T or a dash, are left out: with
 * capitals they can be half the strokes and would make the writing look tiny.
 */
function medianHeight(strokes: Stroke[]): number {
  const all = strokes.map((s) => {
    const b = boxOf(s.points)
    return b.y1 - b.y0
  })
  const tallest = Math.max(0, ...all)
  const h = all.filter((x) => x >= tallest * 0.3).sort((a, b) => a - b)
  return h[Math.floor(h.length / 2)] ?? 8
}

/** Groups nearby strokes into separate notes, with gaps scaled to the writing size. */
export function clusterStrokes(strokes: Stroke[], justWritten = false): Stroke[][] {
  if (strokes.length === 0) return []
  const h = Math.max(medianHeight(strokes), 5)
  // Words on one line can sit a few letters apart and still be one note.
  const gapX = Math.max(14, h * 3.5)
  const gapY = Math.max(4, h * 0.9)
  const boxes = strokes.map((s) => boxOf(s.points))
  const parent = strokes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      if (intersects(inflate(boxes[i], gapX / 2, gapY / 2), inflate(boxes[j], gapX / 2, gapY / 2))) {
        parent[find(i)] = find(j)
      }
    }
  }
  // Writing carried straight on along a line stays together across a wide gap between words.
  // Only for writing just done: once ink is moved, the order it was written in says nothing.
  const time = (s: Stroke) => Date.parse(s.createdAt) || 0
  const order = strokes.map((_, i) => i).sort((a, b) => time(strokes[a]) - time(strokes[b]))
  for (let k = 1; justWritten && k < order.length; k++) {
    const [i, j] = [order[k - 1], order[k]]
    if (time(strokes[j]) - time(strokes[i]) > 2500) continue
    if (intersects(inflate(boxes[i], gapX * 2, h * 0.6), boxes[j])) parent[find(i)] = find(j)
  }
  const groups = new Map<number, Stroke[]>()
  strokes.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]))
  return [...groups.values()]
}

export function clusterBox(strokes: Stroke[]): Box {
  return unionBoxes(strokes.map((s) => boxOf(s.points)))
}

/**
 * Notes that new strokes should join: grouping goes purely by closeness for now, however long ago
 * a note was written. Notes whose text was corrected by hand are left alone.
 */
export function findNearbyNotes(cluster: Stroke[], notes: MarginNote[]): MarginNote[] {
  const box = clusterBox(cluster)
  const h = Math.max(medianHeight(cluster), 5)
  const zone = inflate(box, Math.max(14, h * 3.5), Math.max(6, h * 1.2))
  return notes.filter(
    (n) => n.page === cluster[0].page && !n.corrected && n.kind !== 'drawing' && intersects(zone, rectToBox(n.box))
  )
}

/** The height of one written line of a note, tall letters and tails included. */
export function lineHeight(strokes: Stroke[]): number {
  const heights = splitLines(strokes)
    .map((line) => {
      const b = clusterBox(line)
      return b.y1 - b.y0
    })
    .sort((a, b) => a - b)
  return Math.max(heights[Math.floor(heights.length / 2)] ?? 0, medianHeight(strokes) * 1.6, 8)
}

/** How soon after a note's last stroke new writing beside it still counts as carrying on with it. */
export const CARRY_ON_MS = 6000

/**
 * The one note that new writing carries on, if any. New writing never joins two notes into one.
 * - Writing that lands inside a note belongs to it, even if another note is near.
 * - Writing carries on a note to its right on the same line, or on the line below. A word written
 *   at the end of a line can leave a wide gap; a new line can start a little lower.
 * - Writing that ends just left of a note, or above it, is a note of its own unless it touches it.
 * - Right after writing a note, the gaps allowed are larger: the pen is still on it.
 * - A cluster much taller than the note's lines, such as a long arrow, only joins a note it lands in.
 * `strokeOf` finds a note's strokes; `start` is when the new writing began.
 */
export function noteToJoin(
  cluster: Stroke[],
  notes: MarginNote[],
  strokeOf: (id: string) => Stroke | undefined,
  start = Number.POSITIVE_INFINITY
): MarginNote | undefined {
  const c = clusterBox(cluster)
  const cx = (c.x0 + c.x1) / 2
  const cy = (c.y0 + c.y1) / 2
  let best: { note: MarginNote; score: number } | undefined
  for (const n of notes) {
    if (n.page !== cluster[0].page || n.corrected || n.kind === 'drawing') continue
    const b = rectToBox(n.box)
    const own = n.strokeIds.map(strokeOf).filter((s): s is Stroke => !!s)
    const L = own.length ? lineHeight(own) : Math.max(n.box[3], 8)
    const last = Math.max(0, ...own.map((s) => Date.parse(s.createdAt) || 0))
    const fresh = start - last <= CARRY_ON_MS && start >= last
    const reach = fresh ? 1.6 : 1
    let score: number | undefined
    if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1) score = 0
    else if (c.y1 - c.y0 <= L * 3) {
      const overlapY = Math.min(b.y1, c.y1) - Math.max(b.y0, c.y0)
      const overlapX = Math.min(b.x1, c.x1) - Math.max(b.x0, c.x0)
      const sameLine = overlapY >= Math.min(c.y1 - c.y0, L) * 0.4
      if (sameLine && c.x0 >= b.x1 - L * 0.5) {
        // Carrying on along the line, to the right.
        const gap = Math.max(0, c.x0 - b.x1)
        const allowed = Math.max(20, L * 2) * reach
        if (gap <= allowed) score = 0.1 + gap / allowed
      } else if (sameLine) {
        // Ending just left of the note: only when it touches it.
        const gap = Math.max(0, b.x0 - c.x1)
        if (gap <= L * 0.3) score = 0.5 + gap / L
      } else if (c.y0 >= b.y1 - L * 0.5 && -overlapX <= L * 0.5) {
        // A new line below.
        const gap = Math.max(0, c.y0 - b.y1)
        const allowed = Math.max(10, L * 0.9) * reach
        if (gap <= allowed) score = 0.2 + gap / allowed
      } else if (c.y1 <= b.y0 + L * 0.5 && overlapX > 0) {
        // Above the note: only when it nearly touches it.
        const gap = Math.max(0, b.y0 - c.y1)
        const allowed = Math.max(4, L * 0.25) * reach
        if (gap <= allowed) score = 0.6 + gap / allowed
      }
    }
    if (score === undefined) continue
    if (fresh) score -= 0.15
    if (!best || score < best.score) best = { note: n, score }
  }
  return best?.note
}

/**
 * Splits a note's strokes, given in writing order, into written lines. Tall or slanted letters
 * overlap the line below, so what marks a new line is the pen going back left and down.
 */
/** The middle of a stroke's ink: the median height of its points, so a "g" tail or an "l" stem barely moves it. */
function inkMiddle(s: Stroke): number {
  const ys = s.points.map((p) => p[1]).sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)] ?? 0
}

/**
 * Splits a note into written lines by where its strokes sit, not by the order they were written,
 * so a word added later (a correction, an inserted word) lands in its line, in its place. Each line
 * is read left to right.
 */
export function splitLines(strokes: Stroke[]): Stroke[][] {
  if (strokes.length === 0) return []
  const h = Math.max(medianHeight(strokes), 4)
  const items = strokes.map((s) => {
    const b = boxOf(s.points)
    return { s, b, mid: inkMiddle(s), small: b.y1 - b.y0 < h * 0.5 && b.x1 - b.x0 < h * 1.2 }
  })
  type Item = (typeof items)[number]
  type Line = { y0: number; y1: number; items: Item[] }
  // Each line has a core band, the height of its small letters. Count how much writing covers each
  // height, with short strokes counting most: tall letters and tails then only add a thin layer
  // between lines, and the bands stand out however the lines drift. Measured on real notes.
  const letters = items.filter((i) => !i.small)
  const lo = Math.min(...items.map((i) => i.b.y0))
  const hi = Math.max(...items.map((i) => i.b.y1))
  const bin = h / 8
  const cover = new Array(Math.ceil((hi - lo) / bin) + 2).fill(0)
  for (const { b } of letters) {
    const tall = b.y1 - b.y0
    if (tall < h * 0.3) continue
    const w = Math.max(b.x1 - b.x0, h * 0.3) / tall
    for (let k = Math.floor((b.y0 - lo) / bin); k <= Math.floor((b.y1 - lo) / bin); k++) cover[k] += w
  }
  const peak = Math.max(...cover, 0)
  const lines: Line[] = []
  let open: Line | null = null
  cover.forEach((v, k) => {
    if (peak > 0 && v > peak * 0.22) {
      if (!open) lines.push((open = { y0: lo + k * bin, y1: lo + (k + 1) * bin, items: [] }))
      else open.y1 = lo + (k + 1) * bin
    } else open = null
  })
  if (lines.length === 0) lines.push({ y0: lo, y1: hi, items: [] })
  // Lines written so close that their letters overlap leave no gap at all; a band taller than one
  // line is split again where the middles of its letters jump.
  for (let i = 0; i < lines.length; i++) {
    const band = lines[i]
    if (band.y1 - band.y0 <= h * 1.6) continue
    const mids = letters
      .filter((it) => it.mid >= band.y0 && it.mid <= band.y1)
      .map((it) => it.mid)
      .sort((a, b) => a - b)
    const cuts: number[] = []
    for (let k = 1; k < mids.length; k++) if (mids[k] - mids[k - 1] >= h * 0.5) cuts.push((mids[k] + mids[k - 1]) / 2)
    if (cuts.length === 0) continue
    const edges = [band.y0, ...cuts, band.y1]
    lines.splice(i, 1, ...edges.slice(1).map((y1, k) => ({ y0: edges[k], y1, items: [] as Item[] })))
    i += cuts.length
  }
  // Every letter joins the band its middle lies in; a tall letter whose middle lies between bands
  // joins the band it overlaps most, or else the closest one.
  for (const it of letters) {
    const home = lines.find((l) => it.mid >= l.y0 && it.mid <= l.y1)
    if (home) { home.items.push(it); continue }
    const overlap = (l: Line) => Math.min(l.y1, it.b.y1) - Math.max(l.y0, it.b.y0)
    const gap = (l: Line) => Math.abs((l.y0 + l.y1) / 2 - it.mid)
    const best = lines.reduce((b, l) => (overlap(l) > overlap(b) || (overlap(l) === overlap(b) && gap(l) < gap(b)) ? l : b))
    // A word or two on a line of its own, such as a last "it.", is too little ink to make a band.
    // Well clear of every band, it starts a line instead of spoiling the one above.
    if (overlap(best) <= 0 && Math.min(...lines.map((l) => Math.max(l.y0 - it.mid, it.mid - l.y1))) > h * 0.6) {
      lines.push({ y0: it.mid - h / 4, y1: it.mid + h / 4, items: [it] })
      continue
    }
    best.items.push(it)
  }
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].items.length === 0) lines.splice(i, 1)
  const level = (l: Line) => (l.y0 + l.y1) / 2
  // A line of one to three strokes that sits beside another line rather than under or over it, such
  // as a tall "?" after "Why", belongs to that line.
  const span = (l: Line) => {
    const xs = l.items.flatMap((i) => [i.b.x0, i.b.x1])
    const ys = l.items.flatMap((i) => [i.b.y0, i.b.y1])
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const small = lines[i]
    if (small.items.length > 3 || lines.length < 2) continue
    const a = span(small)
    const host = lines.find((l) => {
      if (l === small) return false
      const b = span(l)
      const sideBySide = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < (a.x1 - a.x0) * 0.5
      const level = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > (a.y1 - a.y0) * 0.4
      const close = Math.max(b.x0 - a.x1, a.x0 - b.x1) < h * 3
      return sideBySide && level && close
    })
    if (!host) continue
    host.items.push(...small.items)
    host.y0 = Math.min(host.y0, small.y0)
    host.y1 = Math.max(host.y1, small.y1)
    lines.splice(i, 1)
  }
  // Short letters, dots, accents, dashes and commas join the nearest line. A dot sits above its
  // letter, so a line below counts as nearer than the same distance above it.
  for (const it of items.filter((i) => i.small)) {
    if (lines.length === 0) {
      lines.push({ y0: it.b.y0, y1: it.b.y1, items: [it] })
      continue
    }
    const dist = (l: Line) => (it.mid < l.y0 ? (l.y0 - it.mid) * 0.6 : it.mid > l.y1 ? it.mid - l.y1 : 0)
    lines.reduce((best, l) => (dist(l) < dist(best) ? l : best)).items.push(it)
  }
  return lines
    .sort((a, b) => level(a) - level(b))
    .map((l) => l.items.sort((a, b) => a.b.x0 - b.b.x0).map((i) => i.s))
}

/**
 * A single line of ink whose reading is far shorter than its length suggests, such as a zigzag
 * read as "mm", is a drawing and not text.
 */
export function looksLikeDrawing(strokes: Stroke[], text: string): boolean {
  if (strokes.length === 0 || splitLines(strokes).length !== 1) return false
  const b = clusterBox(strokes)
  const h = Math.max(b.y1 - b.y0, 1)
  const expected = (b.x1 - b.x0) / (0.6 * h)
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length
  if (expected >= 6 && letters < expected * 0.3) return true
  // A scribble with loops travels far further than the few letters read from it would need.
  let travel = 0
  for (const s of strokes) {
    for (let i = 1; i < s.points.length; i++) {
      travel += Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1])
    }
  }
  return travel / (Math.max(letters, 1) * h) > 5
}

/** Drops points closer together than the recognizer can use, which makes recognition much cheaper. */
function thinned(points: InkPoint[], minGap = 0.4): InkPoint[] {
  if (points.length <= 2) return points
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minGap) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

/** Flat coordinates relative to the note's corner, as the recognition engines expect. */
function inkLength(points: InkPoint[]): number {
  let len = 0
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return len
}

/**
 * A "?" or "!" ending a written line, seen from the ink: a stroke at the right end of the line
 * with a dot just below it. The recognizers often read these as "." or "1", or drop them.
 * A thin straight stroke is "!", anything else "?". Measured on the 15–16 Nov PlaNet notes:
 * 16 of 19 found, none wrongly; the misses had no separate dot.
 */
export function trailingMark(line: Stroke[]): '?' | '!' | '' {
  if (line.length < 2) return ''
  const items = line.map((s) => ({ s, b: boxOf(s.points) }))
  const h = Math.max(medianHeight(line), 4)
  const right = Math.max(...items.map((i) => i.b.x1))
  for (const d of items) {
    if (d.b.x1 - d.b.x0 > h * 0.45 || d.b.y1 - d.b.y0 > h * 0.45) continue
    const dx = (d.b.x0 + d.b.x1) / 2
    for (const s of items) {
      if (s === d) continue
      const sh = s.b.y1 - s.b.y0
      const sw = s.b.x1 - s.b.x0
      if (sh < h * 0.7) continue
      if (dx < s.b.x0 - h * 0.25 || dx > s.b.x1 + h * 0.25) continue
      // The dot lies below the stroke, not beside or above it as with "i" or ".".
      if (s.b.y1 > d.b.y0 + h * 0.05 || d.b.y0 - s.b.y1 > Math.max(h, sh) * 0.9) continue
      // Nothing written to the right of it.
      if (right > Math.max(s.b.x1, d.b.x1) + h * 0.3) continue
      return sw < sh * 0.2 || (sw < sh * 0.35 && inkLength(s.s.points) < sh * 1.25) ? '!' : '?'
    }
  }
  return ''
}

/**
 * Puts a "?" or "!" seen in the ink at the end of each recognized line that lacks it, replacing
 * a "." or other mark read in its place. The last word's alternatives get the fixed word first.
 */
export function fixTrailingMarks(text: string, candidates: string[][], lines: Stroke[][]): { text: string; candidates: string[][] } {
  const rows = text.split('\n')
  if (rows.length !== lines.length) return { text, candidates }
  const out = candidates.map((c) => [...c])
  let wordsBefore = 0
  rows.forEach((row, i) => {
    const count = row.split(' ').filter(Boolean).length
    const mark = trailingMark(lines[i])
    if (mark && count > 0 && !row.trimEnd().endsWith(mark)) {
      const fixed = row.trimEnd().replace(/[.,:;!?¡¿|]+$/, '') + mark
      rows[i] = fixed
      const last = wordsBefore + count - 1
      const word = fixed.split(' ').filter(Boolean).pop() ?? ''
      if (out[last]) out[last] = [word, ...out[last].filter((w) => w !== word)]
    }
    wordsBefore += count
  })
  return { text: rows.join('\n'), candidates: out }
}

export function toRecognitionLines(strokes: Stroke[]): number[][][] {
  const b = clusterBox(strokes)
  return splitLines(strokes).map((line) =>
    line.map((s) => thinned(s.points).flatMap(([x, y]) => [round(x - b.x0), round(y - b.y0)]))
  )
}

/**
 * Strokes written within the time window that lie close to new points. Strokes must be in writing
 * order, newest last. Used to keep everything written in one go together: the dot of a "?", or a
 * crossbar that happens to lie over a line of printed text.
 */
export function recentStrokesNear(
  points: InkPoint[],
  page: number,
  strokes: Stroke[],
  now: number,
  windowMs = 8000,
  radius = 25
): Stroke[] {
  const zone = inflate(boxOf(points), radius, radius)
  const out: Stroke[] = []
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]
    if (now - Date.parse(s.createdAt) > windowMs) break
    if (s.page === page && intersects(zone, boxOf(s.points))) out.push(s)
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export function isTap(points: InkPoint[], maxExtent = 3, maxMs = 350): boolean {
  if (points.length === 0) return false
  const b = boxOf(points)
  return b.x1 - b.x0 <= maxExtent && b.y1 - b.y0 <= maxExtent && points[points.length - 1][3] <= maxMs
}

/**
 * What a short pen touch is:
 * - 'stroke': ordinary ink.
 * - 'dot': punctuation that belongs to writing beside it, such as the dot of an "i" added later.
 * - 'tap': it selects or dismisses something and leaves no ink.
 * A touch that would do nothing becomes a dot when it sits next to writing, whenever that was written,
 * so a dot added after a pause is kept. A tiny flick far from any writing is a tap, not a new note.
 */
export function classifyPenTouch(p: {
  points: InkPoint[]
  page: number
  /** Unmarked strokes, oldest first. */
  writing: Stroke[]
  now: number
  /** The tap size at the current zoom, in page units. */
  tapExtent: number
  tapMs: number
  punctuationMs: number
  linking: boolean
  /** The touch lands on a note, a mark or a link. */
  hitsSomething: boolean
  /** A note is selected or a mark's menu is open, so a tap is how it's dismissed. */
  dismissing: boolean
  /** While the pen wrote this recently, a touch on empty space nearby is part of the writing. */
  writingMs?: number
}): 'stroke' | 'dot' | 'tap' {
  const near = recentStrokesNear(p.points, p.page, p.writing, p.now, Infinity)
  const writingOn = p.writingMs !== undefined &&
    recentStrokesNear(p.points, p.page, p.writing.filter((s) => s.handwriting), p.now, p.writingMs, 60).length > 0
  const tapped = isTap(p.points, p.tapExtent, p.tapMs) || (near.length === 0 && !writingOn && isTap(p.points, p.tapExtent * 2, 120))
  if (!tapped) return 'stroke'
  if (p.linking) return 'tap'
  if (near.length && recentStrokesNear(p.points, p.page, p.writing, p.now, p.punctuationMs).length) return 'dot'
  // A dot or a slip of the pen between words must not end the link to the mark being written about.
  if (writingOn && !p.hitsSomething) return 'dot'
  if (near.length === 0) return 'tap'
  return p.hitsSomething || p.dismissing ? 'tap' : 'dot'
}

export function strokeNear(stroke: Stroke, x: number, y: number, radius: number): boolean {
  return stroke.points.some(([px, py]) => Math.hypot(px - x, py - y) <= radius)
}

export function pointInRect(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad
}

export function targetAt(targets: Target[], page: number, x: number, y: number): Target | undefined {
  return targets.find((t) => t.page === page && t.rects?.some((r) => pointInRect(r, x, y, 2)))
}

export function isQuestionText(text: string): boolean {
  return /^\s*[?？]+\s*$/.test(text)
}

// ---- Selecting ink with a loop and moving it ----

/** Whether a point lies inside a closed loop drawn with the pen. */
export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Strokes mostly inside the loop: a stroke that only pokes in a little is left out. */
export function strokesInLasso(strokes: Stroke[], page: number, poly: [number, number][], skip: ReadonlySet<string> = new Set()): string[] {
  if (poly.length < 3) return []
  return strokes
    .filter((s) => s.page === page && !skip.has(s.id) && s.points.length > 0)
    .filter((s) => s.points.filter(([x, y]) => pointInPolygon(x, y, poly)).length >= s.points.length * 0.6)
    .map((s) => s.id)
}

interface InkDoc {
  ink: { strokes: Stroke[] }
  annotations: { marginNotes: MarginNote[] }
}

function noteFor(base: MarginNote | undefined, id: string, page: number, strokes: Stroke[], targetIds: string[], now: string): MarginNote {
  return {
    id, page, box: boxToRect(clusterBox(strokes)), strokeIds: strokes.map((s) => s.id), text: base?.text ?? '',
    candidates: [], corrected: false, kind: base?.kind ?? 'note', targetIds, createdAt: base?.createdAt ?? now, updatedAt: now
  }
}

/**
 * Moves the chosen strokes and regroups the notes around them, as if the ink had been written
 * where it now lies:
 * - The notes it came from keep their other strokes. A note whose remaining strokes have come
 *   apart is split.
 * - The moved writing joins a note it now sits next to, or becomes a note of its own that keeps
 *   the links of the note it came from.
 * - Ink that belonged to no note, such as a drawn arrow, just moves.
 * Returns the notes whose text must be read again.
 */
export function moveInk(d: InkDoc, page: number, ids: ReadonlySet<string>, dx: number, dy: number, newId: () => string, now: string): string[] {
  return reshapeInk(d, page, ids, (x, y) => [x + dx, y + dy], 1, newId, now)
}

/**
 * Makes the chosen strokes larger or smaller by `factor`, line widths included, to make room in
 * a margin. The side facing the printed text stays put: the right edge in the left margin, the
 * left edge elsewhere, and the top edge always. Notes regroup as after a move.
 */
export function scaleInk(
  d: InkDoc, page: number, ids: ReadonlySet<string>, factor: number, newId: () => string, now: string,
  /** The point that stays put, such as the corner opposite the one dragged. */
  anchor?: [number, number]
): string[] {
  const chosen = d.ink.strokes.filter((s) => ids.has(s.id))
  if (chosen.length === 0 || !(factor > 0)) return []
  const b = clusterBox(chosen)
  const [ax, ay] = anchor ?? [(b.x0 + b.x1) / 2 < 0 ? b.x1 : b.x0, b.y0]
  return reshapeInk(d, page, ids, (x, y) => [ax + (x - ax) * factor, ay + (y - ay) * factor], factor, newId, now)
}

function reshapeInk(
  d: InkDoc, page: number, ids: ReadonlySet<string>, map: (x: number, y: number) => [number, number],
  widthFactor: number, newId: () => string, now: string
): string[] {
  const r = (n: number) => Math.round(n * 100) / 100
  d.ink.strokes = d.ink.strokes.map((s) => (ids.has(s.id)
    ? {
        ...s,
        width: widthFactor === 1 ? s.width : r(s.width * widthFactor),
        points: s.points.map(([x, y, p, t]) => {
          const [nx, ny] = map(x, y)
          return [r(nx), r(ny), p, t] as InkPoint
        })
      }
    : s))
  const byId = new Map(d.ink.strokes.map((s) => [s.id, s]))
  const sources = d.annotations.marginNotes.filter((n) => n.page === page && n.strokeIds.some((id) => ids.has(id)))
  if (sources.length === 0) return []
  const sourceOf = new Map<string, MarginNote>()
  for (const n of sources) for (const id of n.strokeIds) if (ids.has(id)) sourceOf.set(id, n)
  d.annotations.marginNotes = d.annotations.marginNotes.filter((n) => !sources.includes(n))
  const toRead = new Set<string>()
  // What stays behind, split where it has come apart. The biggest part keeps the note.
  for (const n of sources) {
    const rest = n.strokeIds.filter((id) => !ids.has(id)).map((id) => byId.get(id)).filter((s): s is Stroke => !!s)
    if (rest.length === 0) continue
    const parts = clusterStrokes(rest).sort((a, b) => b.length - a.length)
    parts.forEach((part, i) => {
      const note = noteFor(n, i === 0 ? n.id : newId(), page, part, n.targetIds, now)
      d.annotations.marginNotes.push(note)
      toRead.add(note.id)
    })
  }
  // The moved writing, as if just written there.
  const moved = [...sourceOf.keys()].map((id) => byId.get(id)).filter((s): s is Stroke => !!s)
  for (const cluster of clusterStrokes(moved)) {
    const from = [...new Set(cluster.map((s) => sourceOf.get(s.id)!))]
    const nearby = findNearbyNotes(cluster, d.annotations.marginNotes)
    if (nearby.length) {
      const [kept, ...absorbed] = nearby
      const all = [...nearby.flatMap((n) => n.strokeIds), ...cluster.map((s) => s.id)]
      kept.strokeIds = all
      kept.box = boxToRect(clusterBox(all.map((id) => byId.get(id)).filter((s): s is Stroke => !!s)))
      kept.targetIds = [...new Set([...nearby.flatMap((n) => n.targetIds), ...from.flatMap((n) => n.targetIds)])]
      kept.corrected = false
      kept.updatedAt = now
      const gone = new Set(absorbed.map((n) => n.id))
      d.annotations.marginNotes = d.annotations.marginNotes.filter((n) => !gone.has(n.id))
      for (const id of gone) toRead.delete(id)
      toRead.add(kept.id)
    } else {
      // A note moved whole keeps its id, so its place in the notes pane stays.
      const whole = from.length === 1 && !d.annotations.marginNotes.some((n) => n.id === from[0].id) &&
        from[0].strokeIds.every((id) => cluster.some((s) => s.id === id))
      if (whole && cluster.length === from[0].strokeIds.length) {
        // The same writing, only moved or resized: its text, typed or read, still holds.
        d.annotations.marginNotes.push({ ...from[0], box: boxToRect(clusterBox(cluster)), updatedAt: now })
        continue
      }
      const note = noteFor(from[0], whole ? from[0].id : newId(), page, cluster, [...new Set(from.flatMap((n) => n.targetIds))], now)
      d.annotations.marginNotes.push(note)
      toRead.add(note.id)
    }
  }
  return [...toRead]
}

/** Removes strokes; notes keep what is left, and a note left with nothing goes. Returns the notes to read again. */
export function deleteInk(d: InkDoc, ids: ReadonlySet<string>): string[] {
  d.ink.strokes = d.ink.strokes.filter((s) => !ids.has(s.id))
  const byId = new Map(d.ink.strokes.map((s) => [s.id, s]))
  const toRead: string[] = []
  for (const n of [...d.annotations.marginNotes]) {
    if (!n.strokeIds.some((id) => ids.has(id))) continue
    n.strokeIds = n.strokeIds.filter((id) => !ids.has(id))
    const rest = n.strokeIds.map((id) => byId.get(id)).filter((s): s is Stroke => !!s)
    if (rest.length === 0) {
      d.annotations.marginNotes = d.annotations.marginNotes.filter((x) => x.id !== n.id)
      continue
    }
    n.box = boxToRect(clusterBox(rest))
    n.corrected = false
    toRead.push(n.id)
  }
  return toRead
}
