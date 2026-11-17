import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitLines } from '../../src/shared/inkLogic'
import type { Stroke } from '../../src/shared/types'

// Personal data, kept out of the public repository: these tests skip themselves without it.
const fixture = join(__dirname, '../fixtures/real-notes.json')
const haveFixture = existsSync(fixture)
// Real notes from reading World Models (11 Nov 2026) that came out with lines in the wrong order,
// an inserted word on a line of its own, or the first letters of a line lost.
const notes = (existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : []) as {
  note: string
  lines: string[]
  strokes: Stroke[]
}[]

const middle = (s: Stroke) => {
  const ys = s.points.map((p) => p[1]).sort((a, b) => a - b)
  return ys[Math.floor(ys.length / 2)]
}

describe.skipIf(!haveFixture)('splitting real handwriting into lines', () => {
  for (const n of notes) {
    it(`${n.lines[0]}… has ${n.lines.length} line(s), top to bottom`, () => {
      const lines = splitLines(n.strokes.map((s) => ({ ...s, color: '', width: 1 })))
      expect(lines.length).toBe(n.lines.length)
      const mids = lines.map((l) => l.map(middle).sort((a, b) => a - b)[Math.floor(l.length / 2)])
      expect(mids).toEqual([...mids].sort((a, b) => a - b))
      // Every stroke is used exactly once.
      expect(lines.flat().length).toBe(n.strokes.length)
    })
  }
})
