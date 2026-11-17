import type { MarginNote, Rect, Target } from './types'

/** The smallest box around all the given boxes. */
export function boundsOf(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r[0]))
  const y0 = Math.min(...rects.map((r) => r[1]))
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]))
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]))
  return [x0, y0, x1 - x0, y1 - y0]
}

function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2]))
  const dy = Math.max(0, a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3]))
  return Math.hypot(dx, dy)
}

/**
 * What to show when going to a note from a link: the note and the one mark it links to that is
 * nearest to it on the same page. Marks elsewhere, or for a whole page or paper, are left out.
 */
export function focusBox(note: MarginNote, targets: Target[]): Rect {
  let best: { box: Rect; d: number } | null = null
  for (const t of targets) {
    if (!note.targetIds.includes(t.id) || t.page !== note.page || !t.rects?.length) continue
    const box = boundsOf(t.rects)
    const d = gap(note.box, box)
    if (!best || d < best.d) best = { box, d }
  }
  return best ? boundsOf([note.box, best.box]) : note.box
}

/**
 * The zoom at which a box, with `pad` screen pixels around it, fills a view. Small boxes are not
 * blown up past `max`, so a one-word note stays readable rather than huge.
 */
export function fitZoom(box: Rect, viewWidth: number, viewHeight: number, pad: number, min: number, max: number): number {
  const w = Math.max(box[2], 1)
  const h = Math.max(box[3], 1)
  const z = Math.min((viewWidth - 2 * pad) / w, (viewHeight - 2 * pad) / h)
  return Math.min(max, Math.max(min, z))
}
