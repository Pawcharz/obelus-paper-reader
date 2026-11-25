import { deflateSync } from 'node:zlib'
import { mathImageLayout } from '../../src/shared/mathInk'

// Draws ink the way the app's mathImage does (same layout: glyph size, padding, line width), but
// without a browser canvas, so tests can send ink to the maths model. Black on white PNG, data: URL.

type Pt = readonly [number, number, ...number[]]

export function inkPng(strokes: readonly (readonly Pt[])[], glyph?: number): string | null {
  const layout = mathImageLayout(strokes, glyph)
  if (!layout) return null
  const { width: w, height: h } = layout
  const px = new Uint8Array(w * h).fill(255)
  const r = layout.lineWidth / 2
  const dot = (cx: number, cy: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (d <= r + 0.5) px[y * w + x] = Math.min(px[y * w + x], d <= r - 0.5 ? 0 : Math.round(255 * (d - (r - 0.5))))
      }
    }
  }
  for (const s of strokes) {
    if (s.length === 0) continue
    let [px0, py0] = layout.map(s[0][0], s[0][1])
    dot(px0, py0)
    for (let i = 1; i < s.length; i++) {
      const [x1, y1] = layout.map(s[i][0], s[i][1])
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - px0, y1 - py0) / Math.max(r * 0.5, 0.5)))
      for (let k = 1; k <= steps; k++) dot(px0 + ((x1 - px0) * k) / steps, py0 + ((y1 - py0) * k) / steps)
      px0 = x1; py0 = y1
    }
  }
  return 'data:image/png;base64,' + png(px, w, h).toString('base64')
}

function png(gray: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1)
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
