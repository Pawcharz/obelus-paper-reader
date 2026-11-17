import type { Rect } from './types'

/**
 * The boxes a mark is drawn with: the boxes of its words joined into one per line. Pieces of an
 * equation (its sub- and superscripts, its symbols) overlap in height and sit close together, so
 * a circled equation is one box rather than one per piece. Two lines of text stay two boxes.
 */
export function joinLines(rects: Rect[]): Rect[] {
  // Pairs are judged on the words' own boxes, never on a joined box: a joined box grows taller
  // with its subscripts and would then reach the next line and swallow it.
  const group = rects.map((_, i) => i)
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])))
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (belongTogether(rects[i], rects[j])) group[root(i)] = root(j)
    }
  }
  const boxes = new Map<number, Rect>()
  rects.forEach((r, i) => {
    const k = root(i)
    const b = boxes.get(k)
    if (!b) { boxes.set(k, [...r] as Rect); return }
    const x = Math.min(b[0], r[0])
    const y = Math.min(b[1], r[1])
    boxes.set(k, [x, y, Math.max(b[0] + b[2], r[0] + r[2]) - x, Math.max(b[1] + b[3], r[1] + r[3]) - y])
  })
  return [...boxes.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
}

function belongTogether(a: Rect, b: Rect): boolean {
  const overlapY = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])
  const gapX = Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2])
  const low = Math.min(a[3], b[3])
  const high = Math.max(a[3], b[3])
  // A small script just beside bigger text, a little above or below it, is its sub- or
  // superscript. Text it hangs over, on the next line, is not beside it.
  if (low < high * 0.8 && overlapY > -low / 2 && gapX > -low && gapX < high) return true
  // Same line: their middles are at about the same height. Close enough: a few spaces at most,
  // so a column gap keeps them apart.
  const midA = a[1] + a[3] / 2
  const midB = b[1] + b[3] / 2
  return Math.abs(midA - midB) < high / 2 && overlapY > 0 && gapX < high * 2
}

/** A region after its grip or one of its corners was dragged by (dx, dy); it stays on the page and at least 12 units wide and high. */
export function adjustRegion(r: Rect, how: 'move' | 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number, width: number, height: number): Rect {
  const MIN = 12
  let [x0, y0] = [r[0], r[1]]
  let [x1, y1] = [r[0] + r[2], r[1] + r[3]]
  if (how === 'move') {
    const mx = Math.min(Math.max(dx, -x0), width - x1)
    const my = Math.min(Math.max(dy, -y0), height - y1)
    return [x0 + mx, y0 + my, r[2], r[3]]
  }
  if (how === 'nw' || how === 'sw') x0 = Math.min(Math.max(0, x0 + dx), x1 - MIN)
  if (how === 'ne' || how === 'se') x1 = Math.max(Math.min(width, x1 + dx), x0 + MIN)
  if (how === 'nw' || how === 'ne') y0 = Math.min(Math.max(0, y0 + dy), y1 - MIN)
  if (how === 'sw' || how === 'se') y1 = Math.max(Math.min(height, y1 + dy), y0 + MIN)
  return [x0, y0, x1 - x0, y1 - y0]
}
