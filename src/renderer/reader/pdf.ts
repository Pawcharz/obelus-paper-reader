import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { Rect } from '../../shared/types'
import { TextItemLike, Word, wordsFromItems } from '../../shared/pageText'
import type { PdfHints } from '../../shared/api'
import { authorsFromInfo, guessYear } from '../../shared/pdfDetails'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDoc = PDFDocumentProxy

export interface PdfLink {
  rect: Rect
  url?: string
  dest?: unknown
}

export interface PageData {
  words: Word[]
  links: PdfLink[]
}

export interface PageSize {
  width: number
  height: number
}

export interface ResolvedDest {
  page: number
  x: number | null
  y: number | null
}

export function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const base = new URL('./pdfjs/', document.baseURI).href
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`
  }).promise
}

export async function pageSizes(doc: PdfDoc): Promise<PageSize[]> {
  const out: PageSize[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
    out.push({ width: vp.width, height: vp.height })
  }
  return out
}

let measurer: CanvasRenderingContext2D | null = null

/**
 * Where each character of a text run starts. The PDF gives only the run's total width, so the
 * letters are measured in a similar font (serif, sans or monospace, as the PDF says) and scaled to
 * that width. Proportional letters then put word edges on the words, not a letter off.
 */
function charStarts(str: string, width: number, family: string): number[] | undefined {
  if (str.length < 2 || width <= 0) return undefined
  measurer ??= document.createElement('canvas').getContext('2d')
  if (!measurer) return undefined
  measurer.font = `100px ${family || 'serif'}`
  const widths = [...str].map((c) => measurer!.measureText(c).width)
  // Characters outside the basic plane count as two in a JS string; keep one start per code unit.
  if (widths.length !== str.length) return undefined
  const total = widths.reduce((a, b) => a + b, 0)
  if (total <= 0) return undefined
  const out = [0]
  for (const w of widths) out.push(out[out.length - 1] + (w / total) * width)
  return out
}

async function pageItems(page: PDFPageProxy): Promise<TextItemLike[]> {
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const styles = content.styles as Record<string, { fontFamily?: string }>
  const items: TextItemLike[] = []
  for (const it of content.items) {
    if (!('str' in it)) continue
    const t = it.transform as number[]
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue // rotated text
    const [x, baseline] = vp.convertToViewportPoint(t[4], t[5])
    const charX = charStarts(it.str, it.width, styles[it.fontName]?.fontFamily ?? 'serif')
    items.push({ str: it.str, x, baseline, width: it.width, fontHeight: Math.hypot(t[2], t[3]), ...(charX ? { charX } : {}) })
  }
  return items
}

export async function loadPageData(doc: PdfDoc, index: number): Promise<PageData> {
  const page = await doc.getPage(index + 1)
  const vp = page.getViewport({ scale: 1 })
  const words = wordsFromItems(await pageItems(page))
  const annots = await page.getAnnotations({ intent: 'display' })
  const links: PdfLink[] = []
  for (const a of annots) {
    if (a.subtype !== 'Link') continue
    const [x0, y0] = vp.convertToViewportPoint(a.rect[0], a.rect[1])
    const [x1, y1] = vp.convertToViewportPoint(a.rect[2], a.rect[3])
    links.push({
      rect: [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)],
      url: a.url,
      dest: a.dest
    })
  }
  return { words, links }
}

export async function resolveDest(doc: PdfDoc, dest: unknown): Promise<ResolvedDest | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[])
    if (!Array.isArray(explicit) || !explicit[0]) return null
    const page = await doc.getPageIndex(explicit[0] as never)
    const pg = await doc.getPage(page + 1)
    const vp = pg.getViewport({ scale: 1 })
    const kind = (explicit[1] as { name?: string } | undefined)?.name
    let left: number | null = null
    let top: number | null = null
    if (kind === 'XYZ') {
      left = (explicit[2] as number | null) ?? null
      top = (explicit[3] as number | null) ?? null
    } else if (kind === 'FitH' || kind === 'FitBH') {
      top = (explicit[2] as number | null) ?? null
    }
    const [x, y] = vp.convertToViewportPoint(left ?? 0, top ?? pg.view[3])
    return { page, x: left === null ? null : x, y: top === null ? null : y }
  } catch {
    return null
  }
}

/** A picture of part of a page, so a figure can be read later without the PDF open. */
export async function cropRegion(doc: PdfDoc, index: number, rect: Rect, scale = 2): Promise<Uint8Array> {
  const page = await doc.getPage(index + 1)
  const vp = page.getViewport({ scale })
  const full = document.createElement('canvas')
  full.width = Math.ceil(vp.width)
  full.height = Math.ceil(vp.height)
  await page.render({ canvas: full, viewport: vp }).promise
  const crop = document.createElement('canvas')
  crop.width = Math.max(1, Math.round(rect[2] * scale))
  crop.height = Math.max(1, Math.round(rect[3] * scale))
  crop.getContext('2d')?.drawImage(full, -rect[0] * scale, -rect[1] * scale)
  const blob = await new Promise<Blob | null>((r) => crop.toBlob(r, 'image/png'))
  if (!blob) throw new Error('Could not make the picture')
  return new Uint8Array(await blob.arrayBuffer())
}

export function firstPageHints(items: { text: string; fontHeight: number }[]): string {
  if (items.length === 0) return ''
  const max = Math.max(...items.map((i) => i.fontHeight))
  return items
    .filter((i) => i.fontHeight >= max - 0.5)
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300)
}

/** First-page text and the largest line, used to identify a dropped PDF. */
export async function extractHints(bytes: Uint8Array): Promise<PdfHints> {
  try {
    const doc = await openPdf(bytes)
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    const items = content.items.flatMap((it) =>
      'str' in it ? [{ text: it.str, fontHeight: Math.hypot(it.transform[2], it.transform[3]) }] : []
    )
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as { Title?: string; Author?: string; CreationDate?: string }
    const metaTitle = String(info.Title ?? '').trim()
    const firstPageText = items.map((i) => i.text).join(' ').slice(0, 6000)
    const large = firstPageHints(items)
    await doc.loadingTask.destroy()
    return {
      firstPageText,
      titleGuess: large || metaTitle,
      authorsGuess: authorsFromInfo(String(info.Author ?? '')),
      yearGuess: guessYear(firstPageText, String(info.CreationDate ?? ''))
    }
  } catch {
    return { firstPageText: '', titleGuess: '' }
  }
}
