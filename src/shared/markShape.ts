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

/**
 * Line boxes (from joinLines, top to bottom) grouped into blocks that one outline can go round:
 * each line is the next line down from the one before, with no blank line or wider gap between
 * them, and the two share some width. A mark that jumps a gap (to another paragraph further down,
 * another column) gets one block per part, so no outline takes in text that is not marked.
 * The lines in a block are stretched to meet halfway between them.
 */
export function outlineBlocks(lines: Rect[]): Rect[][] {
  const blocks: Rect[][] = []
  for (const r of [...lines].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const block = blocks[blocks.length - 1]
    const prev = block?.[block.length - 1]
    if (prev && joinsBelow(prev, r)) {
      const mid = (prev[1] + prev[3] + r[1]) / 2
      block[block.length - 1] = [prev[0], prev[1], prev[2], mid - prev[1]]
      block.push([r[0], mid, r[2], r[1] + r[3] - mid])
    } else blocks.push([[...r] as Rect])
  }
  return blocks.map(squareOff)
}

/**
 * Evens out a block's edges, as a hand-drawn loop would: lines of a paragraph end at slightly
 * different places, and a line can miss a piece the text layer did not give as a word (maths at
 * its start). Middle lines span the block's full width; the first line keeps its own start and the
 * last its own end, unless they fall within about a line's height of the edge.
 */
function squareOff(block: Rect[]): Rect[] {
  if (block.length < 2) return block
  const left = Math.min(...block.map((r) => r[0]))
  const right = Math.max(...block.map((r) => r[0] + r[2]))
  const last = block.length - 1
  return block.map((r, i) => {
    const near = Math.max(r[3], 8)
    const x0 = i === 0 && r[0] - left > near ? r[0] : left
    const x1 = i === last && right - (r[0] + r[2]) > near ? r[0] + r[2] : right
    return [x0, r[1], x1 - x0, r[3]] as Rect
  })
}

function joinsBelow(a: Rect, b: Rect): boolean {
  const gap = b[1] - (a[1] + a[3])
  const h = Math.min(a[3], b[3])
  const sharedWidth = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])
  // A line spacing is well under half a line high; a skipped line or a paragraph space is more.
  return gap > -h / 2 && gap < h * 0.6 && sharedWidth > 0
}

/**
 * An SVG path going round a block of stacked line boxes (see outlineBlocks): down the right edges,
 * back up the left ones, every corner rounded by up to `radius`.
 */
export function outlinePath(block: Rect[], radius = 5): string {
  if (!block.length) return ''
  const pts: [number, number][] = []
  for (const r of block) pts.push([r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]])
  for (let i = block.length - 1; i >= 0; i--) {
    const r = block[i]
    pts.push([r[0], r[1] + r[3]], [r[0], r[1]])
  }
  const corners = dropStraight(pts)
  const n = corners.length
  const toward = (p: [number, number], q: [number, number], d: number): [number, number] => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
    return [p[0] + ((q[0] - p[0]) / len) * d, p[1] + ((q[1] - p[1]) / len) * d]
  }
  const f = (x: number): string => String(Math.round(x * 100) / 100)
  let d = ''
  corners.forEach((p, i) => {
    const a = corners[(i + n - 1) % n]
    const b = corners[(i + 1) % n]
    const r = Math.min(radius, Math.hypot(a[0] - p[0], a[1] - p[1]) / 2, Math.hypot(b[0] - p[0], b[1] - p[1]) / 2)
    const s = toward(p, a, r)
    const e = toward(p, b, r)
    d += `${i ? 'L' : 'M'}${f(s[0])} ${f(s[1])}Q${f(p[0])} ${f(p[1])} ${f(e[0])} ${f(e[1])}`
  })
  return d + 'Z'
}

/** The corners of a closed outline: repeated points and points on a straight run are dropped. */
function dropStraight(pts: [number, number][]): [number, number][] {
  const EPS = 0.5
  let out = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]
    return Math.abs(p[0] - q[0]) > EPS || Math.abs(p[1] - q[1]) > EPS
  })
  for (let changed = true; changed && out.length > 3; ) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length]
      const p = out[i]
      const b = out[(i + 1) % out.length]
      const straight = (Math.abs(a[0] - p[0]) <= EPS && Math.abs(p[0] - b[0]) <= EPS) ||
        (Math.abs(a[1] - p[1]) <= EPS && Math.abs(p[1] - b[1]) <= EPS)
      if (straight) { out = out.filter((_, j) => j !== i); changed = true; break }
    }
  }
  return out
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
