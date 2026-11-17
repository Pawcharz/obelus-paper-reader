import { describe, expect, it } from 'vitest'
import { chooseBest, Reading, scoreReading } from '../../src/main/recognition/chooseBest'

const dictionary = new Set(['to', 'jest', 'dobre', 'pytanie', 'why', 'does', 'this', 'hold', 'kot', 'hot'])
const isWord = (w: string) => dictionary.has(w)
const none = () => false
const reading = (recognizer: string, text: string): Reading => ({ recognizer, text, candidates: [] })

describe('scoreReading', () => {
  it('rates real words above gibberish', () => {
    expect(scoreReading('to jest dobre', isWord, none)).toBeGreaterThan(scoreReading('tu jat dohe', isWord, none))
  })
  it('marks down stray symbols', () => {
    expect(scoreReading('why', isWord, none)).toBeGreaterThan(scoreReading('why (0 16 1:', isWord, none))
  })
  it('counts jargon from the paper as real, with a bonus', () => {
    const inPaper = (w: string) => w === 'bezier'
    expect(scoreReading('bezier', isWord, none)).toBe(0)
    expect(scoreReading('bezier', isWord, inPaper)).toBeGreaterThan(1)
  })
  it('gives text with no letters a score of zero', () => {
    expect(scoreReading('?', isWord, none)).toBe(0)
  })
})

describe('chooseBest', () => {
  it('keeps a Polish note in Polish and an English note in English', () => {
    const polish = chooseBest([reading('en', 'to jet dobie'), reading('pl', 'to jest dobre')], isWord, none)
    expect(polish?.best.recognizer).toBe('pl')
    const english = chooseBest([reading('pl', 'why dols thus hod'), reading('en', 'why does this hold')], isWord, none)
    expect(english?.best.recognizer).toBe('en')
  })
  it('offers the other readings, without repeats', () => {
    const r = chooseBest(
      [reading('en', 'to jet'), reading('pl', 'to jest'), reading('ca', 'To Jet'), reading('es', 'tu jest')],
      isWord,
      none
    )
    expect(r?.best.text).toBe('to jest')
    expect(r?.alternatives.map((a) => a.text)).toEqual(['tu jest', 'to jet'])
  })
  it('gives ties to the most recently used recognizer, then to the order given', () => {
    const tied = [reading('pl', 'kot'), reading('en', 'hot')]
    expect(chooseBest(tied, isWord, none)?.best.recognizer).toBe('pl')
    expect(chooseBest(tied, isWord, none, 'en')?.best.recognizer).toBe('en')
  })
  it('lets words from the paper settle a tie', () => {
    const tied = [reading('pl', 'kot'), reading('en', 'hot')]
    expect(chooseBest(tied, isWord, (w) => w === 'hot')?.best.recognizer).toBe('en')
  })
  it('checks spelling as written, so a capitalised name can win', () => {
    const names = new Set(['Francja'])
    const r = chooseBest([reading('a', 'Arancja'), reading('b', 'Trancja'), reading('c', 'Francja')], (w) => names.has(w), none)
    expect(r?.best.text).toBe('Francja')
  })
  it('ignores empty readings and copes with having none', () => {
    expect(chooseBest([reading('a', ' '), reading('b', 'hot')], isWord, none)?.best.recognizer).toBe('b')
    expect(chooseBest([reading('a', '')], isWord, none)).toBeNull()
  })
})
