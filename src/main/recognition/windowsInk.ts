import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { RecognitionResult, RecognizedWord } from '../../shared/types'
import { joinLines, markRealWords, RecognitionEngine, RecognizeRequest } from './engine'
import { chooseBest, rawWordsIn } from './chooseBest'

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

const TIMEOUT_MS = 20000
/** PDF units are small next to the screen units the recognizer is tuned for. */
const INK_SCALE = 2

/** ConvertFrom-Json decodes \uXXXX, which avoids any stdin encoding problem with Polish names. */
export function jsonAscii(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  )
}

/** Windows Ink through a long-running PowerShell helper, which needs no build tools. */
export class WindowsInkEngine implements RecognitionEngine {
  readonly name = 'windows-ink'
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private ready: Promise<void> | null = null
  private disposed = false

  constructor(private readonly scriptPath: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true }
      )
      this.child = child
      const startTimer = setTimeout(() => reject(new Error('The ink helper did not start')), 30000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk
        let i: number
        while ((i = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, i).trim()
          this.buffer = this.buffer.slice(i + 1)
          if (!line) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line.replace(/^﻿/, ''))
          } catch {
            continue
          }
          if (msg.event === 'ready') {
            clearTimeout(startTimer)
            resolve()
            continue
          }
          const p = this.pending.get(msg.id as number)
          if (p) {
            clearTimeout(p.timer)
            this.pending.delete(msg.id as number)
            p.resolve(msg)
          }
        }
      })
      child.on('error', (err) => {
        clearTimeout(startTimer)
        reject(err)
      })
      child.on('exit', () => {
        clearTimeout(startTimer)
        this.child = null
        this.ready = null
        this.buffer = ''
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('The ink helper stopped'))
        }
        this.pending.clear()
        reject(new Error('The ink helper stopped'))
      })
    })
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  private async call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('Engine stopped')
    await this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Recognition timed out'))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin.write(jsonAscii({ ...request, id }) + '\n')
    })
  }

  async listRecognizers(): Promise<string[]> {
    const r = await this.call({ method: 'list' })
    if (!r.ok) throw new Error(String(r.error))
    return (r.recognizers as string[]) ?? []
  }

  async recognize(request: RecognizeRequest): Promise<RecognitionResult> {
    const engine = { name: this.name, recognizer: request.recognizer }
    if (!request.recognizer) return this.recognizeBest(request)
    try {
      const r = await this.call({
        method: 'recognize',
        recognizer: request.recognizer,
        scale: INK_SCALE,
        lines: request.lines
      })
      if (!r.ok) return { ok: false, text: '', candidates: [], engine, error: String(r.error) }
      const { text, candidates, words } = joinLines(r.lines as { words: { alts: string[]; box?: number[] }[] }[])
      return {
        ok: true,
        text,
        candidates,
        words: await this.markReal(words, request.vocabulary ?? []),
        engine: { name: this.name, recognizer: String(r.recognizer ?? '') }
      }
    } catch (e) {
      return { ok: false, text: '', candidates: [], engine, error: (e as Error).message }
    }
  }

  /** Runs every installed recognizer, or the ones chosen, so a note can be in any of those languages. */
  private async recognizeBest(request: RecognizeRequest): Promise<RecognitionResult> {
    const engine = { name: this.name, recognizer: '' }
    try {
      const r = await this.call({ method: 'recognizeAll', scale: INK_SCALE, lines: request.lines, only: request.only ?? [] })
      if (!r.ok) return { ok: false, text: '', candidates: [], engine, error: String(r.error) }
      const readings = (r.results as { recognizer: string; lines: { words: { alts: string[]; box?: number[] }[] }[] }[]).map((x) => ({
        recognizer: x.recognizer,
        ...joinLines(x.lines)
      }))
      if (readings.length === 0) {
        return { ok: false, text: '', candidates: [], engine, error: 'No handwriting recognizer is installed.' }
      }
      const words = [...new Set(readings.flatMap((x) => rawWordsIn(x.text)))]
      const spell = await this.call({ method: 'spell', words })
      const valid = new Set(spell.ok ? ((spell.valid as string[]) ?? []) : [])
      const paper = new Set(request.vocabulary ?? [])
      const chosen = chooseBest(readings, (w) => valid.has(w), (w) => paper.has(w), request.preferred)
      if (!chosen) return { ok: true, text: '', candidates: [], engine: { ...engine, recognizer: readings[0].recognizer } }
      const best = readings.find((x) => x.recognizer === chosen.best.recognizer)
      return {
        ok: true,
        text: chosen.best.text,
        candidates: chosen.best.candidates,
        alternatives: chosen.alternatives,
        words: best ? markRealWords(best.words, (w) => valid.has(w), (w) => paper.has(w)) : undefined,
        engine: { name: this.name, recognizer: chosen.best.recognizer }
      }
    } catch (e) {
      return { ok: false, text: '', candidates: [], engine, error: (e as Error).message }
    }
  }

  /** Spell-checks the words of a single-language reading, to tell real words from maths. */
  private async markReal(words: RecognizedWord[], vocabulary: string[]): Promise<RecognizedWord[]> {
    const list = [...new Set(words.flatMap((w) => rawWordsIn(w.text)))]
    let valid = new Set<string>()
    try {
      const spell = await this.call({ method: 'spell', words: list })
      if (spell.ok) valid = new Set((spell.valid as string[]) ?? [])
    } catch { /* no spell checker: only the paper's words count */ }
    const paper = new Set(vocabulary)
    return markRealWords(words, (w) => valid.has(w), (w) => paper.has(w))
  }

  dispose(): void {
    this.disposed = true
    this.child?.stdin.end()
    this.child?.kill()
  }
}
