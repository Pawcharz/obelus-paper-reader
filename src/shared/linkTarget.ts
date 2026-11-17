import type { Rect } from './types'

interface WordLike { rect: Rect }

/**
 * What a link inside the paper points at, to show and flash: the line of text that starts at the
 * link's destination (an equation, a heading, a caption), within its own column. Points are in
 * page units; `x` is null when the PDF gives only a height.
 */
export function destBox(words: WordLike[], x: number | null, y: number): Rect {
  const below = words.filter((w) => w.rect[1] + w.rect[3] > y - 2 && (x === null || w.rect[0] + w.rect[2] > x - 12))
  if (below.length === 0) return [x ?? 0, y, x === null ? 400 : 200, 24]
  const top = Math.min(...below.map((w) => w.rect[1]))
  const first = below
    .filter((w) => w.rect[1] <= top + 3)
    .sort((a, b) => (x === null ? a.rect[0] - b.rect[0] : Math.abs(a.rect[0] - x) - Math.abs(b.rect[0] - x)))[0]
  // The rest of that line: words at the same height, joined by word-sized gaps. A column gap or
  // an equation number far to the side ends it.
  const [, fy, , fh] = first.rect
  const line = words
    .filter((w) => { const c = w.rect[1] + w.rect[3] / 2; return c > fy && c < fy + fh })
    .sort((a, b) => a.rect[0] - b.rect[0])
  const at = line.indexOf(first as never)
  const gap = Math.max(12, fh * 1.5)
  let lo = at
  let hi = at
  while (lo > 0 && line[lo].rect[0] - (line[lo - 1].rect[0] + line[lo - 1].rect[2]) < gap) lo--
  while (hi < line.length - 1 && line[hi + 1].rect[0] - (line[hi].rect[0] + line[hi].rect[2]) < gap) hi++
  const picked = line.slice(lo, hi + 1)
  const x0 = Math.min(...picked.map((w) => w.rect[0]))
  const y0 = Math.min(...picked.map((w) => w.rect[1]))
  const x1 = Math.max(...picked.map((w) => w.rect[0] + w.rect[2]))
  const y1 = Math.max(...picked.map((w) => w.rect[1] + w.rect[3]))
  return [x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6]
}
