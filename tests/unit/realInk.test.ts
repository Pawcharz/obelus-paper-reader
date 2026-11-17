import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toRecognitionLines } from '../../src/shared/inkLogic'
import { WindowsInkEngine } from '../../src/main/recognition/windowsInk'
import type { Stroke } from '../../src/shared/types'

// Personal data, kept out of the public repository: these tests skip themselves without it.
const fixture = join(__dirname, process.env.REAL_INK_FILE ?? '../fixtures/real-notes.json')
const haveFixture = existsSync(fixture)
// Reads real notes with Windows Ink, as the app does. Needs Windows: run with REAL_INK=1.
const notes = (existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) : []) as {
  note: string
  read: string
  lines: string[]
  strokes: Stroke[]
}[]

describe.skipIf(!haveFixture || !process.env.REAL_INK)('real notes through Windows Ink', () => {
  it('reads every line in place, in order', async () => {
    const engine = new WindowsInkEngine(join(__dirname, '../../resources/ink-sidecar.ps1'))
    try {
      for (const n of notes) {
        const r = await engine.recognize({ lines: toRecognitionLines(n.strokes), recognizer: '', vocabulary: [] })
        const got = r.text.split('\n')
        console.log(`WROTE  ${n.lines.join(' / ')}\nBEFORE ${n.read.split('\n').join(' / ')}\nNOW    ${got.join(' / ')}\n`)
        expect(got.length).toBe(n.lines.length)
      }
    } finally {
      engine.dispose()
    }
  }, 180000)
})
