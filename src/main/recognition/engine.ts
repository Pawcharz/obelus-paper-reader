import { RecognitionResult, RecognizedWord, Rect } from '../../shared/types'

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
export function joinLines(lines: { words: { alts: string[]; box?: number[] }[] }[]): {
  text: string
  candidates: string[][]
  words: RecognizedWord[]
} {
  const candidates: string[][] = []
  const recognized: RecognizedWord[] = []
  const text = lines
    .map((l, line) => {
      const words = l.words.filter((w) => w.alts.length > 0)
      candidates.push(...words.map((w) => w.alts))
      for (const w of words) {
        const b = w.box
        recognized.push({ line, text: w.alts[0], ...(b && b.length === 4 ? { box: [b[0], b[1], b[2], b[3]] as Rect } : {}) })
      }
      return words.map((w) => w.alts[0]).join(' ')
    })
    .join('\n')
  return { text, candidates, words: recognized }
}

/** Marks which words are real (spelled right in a ticked language, or found in the paper). */
export function markRealWords(words: RecognizedWord[], isWord: (w: string) => boolean, inPaper: (w: string) => boolean): RecognizedWord[] {
  return words.map((w) => {
    // Only sentence punctuation and quotes may surround a real word. With brackets, digits or symbols
    // attached ("1(sei", "te)") it is maths read as letters, even if the letters spell a word.
    let bare = w.text.replace(/^["'“‘.\-–—•*]+/u, '').replace(/[.,;:!?"'”’/\\-]+$/u, '')
    // A bracket around a word is punctuation for longer words ("(semantically", "letters)."), but
    // around short letter runs it is usually maths ("(sec" from (s_t; …), "te)").
    const unbracketed = bare.replace(/^\(/, '').replace(/\)[.,;:!?]*$/, '')
    if (unbracketed !== bare) bare = unbracketed.length >= 4 ? unbracketed : '('
    return { ...w, real: bare.length > 0 && /^\p{L}+(?:[-'’]\p{L}+)*$/u.test(bare) && (isWord(bare) || inPaper(bare.toLowerCase())) }
  })
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
