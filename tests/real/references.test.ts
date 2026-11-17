import { describe, expect, it } from 'vitest'
import { promises as fs, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { referenceEntryAt, TextItemLike, Word, wordsFromItems } from '../../src/shared/pageText'
import { guessTitle } from '../../src/main/lookup/refText'
import { Resolver } from '../../src/main/lookup/resolve'

const DIR = process.env.REAL_PDF_DIR ?? ''

async function pageWords(page: pdfjs.PDFPageProxy): Promise<Word[]> {
  const vp = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items: TextItemLike[] = []
  for (const it of content.items) {
    if (!('str' in it)) continue
    const t = it.transform as number[]
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue
    const [x, baseline] = vp.convertToViewportPoint(t[4], t[5])
    items.push({ str: it.str, x, baseline, width: it.width, fontHeight: Math.hypot(t[2], t[3]) })
  }
  return wordsFromItems(items)
}

interface Row { file: string; links: number; entry: string; title: string }

async function citationEntries(path: string): Promise<Row[]> {
  const data = new Uint8Array(await fs.readFile(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise
  const seen = new Set<string>()
  const rows: Row[] = []
  const cache = new Map<number, Word[]>()
  const named = await doc.getDestinations()
  const hasNamedCites = Object.keys(named).some((k) => /cite/i.test(k))
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    for (const a of await page.getAnnotations({ intent: 'display' })) {
      if (a.subtype !== 'Link' || !a.dest) continue
      const key = typeof a.dest === 'string' ? a.dest : JSON.stringify(a.dest)
      if (typeof a.dest === 'string' ? !/cite/i.test(a.dest) : hasNamedCites) continue
      if (seen.has(key)) continue
      seen.add(key)
      const dest = typeof a.dest === 'string' ? await doc.getDestination(a.dest) : a.dest
      if (!Array.isArray(dest)) continue
      const pageIndex = await doc.getPageIndex(dest[0] as never)
      const pg = await doc.getPage(pageIndex + 1)
      const vp = pg.getViewport({ scale: 1 })
      if (!cache.has(pageIndex)) cache.set(pageIndex, await pageWords(pg))
      const left = (dest[2] as number | null) ?? null
      const top = (dest[3] as number | null) ?? null
      const [x, y] = vp.convertToViewportPoint(left ?? 0, top ?? pg.view[3])
      const entry = referenceEntryAt(cache.get(pageIndex) as Word[], left === null ? null : x, top === null ? null : y)
      rows.push({ file: path, links: 0, entry, title: guessTitle(entry) })
    }
  }
  await doc.loadingTask.destroy()
  return rows
}

describe.runIf(DIR)('real papers', () => {
  it('extracts bibliography entries and titles', async () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.pdf'))
    let total = 0
    let good = 0
    for (const f of files) {
      const rows = await citationEntries(join(DIR, f))
      const ok = rows.filter((r) => r.title.split(/\s+/).length >= 3 && r.entry.length > 30 && r.entry.length < 500)
      total += rows.length
      good += ok.length
      console.log(`\n=== ${f}: ${ok.length}/${rows.length}`)
      for (const r of rows.slice(0, 1)) console.log(`  TITLE: ${r.title}`)
      for (const r of rows.filter((x) => !ok.includes(x)).slice(0, 3)) console.log(`  BAD:   ${r.entry.slice(0, 130)} => ${r.title.slice(0, 70)}`)
    }
    console.log(`\nTOTAL plausible: ${good}/${total}`)
    expect(total).toBeGreaterThan(0)
  })
})

describe.runIf(process.env.REAL_NET)('live services', () => {
  const resolver = new Resolver()
  it('resolves references over the real network', async () => {
    const refs = [
      'Ashish Vaswani et al. Attention is all you need. arXiv preprint arXiv:1706.03762, 2017.',
      'J. Ho, A. Jain, and P. Abbeel. Denoising diffusion probabilistic models. In NeurIPS, 2020.',
      'G. Tevet, S. Raab, B. Gordon, Y. Shafir, D. Cohen-Or, and A. H. Bermano. Human motion diffusion model. In ICLR, 2023.',
      'Z. Nobody. A title that certainly does not exist anywhere zzqx. Journal of Nothing, 1901.'
    ]
    for (const ref of refs) {
      const r = await resolver.resolveReference(ref)
      console.log(JSON.stringify(r).slice(0, 400))
    }
    const first = await resolver.resolveReference(refs[0])
    expect(first.ok).toBe(true)
    if (first.ok) {
      const res = await fetch(first.paper.pdfUrl, { headers: { 'User-Agent': 'PaperReader/0.1 (desktop app)' } })
      const bytes = new Uint8Array(await res.arrayBuffer())
      console.log('pdf bytes', bytes.length, Buffer.from(bytes.subarray(0, 5)).toString())
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-')
    }
  })
})
