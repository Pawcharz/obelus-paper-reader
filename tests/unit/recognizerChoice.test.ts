import { describe, expect, it } from 'vitest'
import { recognizerChoice } from '../../src/main/recognition/engine'

const pl = 'Microsoft Polish Handwriting Recognizer'
const en = 'Microsoft English (US) Handwriting Recognizer'

describe('recognizerChoice', () => {
  it('tries only the languages ticked, such as Polish and English', () => {
    expect(recognizerChoice({ recognizer: '', recognizers: [pl, en] })).toEqual({ recognizer: '', only: [pl, en] })
  })
  it('uses one ticked language alone', () => {
    expect(recognizerChoice({ recognizer: '', recognizers: [en] })).toEqual({ recognizer: en, only: [] })
  })
  it('tries every language when none is ticked, and keeps an older single choice', () => {
    expect(recognizerChoice({ recognizer: '' })).toEqual({ recognizer: '', only: [] })
    expect(recognizerChoice({ recognizer: pl, recognizers: [] })).toEqual({ recognizer: pl, only: [] })
  })
})
