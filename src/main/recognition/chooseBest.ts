import { NoteReading } from '../../shared/types'
import { rawWordsIn, wordsIn } from '../../shared/words'

export { rawWordsIn, wordsIn }

export interface Reading extends NoteReading {
  candidates: string[][]
}

const PAPER_BONUS = 0.1
const PREFERRED_BONUS = 0.04

/**
 * How much a reading looks like real text, from 0 to about 1.1. Windows reports no confidence, so
 * this measures the share of letters in real words, with words from the paper counting as real.
 */
export function scoreReading(
  text: string,
  isWord: (w: string) => boolean,
  inPaper: (w: string) => boolean
): number {
  // Spelling is checked as written, since names like "Francja" are only valid with a capital.
  const words = rawWordsIn(text)
  if (words.length === 0) return 0
  let total = 0
  let valid = 0
  let paper = 0
  for (const w of words) {
    total += w.length
    if (inPaper(w.toLowerCase())) {
      valid += w.length
      paper += w.length
    } else if (isWord(w)) {
      valid += w.length
    }
  }
  // Stray symbols and digits are what a wrong-language recognizer tends to produce.
  const letters = words.join('').length
  const clean = Math.min(1, letters / Math.max(1, text.replace(/\s/g, '').length))
  return (valid / total) * (0.7 + 0.3 * clean) + (PAPER_BONUS * paper) / total
}

/** Picks the best reading. Ties go to the order given, after the recognizer used most recently. */
export function chooseBest(
  readings: Reading[],
  isWord: (w: string) => boolean,
  inPaper: (w: string) => boolean,
  preferred = ''
): { best: Reading; alternatives: NoteReading[] } | null {
  const usable = readings.filter((r) => r.text.trim() !== '')
  if (usable.length === 0) return null
  const score = (r: Reading): number =>
    scoreReading(r.text, isWord, inPaper) + (r.recognizer === preferred ? PREFERRED_BONUS : 0)
  const ranked = usable
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
  const best = ranked[0]
  const seen = new Set([best.text.trim().toLowerCase()])
  const alternatives: NoteReading[] = []
  for (const r of ranked.slice(1)) {
    const key = r.text.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    alternatives.push({ text: r.text, recognizer: r.recognizer })
  }
  return { best, alternatives }
}
