import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { WindowsInkEngine } from '../../src/main/recognition/windowsInk'
import { joinLines } from '../../src/main/recognition/engine'

function line(x0: number, y0: number, x1: number, y1: number, n = 12): number[] {
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)
  return out
}

function circle(cx: number, cy: number, r: number, n = 32): number[] {
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n
    out.push(cx + r * Math.sin(t), cy - r * Math.cos(t))
  }
  return out
}

describe('joinLines', () => {
  it('keeps one text line per written line', () => {
    const r = joinLines([
      { words: [{ alts: ['hello', 'hallo'] }, { alts: ['world'] }] },
      { words: [{ alts: ['two'] }] }
    ])
    expect(r.text).toBe('hello world\ntwo')
    expect(r.candidates).toEqual([['hello', 'hallo'], ['world'], ['two']])
  })
  it('drops empty results', () => {
    expect(joinLines([{ words: [{ alts: [] }] }]).text).toBe('')
  })
})

// Needs the Polish handwriting recognizer, which build servers (CI) do not have.
describe.runIf(process.platform === 'win32' && !process.env.CI)('WindowsInkEngine', () => {
  const engine = new WindowsInkEngine(join(__dirname, '../../resources/ink-sidecar.ps1'))
  afterAll(() => engine.dispose())

  it('lists recognizers with their non-ASCII names intact', async () => {
    const names = await engine.listRecognizers()
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => /polskiego pisma odręcznego/.test(n))).toBe(true)
  }, 40000)

  it('returns text for strokes on two lines', async () => {
    const r = await engine.recognize({
      recognizer: '',
      lines: [
        [line(10, 10, 10, 40), circle(30, 28, 12)],
        [line(10, 70, 10, 100), circle(30, 88, 12)]
      ]
    })
    expect(r.ok).toBe(true)
    expect(r.text.split('\n')).toHaveLength(2)
    expect(r.text.replace(/\s/g, '').length).toBeGreaterThan(0)
    expect(r.candidates.length).toBeGreaterThan(0)
    expect(r.engine.name).toBe('windows-ink')
    expect(r.engine.recognizer).not.toBe('')
  }, 40000)

  it('handles a single-point stroke', async () => {
    const r = await engine.recognize({ recognizer: '', lines: [[[5, 5]]] })
    expect(r.ok).toBe(true)
  }, 40000)

  it('finds the named recognizer even with a non-ASCII name', async () => {
    const names = await engine.listRecognizers()
    const polish = names.find((n) => n.includes('polskiego')) as string
    const r = await engine.recognize({ recognizer: polish, lines: [[line(0, 0, 0, 30)]] })
    expect(r.ok).toBe(true)
    expect(r.engine.recognizer).toBe(polish)
  }, 40000)

  it('checks words against the spell checkers of every installed language', async () => {
    const call = (engine as unknown as { call: (r: object) => Promise<{ ok: boolean; valid: string[]; languages: number }> }).call.bind(engine)
    const r = await call({ method: 'spell', words: ['kot', 'hello', 'dziękuję', 'qwrtzzx', 'Francja'] })
    expect(JSON.stringify(r).slice(0, 300)).toContain('"ok":true')
    expect(r.languages).toBeGreaterThan(1)
    expect(r.valid).toContain('kot')
    expect(r.valid).toContain('hello')
    expect(r.valid).toContain('dziękuję')
    expect(r.valid).not.toContain('qwrtzzx')
    expect(r.valid).toContain('Francja')
  }, 40000)

  it('picks the reading made of real words when the languages disagree', async () => {
    const call = (engine as unknown as { call: (r: object) => Promise<Record<string, unknown>> }).call.bind(engine)
    const original = call
    let spellCalls = 0
    ;(engine as unknown as { call: (r: { method: string }) => Promise<Record<string, unknown>> }).call = async (r) => {
      if (r.method === 'spell') spellCalls++
      if (r.method !== 'recognizeAll') return original(r)
      return {
        ok: true,
        results: [
          { recognizer: 'first', lines: [{ words: [{ alts: ['qwrtzzx'] }, { alts: ['xkcdqq'] }] }] },
          { recognizer: 'second', lines: [{ words: [{ alts: ['dziękuję'] }, { alts: ['bardzo'] }] }] }
        ]
      }
    }
    try {
      const r = await engine.recognize({ recognizer: '', lines: [[[0, 0, 1, 1]]] })
      expect(spellCalls).toBe(1)
      expect(r.text).toBe('dziękuję bardzo')
      expect(r.engine.recognizer).toBe('second')
      expect(r.alternatives).toEqual([{ text: 'qwrtzzx xkcdqq', recognizer: 'first' }])
    } finally {
      delete (engine as unknown as { call?: unknown }).call
    }
  }, 40000)

  it('tries every recognizer in automatic mode and reports the others', async () => {
    const names = await engine.listRecognizers()
    const seg = (x0: number, y0: number, x1: number, y1: number) => line(x0, y0, x1, y1)
    const word = [
      seg(0, 0, 0, 100), seg(45, 40, 0, 72), seg(12, 62, 50, 100),
      circle(90, 70, 28),
      seg(150, 12, 150, 100), seg(130, 42, 172, 42)
    ].map((s) => s.map((v) => v / 8))
    const polish = names.find((n) => n.includes('polskiego')) as string
    const r = await engine.recognize({ recognizer: '', lines: [word], preferred: polish })
    expect(r.ok).toBe(true)
    expect(r.engine.recognizer).toBe(polish)
    expect(r.text).toBe('kot')
    expect(Array.isArray(r.alternatives)).toBe(true)
  }, 40000)

  it('recovers if the helper is killed', async () => {
    const child = (engine as unknown as { child: { kill: () => void } }).child
    child.kill()
    await new Promise((res) => setTimeout(res, 500))
    const names = await engine.listRecognizers()
    expect(names.length).toBeGreaterThan(0)
  }, 40000)
})
