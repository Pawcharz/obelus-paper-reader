import { ResolveOutcome, ResolvedPaper } from '../../shared/types'
import { findArxivId, findDoi, stripArxivVersion } from '../../shared/ids'
import { guessTitle, titleSimilarity } from './refText'

const USER_AGENT = 'PaperReader/0.1 (desktop app)'
const ARXIV_API = 'https://export.arxiv.org/api/query'
const S2_API = 'https://api.semanticscholar.org/graph/v1'
const S2_FIELDS = 'title,authors,year,venue,externalIds,openAccessPdf,url'
const MIN_TITLE_SIMILARITY = 0.6

export type Fetcher = (url: string) => Promise<Response>

export function defaultFetcher(url: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT } })
}

/** arXiv asks for at most one request every three seconds on a single connection. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private last = 0

  constructor(
    private readonly gapMs: number,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms))
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const remaining = this.last + this.gapMs - Date.now()
      if (remaining > 0) await this.wait(remaining)
      try {
        return await task()
      } finally {
        this.last = Date.now()
      }
    })
    this.tail = result.catch(() => undefined)
    return result
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function clean(s: string): string {
  return decodeXml(s).replace(/\s+/g, ' ').trim()
}

export function parseArxivFeed(xml: string): ResolvedPaper[] {
  const entries = xml.split(/<entry>/).slice(1).map((e) => e.split('</entry>')[0])
  const papers: ResolvedPaper[] = []
  for (const entry of entries) {
    const idMatch = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/.exec(entry)
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)
    if (!idMatch || !title) continue
    const arxiv = stripArxivVersion(idMatch[1])
    // The exact version is kept in the links, so it is clear which revision was fetched.
    const versioned = idMatch[1]
    const published = /<published>(\d{4})/.exec(entry)
    const doi = /<arxiv:doi[^>]*>([^<]+)</.exec(entry)
    const journal = /<arxiv:journal_ref[^>]*>([^<]+)</.exec(entry)
    papers.push({
      title: clean(title[1]),
      authors: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => clean(m[1])),
      year: published ? Number(published[1]) : null,
      venue: journal ? clean(journal[1]) : '',
      arxiv,
      doi: doi ? clean(doi[1]) : '',
      url: `https://arxiv.org/abs/${versioned}`,
      pdfUrl: `https://arxiv.org/pdf/${versioned}`,
      source: 'arxiv'
    })
  }
  return papers
}

interface S2Paper {
  title?: string
  authors?: { name?: string }[]
  year?: number | null
  venue?: string | null
  externalIds?: Record<string, string> | null
  openAccessPdf?: { url?: string | null } | null
  url?: string
}

export function fromSemanticScholar(p: S2Paper): ResolvedPaper | null {
  if (!p.title) return null
  const arxiv = p.externalIds?.ArXiv ? stripArxivVersion(p.externalIds.ArXiv) : ''
  const doi = p.externalIds?.DOI ?? ''
  const pdfUrl = arxiv ? `https://arxiv.org/pdf/${arxiv}` : (p.openAccessPdf?.url ?? '')
  return {
    title: p.title,
    authors: (p.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
    year: p.year ?? null,
    venue: p.venue ?? '',
    arxiv,
    doi,
    url: arxiv ? `https://arxiv.org/abs/${arxiv}` : (p.url ?? ''),
    pdfUrl,
    source: 'semantic-scholar'
  }
}

/** The first non-empty answer, or null once every source has answered with nothing. */
function firstFound<T>(sources: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let left = sources.length
    const done = () => {
      if (--left === 0) resolve(null)
    }
    for (const s of sources) s.then((v) => (v ? resolve(v) : done()), done)
  })
}

export class Resolver {
  private readonly arxivQueue: SerialQueue
  private readonly retryDelays: number[]
  private readonly arxivAfterMs: number

  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    options: { arxivGapMs?: number; retryDelays?: number[]; arxivAfterMs?: number } = {}
  ) {
    this.arxivQueue = new SerialQueue(options.arxivGapMs ?? 3100)
    this.retryDelays = options.retryDelays ?? [1000, 2500]
    this.arxivAfterMs = options.arxivAfterMs ?? 1000
  }

  /** The Semantic Scholar keyless pool is shared, so "too many requests" is normal and retried. */
  private async s2Get(path: string): Promise<S2Paper | null> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetcher(`${S2_API}${path}`)
      if (res.status === 404) return null
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.retryDelays.length) {
          throw new Error('Semantic Scholar is busy right now')
        }
        await new Promise((r) => setTimeout(r, this.retryDelays[attempt]))
        continue
      }
      if (!res.ok) throw new Error(`Semantic Scholar returned ${res.status}`)
      const body = (await res.json()) as S2Paper & { data?: S2Paper[] }
      return body.data ? (body.data[0] ?? null) : body
    }
  }

  private async arxivQuery(params: string): Promise<ResolvedPaper[]> {
    return this.arxivQueue.run(async () => {
      const res = await this.fetcher(`${ARXIV_API}?${params}`)
      if (!res.ok) throw new Error(`arXiv returned ${res.status}`)
      return parseArxivFeed(await res.text())
    })
  }

  async byArxivId(id: string): Promise<ResolvedPaper | null> {
    return (await this.arxivQuery(`id_list=${encodeURIComponent(id)}`))[0] ?? null
  }

  async byDoi(doi: string): Promise<ResolvedPaper | null> {
    const p = await this.s2Get(
      `/paper/DOI:${encodeURI(doi)}?fields=${S2_FIELDS}`
    )
    return p ? fromSemanticScholar(p) : null
  }

  /**
   * Asks Semantic Scholar first. If it is slow (its free pool is often busy) or has no open PDF,
   * arXiv is asked as well, and whichever finds the paper first wins.
   */
  async byTitle(title: string): Promise<ResolvedPaper | null> {
    const similar = (p: ResolvedPaper | null): boolean =>
      !!p && titleSimilarity(p.title, title) >= MIN_TITLE_SIMILARITY
    const s2 = this.s2Get(`/paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`)
      .then((p) => (p ? fromSemanticScholar(p) : null))
      .catch(() => null)
    const s2Good = s2.then((p) => (similar(p) && p?.pdfUrl ? p : null))
    const early = await Promise.race([
      s2Good,
      new Promise<'slow'>((r) => setTimeout(() => r('slow'), this.arxivAfterMs))
    ])
    if (early && early !== 'slow') return early
    const q = encodeURIComponent(`ti:"${title.replace(/"/g, ' ')}"`)
    const arxiv = this.arxivQuery(`search_query=${q}&max_results=5`)
      .catch(() => [] as ResolvedPaper[])
      .then((hits) => hits.find((h) => similar(h)) ?? null)
    const winner = await firstFound([s2Good, arxiv])
    if (winner) return winner
    const any = await s2
    return similar(any) ? any : null
  }

  /** Spec section 10, lookup order. Any failure is a normal outcome and never an exception. */
  async resolveReference(reference: string): Promise<ResolveOutcome> {
    const searchText = guessTitle(reference) || reference.trim().slice(0, 200)
    try {
      const arxiv = findArxivId(reference)
      if (arxiv) {
        const paper = await this.byArxivId(arxiv)
        if (paper) return { ok: true, paper }
      }
      // What is learned about the paper is kept even without an open PDF, so a copy already in
      // the library can still be recognised.
      let known: ResolvedPaper | null = null
      const doi = findDoi(reference)
      if (doi) {
        const paper = await this.byDoi(doi)
        if (paper?.pdfUrl) return { ok: true, paper }
        known = paper
      }
      const paper = await this.byTitle(searchText)
      if (paper?.pdfUrl) return { ok: true, paper }
      return { ok: false, reason: 'No open PDF found', searchText, paper: paper ?? known ?? undefined }
    } catch {
      return { ok: false, reason: 'No open PDF found', searchText }
    }
  }
}
