/** Words in any alphabet as written, leaving out digits and symbols. */
export function rawWordsIn(text: string): string[] {
  return text.match(/\p{L}[\p{L}'’-]*/gu) ?? []
}

/** Lowercase words in any alphabet, leaving out digits and symbols. */
export function wordsIn(text: string): string[] {
  return rawWordsIn(text.toLowerCase())
}
