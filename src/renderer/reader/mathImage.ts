import { Stroke } from '../../shared/types'
import { mathImageLayout } from '../../shared/mathInk'

/** The note's ink as a black-on-white PNG (data: URL) for the maths model, glyphs at a constant size. */
export function mathImage(strokes: Stroke[], glyph?: number): string | null {
  const paths = strokes.map((s) => s.points)
  const layout = mathImageLayout(paths, glyph)
  if (!layout) return null
  const c = document.createElement('canvas')
  c.width = layout.width
  c.height = layout.height
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.strokeStyle = '#000'
  g.fillStyle = '#000'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.lineWidth = layout.lineWidth
  for (const pts of paths) {
    if (pts.length === 0) continue
    const [sx, sy] = layout.map(pts[0][0], pts[0][1])
    g.beginPath()
    if (pts.length === 1) {
      g.arc(sx, sy, layout.lineWidth / 2, 0, Math.PI * 2)
      g.fill()
      continue
    }
    g.moveTo(sx, sy)
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = layout.map(pts[i][0], pts[i][1])
      g.lineTo(px, py)
    }
    g.stroke()
  }
  return c.toDataURL('image/png')
}
