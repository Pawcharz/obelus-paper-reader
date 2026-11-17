import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { WindowsInkEngine } from '../../src/main/recognition/windowsInk'

// Block-letter strokes for a real word, drawn at different sizes, to see whether size matters.
const line = (x0: number, y0: number, x1: number, y1: number): number[] => {
  const out: number[] = []
  for (let i = 0; i <= 10; i++) out.push(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10)
  return out
}
const arc = (cx: number, cy: number, r: number): number[] => {
  const out: number[] = []
  for (let i = 0; i <= 24; i++) {
    const t = (2 * Math.PI * i) / 24
    out.push(cx + r * Math.sin(-t), cy - r * Math.cos(t))
  }
  return out
}
const k = (x: number) => [line(x, 0, x, 100), line(x + 45, 40, x, 72), line(x + 12, 62, x + 50, 100)]
const o = (x: number) => [arc(x + 28, 70, 28)]
const t = (x: number) => [line(x + 20, 12, x + 20, 100), line(x, 42, x + 42, 42)]
const word = [...k(0), ...o(62), ...t(130)]

function scaled(size: number): number[][] {
  // The engine multiplies by 2, so the requested size is halved first.
  return word.map((s) => s.map((v) => (v * size) / 100 / 2))
}

describe.runIf(process.platform === 'win32' && process.env.REAL_NET)('recognizer and writing size', () => {
  const engine = new WindowsInkEngine(join(__dirname, '../../resources/ink-sidecar.ps1'))
  afterAll(() => engine.dispose())
  it('reads the same word at every size', async () => {
    for (const size of [8, 12, 20, 40, 80, 160]) {
      const r = await engine.recognize({ recognizer: '', lines: [scaled(size)] })
      console.log(`height ${size}: "${r.text}"  alternatives: ${r.candidates[0]?.slice(0, 4).join(', ')}`)
      expect(r.ok).toBe(true)
    }
  })
})
