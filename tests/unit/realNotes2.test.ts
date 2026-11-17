import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitLines } from '../../src/shared/inkLogic'
import type { Stroke } from '../../src/shared/types'

// Personal data, kept out of the public repository: these tests skip themselves without it.
const fixture = join(__dirname, '../fixtures/real-notes-2.json')
const haveFixture = existsSync(fixture)
// Real notes from the second World Models session (11 Nov 2026, evening): a "?" that came out on a
// line of its own, and a one-word last line ("it.") that was folded into the line above.
const notes = (existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : []) as {
  note: string
  lines: string[]
  strokes: Stroke[]
}[]

const box = (l: Stroke[]) => {
  const xs = l.flatMap((s) => s.points.map((p) => p[0]))
  const ys = l.flatMap((s) => s.points.map((p) => p[1]))
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round)
}

describe.skipIf(!haveFixture)('splitting real handwriting into lines, second session', () => {
  for (const n of notes) {
    it(`${n.lines[0]}… has ${n.lines.length} line(s)`, () => {
      const lines = splitLines(n.strokes.map((s) => ({ ...s, color: '', width: 1 })))
      if (process.env.SHOW) console.log(n.note, lines.map((l) => `${l.length} ${box(l)}`))
      expect(lines.length).toBe(n.lines.length)
      expect(lines.flat().length).toBe(n.strokes.length)
    })
  }
})
