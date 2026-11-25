/** Width, in CSS pixels, an HTML report is laid out at before it is turned into a PDF. */
export const CONTENT_WIDTH_PX = 1000
/** Blank border round each printed page, in inches (the same on every side). */
export const PAGE_MARGIN_IN = 0.4
/** Chromium and most PDF viewers refuse pages bigger than this, in inches. */
const MAX_PAGE_IN = 200

export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

/**
 * The PDF page for a report whose content is `contentPx` CSS pixels wide: wide enough to hold it
 * at full size, so wide tables are not squeezed, and in the proportions of an A4 page.
 */
export function pageSizeInches(contentPx: number): { width: number; height: number } {
  const content = Math.max(CONTENT_WIDTH_PX, Number.isFinite(contentPx) ? contentPx : CONTENT_WIDTH_PX)
  const width = Math.min(MAX_PAGE_IN, content / 96 + 2 * PAGE_MARGIN_IN)
  const height = Math.min(MAX_PAGE_IN, width * Math.SQRT2)
  return { width: round2(width), height: round2(height) }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** The report's title: its <title>, else its first <h1>, else empty. */
export function titleFromHtml(html: string): string {
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(html)
    const text = m ? plainText(m[1]) : ''
    if (text) return text.slice(0, 300)
  }
  return ''
}
