import type { MarginNote, Rect, Target, TypedNoteSize } from './types'

/** Text size steps for typed notes, as factors of the size that reads at about 12 px. */
export const TYPED_SIZE_FACTOR: Record<TypedNoteSize, number> = { S: 0.85, M: 1, L: 1.3 }

/** Screen size a typed note's text is made for, in CSS pixels at the default view. */
export const TYPED_TARGET_PX = 12

/** The widest a new typed note gets, in page units. */
export const TYPED_MAX_WIDTH = 220

/** Space kept between notes, and between a note and the page edge, in page units. */
export const NOTE_GAP = 4

/** Line height of typed notes, as a factor of the text size. */
export const TYPED_LINE = 1.3

/**
 * A new typed note's text size in page units: readable (about 12 px) at this computer's default
 * view, "Fit page + notes", whatever the zoom while typing. All notes made on one computer at one
 * size step are the same size.
 */
export function typedFontSize(defaultZoom: number, size: TypedNoteSize = 'M'): number {
  const base = Math.max(8, TYPED_TARGET_PX / Math.max(defaultZoom, 0.1))
  return Math.round(base * TYPED_SIZE_FACTOR[size] * 10) / 10
}

/**
 * A rough height for a typed note's text, in page units, used before the note is drawn: for
 * placement and as the stored hint. The drawn height replaces it.
 */
export function estimateNoteHeight(text: string, width: number, fontSize: number, minLines = 1): number {
  const perLine = Math.max(4, Math.floor((width - 8) / (fontSize * 0.52)))
  let lines = 0
  for (const para of text.split('\n')) lines += Math.max(1, Math.ceil(para.length / perLine))
  return Math.round((Math.max(lines, minLines) * fontSize * TYPED_LINE + 6) * 10) / 10
}

function overlaps(a: Rect, b: Rect, gap = NOTE_GAP): boolean {
  return a[0] < b[0] + b[2] + gap && b[0] < a[0] + a[2] + gap && a[1] < b[1] + b[3] + gap && b[1] < a[1] + a[3] + gap
}

export interface PlaceInput {
  pageWidth: number
  pageHeight: number
  /** Writing space on each side of the page, in page units. */
  margin: number
  /** Boxes of the notes already on this page. */
  others: Rect[]
  /** The mark the note is about, if any: its boxes on this page. */
  markRects?: Rect[]
  /** Where to start when there is no mark: the y in the middle of the view, say. */
  y?: number
  width: number
  height: number
  /** The part of the page and margins in view, in page units (x from the page's left edge). */
  view?: { x0: number; x1: number }
}

export interface Placement {
  box: Rect
  /** False when nothing was free and the note had to overlap another one. */
  fits: boolean
  /** True when the note was placed outside the view, which must then show it. */
  outOfView: boolean
}

/**
 * Where a new typed note goes. Tried in order, and the first free spot taken:
 * 1. the margin on the mark's side, if in view: level with the mark, then a little lower, then higher;
 * 2. the other margin, if in view;
 * 3. anywhere free in a margin in view, nearest the mark;
 * 4. the same in margins out of view;
 * 5. nothing free: level with the mark, overlapping, and `fits` is false.
 * A note never runs past the top or bottom of its page.
 */
export function placeNote(p: PlaceInput): Placement {
  const w = Math.min(p.width, Math.max(40, p.margin - NOTE_GAP * 2))
  const h = Math.min(p.height, p.pageHeight - NOTE_GAP * 2)
  const marks = p.markRects ?? []
  const markY = marks.length ? Math.min(...marks.map((r) => r[1])) : (p.y ?? NOTE_GAP)
  const markX = marks.length ? (Math.min(...marks.map((r) => r[0])) + Math.max(...marks.map((r) => r[0] + r[2]))) / 2 : p.pageWidth
  const xLeft = -NOTE_GAP - w
  const xRight = p.pageWidth + NOTE_GAP
  const preferLeft = marks.length > 0 && markX < p.pageWidth * 0.42
  const sides = preferLeft ? [xLeft, xRight] : [xRight, xLeft]
  const inView = (x: number) => !p.view || (x >= p.view.x0 - 1 && x + w <= p.view.x1 + 1)
  const clampY = (y: number) => Math.min(Math.max(y, NOTE_GAP), Math.max(NOTE_GAP, p.pageHeight - h - NOTE_GAP))
  const free = (x: number, y: number) => !p.others.some((o) => overlaps([x, y, w, h], o))
  const step = 4
  /** Down first, then up, within `reach` of the start. */
  const search = (x: number, reach: number): number | null => {
    const start = clampY(markY)
    for (let d = 0; d <= reach; d += step) {
      for (const y of d === 0 ? [start] : [start + d, start - d]) {
        if (y !== clampY(y)) continue
        if (free(x, y)) return y
      }
    }
    return null
  }
  if (p.margin >= 40) {
    const quarter = p.pageHeight / 4
    for (const visible of [true, false]) {
      const xs = sides.filter((x) => inView(x) === visible)
      for (const x of xs) {
        const y = search(x, quarter)
        if (y !== null) return { box: [x, y, w, h], fits: true, outOfView: !visible }
      }
      for (const x of xs) {
        const y = search(x, p.pageHeight)
        if (y !== null) return { box: [x, y, w, h], fits: true, outOfView: !visible }
      }
    }
  }
  const x = p.margin >= 40 ? sides[0] : Math.max(NOTE_GAP, p.pageWidth - w - NOTE_GAP)
  return { box: [x, clampY(markY), w, h], fits: false, outOfView: !inView(x) }
}

/**
 * Re-stacks the notes on one page, by request ("Tidy margin"): each stays on its side, in the order
 * of what it is about, as near to that as the space allows, with a small gap between notes.
 * Notes taller than the page are left alone. Returns the new boxes by note id.
 */
export function tidyMargin(notes: MarginNote[], targets: Target[], pageWidth: number, pageHeight: number): Map<string, Rect> {
  const byId = new Map(targets.map((t) => [t.id, t]))
  const wanted = (n: MarginNote): number => {
    const ys = n.targetIds.flatMap((id) => byId.get(id)?.rects?.map((r) => r[1]) ?? [])
    return ys.length ? Math.min(...ys) : n.box[1]
  }
  const out = new Map<string, Rect>()
  const sideOf = (n: MarginNote) => (n.box[0] + n.box[2] / 2 < 0 ? 'left' : n.box[0] + n.box[2] / 2 > pageWidth ? 'right' : 'page')
  for (const side of ['left', 'right'] as const) {
    const column = notes
      .filter((n) => sideOf(n) === side && n.box[3] < pageHeight - NOTE_GAP * 2)
      .map((n) => ({ n, y: wanted(n) }))
      .sort((a, b) => a.y - b.y || a.n.box[1] - b.n.box[1])
    // Down the page: each note as near its target as the one above allows.
    let next = NOTE_GAP
    const ys = column.map(({ n, y }) => {
      const top = Math.max(y, next)
      next = top + n.box[3] + NOTE_GAP
      return top
    })
    // Up from the bottom: anything pushed past the page end moves up, pushing the ones above.
    let limit = pageHeight - NOTE_GAP
    for (let i = column.length - 1; i >= 0; i--) {
      const h = column[i].n.box[3]
      ys[i] = Math.max(NOTE_GAP, Math.min(ys[i], limit - h))
      limit = ys[i] - NOTE_GAP
    }
    column.forEach(({ n }, i) => {
      if (Math.abs(ys[i] - n.box[1]) > 0.01) out.set(n.id, [n.box[0], ys[i], n.box[2], n.box[3]])
    })
  }
  return out
}

/**
 * The zoom and left edge for "Fit page + notes": the page, plus on each side the margin out to its
 * outermost note, with at least `minColumn` page units on the right for new notes.
 */
export function fitWithNotes(viewWidth: number, pageWidth: number, margin: number, noteBoxes: Rect[], minColumn = 160): { zoom: number; left: number } {
  const room = Math.min(margin, minColumn)
  let left = 0
  let right = pageWidth + room
  for (const b of noteBoxes) {
    left = Math.min(left, Math.max(-margin, b[0] - NOTE_GAP))
    right = Math.max(right, Math.min(pageWidth + margin, b[0] + b[2] + NOTE_GAP))
  }
  return { zoom: viewWidth / (right - left), left }
}

/**
 * Pandoc's rule for `$…$` maths in typed text: an opening `$` is followed by a non-space, a closing
 * `$` follows a non-space and is not followed by a digit, and `\$` is a dollar. So "costs $5 and
 * $10" stays text. Returns the text split into plain and maths parts.
 */
export function splitDollarMath(text: string): { math: boolean; text: string }[] {
  const parts: { math: boolean; text: string }[] = []
  let plain = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && text[i + 1] === '$') { plain += '$'; i += 2; continue }
    if (c === '$' && text[i + 1] && !/\s/.test(text[i + 1]) && text[i + 1] !== '$') {
      let j = i + 1
      let found = -1
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '$') {
          if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? '')) { found = j; break }
        }
        j++
      }
      if (found > 0) {
        if (plain) parts.push({ math: false, text: plain })
        plain = ''
        parts.push({ math: true, text: text.slice(i + 1, found) })
        i = found + 1
        continue
      }
    }
    plain += c
    i++
  }
  if (plain) parts.push({ math: false, text: plain })
  return parts
}
