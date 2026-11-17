/** Guesses about a PDF found by no lookup, shown for the reader to check before it is added. */

const NOT_A_PERSON = /^(admin|administrator|user|owner|unknown|author|microsoft|adobe|latex|tex)\b/i

/** Authors from a PDF's own "Author" field, split on commas, semicolons and "and". */
export function authorsFromInfo(author: string): string[] {
  const s = (author ?? '').trim()
  if (!s || /\d|@/.test(s)) return []
  return s
    .split(/\s*(?:;|,|\band\b|&)\s*/i)
    .map((a) => a.trim())
    .filter((a) => /[a-z]/i.test(a) && a.length > 1 && !NOT_A_PERSON.test(a))
}

/** The year of a PDF date such as "D:20150827120000". */
export function yearFromPdfDate(date: string): number | null {
  const m = /^(?:D:)?(\d{4})/.exec((date ?? '').trim())
  const y = m ? Number(m[1]) : NaN
  return y >= 1950 && y <= 2049 ? y : null
}

/**
 * The year a paper came out: the first year written on its first page (a date line or a copyright
 * usually comes before any references), else the year the PDF file was made.
 */
export function guessYear(firstPageText: string, creationDate = ''): number | null {
  const now = new Date().getFullYear()
  for (const m of (firstPageText ?? '').matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)) {
    const y = Number(m[1])
    if (y <= now) return y
  }
  return yearFromPdfDate(creationDate)
}

/** Authors typed in one box, separated by commas or semicolons. */
export function parseAuthors(text: string): string[] {
  return (text ?? '').split(/\s*[;,]\s*/).map((a) => a.trim()).filter(Boolean)
}

/** A typed year, or null when it is empty or not a plausible year. */
export function parseYear(text: string): number | null {
  const y = Number((text ?? '').trim())
  return Number.isInteger(y) && y >= 1800 && y <= 2100 ? y : null
}
