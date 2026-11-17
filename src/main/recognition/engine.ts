import { RecognitionResult } from '../../shared/types'

/** One stroke as a flat list: x, y, x, y, ... */
export type FlatStroke = number[]

export interface RecognizeRequest {
  /** Strokes grouped into written lines, top to bottom. */
  lines: FlatStroke[][]
  /** Recognizer name from the settings; empty tries every one available and keeps the best. */
  recognizer: string
  /** With no single recognizer: only these are tried. Empty or missing tries every one. */
  only?: string[]
  /** Words from the paper being read, which count as real words even when they are jargon. */
  vocabulary?: string[]
  /** The recognizer used most recently, which wins ties. */
  preferred?: string
}

/** The contract every handwriting engine has to meet. Spec section 3. */
export interface RecognitionEngine {
  readonly name: string
  listRecognizers(): Promise<string[]>
  recognize(request: RecognizeRequest): Promise<RecognitionResult>
  dispose(): void
}

/** Used when no engine exists on this platform: ink is kept and the interface says so. */
export class NullEngine implements RecognitionEngine {
  readonly name = 'none'
  async listRecognizers(): Promise<string[]> {
    return []
  }
  async recognize(): Promise<RecognitionResult> {
    return {
      ok: false,
      text: '',
      candidates: [],
      engine: { name: this.name, recognizer: '' },
      error: 'No handwriting engine is available on this system.'
    }
  }
  dispose(): void {}
}

/** Joins per-word alternatives into text, keeping one line of text per written line. */
export function joinLines(lines: { words: { alts: string[] }[] }[]): {
  text: string
  candidates: string[][]
} {
  const candidates: string[][] = []
  const text = lines
    .map((l) => {
      const words = l.words.filter((w) => w.alts.length > 0)
      candidates.push(...words.map((w) => w.alts))
      return words.map((w) => w.alts[0]).join(' ')
    })
    .join('\n')
  return { text, candidates }
}

/**
 * Which recognizers the settings allow: one chosen language is used alone; several are all tried
 * and the best reading kept; none chosen tries every installed one.
 */
export function recognizerChoice(s: { recognizer: string; recognizers?: string[] }): { recognizer: string; only: string[] } {
  const list = [...new Set((s.recognizers ?? []).filter(Boolean))]
  if (list.length === 1) return { recognizer: list[0], only: [] }
  if (list.length > 1) return { recognizer: '', only: list }
  return { recognizer: s.recognizer, only: [] }
}
