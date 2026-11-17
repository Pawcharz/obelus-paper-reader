import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guessTitle, titleSimilarity } from '../../src/main/lookup/refText'
import { Fetcher, fromSemanticScholar, parseArxivFeed, Resolver, SerialQueue } from '../../src/main/lookup/resolve'
import { purgeCache } from '../../src/main/cache'

describe('guessTitle', () => {
  const cases: [string, string][] = [
    ['[1] Ashish Vaswani, Noam Shazeer, and Niki Parmar. Attention is all you need. In Advances in Neural Information Processing Systems, 2017.', 'Attention is all you need'],
    ['Ho, J., Jain, A., and Abbeel, P. Denoising diffusion probabilistic models. In NeurIPS, 2020.', 'Denoising diffusion probabilistic models'],
    ['[12] G. Tevet et al. Human motion diffusion model. arXiv preprint arXiv:2209.14916, 2022.', 'Human motion diffusion model'],
    ['Peebles, W. and Xie, S. (2022). Scalable diffusion models with transformers. arXiv preprint.', 'Scalable diffusion models with transformers'],
    ['[3] J. Smith, “A quoted title of a paper,” in Proc. CVPR, 2019.', 'A quoted title of a paper']
  ]
  it.each(cases)('%s', (input, expected) => {
    expect(guessTitle(input)).toBe(expected)
  })
})

describe('titleSimilarity', () => {
  it('is high for the same title and low for different ones', () => {
    expect(titleSimilarity('Attention is All You Need', 'attention is all you need.')).toBe(1)
    expect(titleSimilarity('Attention is All You Need', 'A survey of graph networks')).toBeLessThan(0.3)
  })
})

describe('parsers', () => {
  it('reads an arXiv feed', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2301.12345v2</id>
      <published>2023-01-30T00:00:00Z</published>
      <title>A   Title &amp; More
        Words</title><author><name>Ann B</name></author><author><name>Cy D</name></author>
      <arxiv:doi xmlns:arxiv="x">10.1/abc</arxiv:doi></entry></feed>`
    const [p] = parseArxivFeed(xml)
    expect(p.arxiv).toBe('2301.12345')
    expect(p.title).toBe('A Title & More Words')
    expect(p.authors).toEqual(['Ann B', 'Cy D'])
    expect(p.year).toBe(2023)
    expect(p.doi).toBe('10.1/abc')
    expect(p.pdfUrl).toBe('https://arxiv.org/pdf/2301.12345v2')
    expect(p.url).toBe('https://arxiv.org/abs/2301.12345v2')
  })
  it('prefers the arXiv PDF on Semantic Scholar results', () => {
    const p = fromSemanticScholar({ title: 'T', externalIds: { ArXiv: '1.2v3', DOI: '10.1/x' }, openAccessPdf: { url: 'https://x/y.pdf' } })
    expect(p?.pdfUrl).toBe('https://arxiv.org/pdf/1.2')
    expect(fromSemanticScholar({ title: 'T', externalIds: {}, openAccessPdf: { url: 'https://x/y.pdf' } })?.pdfUrl).toBe('https://x/y.pdf')
    expect(fromSemanticScholar({ title: 'T', openAccessPdf: null })?.pdfUrl).toBe('')
  })
})

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const feed = (id: string, title: string) =>
  new Response(`<feed><entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title></entry></feed>`)

describe('Resolver', () => {
  const fast = { arxivGapMs: 0, retryDelays: [1, 1] }

  it('uses the arXiv ID in the entry first', async () => {
    const urls: string[] = []
    const f: Fetcher = async (u) => (urls.push(u), feed('1706.03762', 'Attention'))
    const r = await new Resolver(f, fast).resolveReference('[1] X. Attention. arXiv preprint arXiv:1706.03762, 2017.')
    expect(r.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('id_list=1706.03762')
  })

  it('finds a paper by title through Semantic Scholar', async () => {
    const f: Fetcher = async () => jsonRes({ data: [{ title: 'Denoising diffusion probabilistic models', externalIds: { ArXiv: '2006.11239' } }] })
    const r = await new Resolver(f, fast).resolveReference('Ho, J. and Abbeel, P. Denoising diffusion probabilistic models. In NeurIPS, 2020.')
    expect(r.ok && r.paper.arxiv).toBe('2006.11239')
  })

  it('rejects a match for a different title', async () => {
    const f: Fetcher = async (u) =>
      u.includes('semanticscholar')
        ? jsonRes({ data: [{ title: 'A completely different topic entirely', externalIds: { ArXiv: '1.1' } }] })
        : new Response('<feed></feed>')
    const r = await new Resolver(f, fast).resolveReference('A. Writer. Denoising diffusion probabilistic models. 2020.')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('No open PDF found')
      expect(r.searchText).toBe('Denoising diffusion probabilistic models')
    }
  })

  it('falls back to arXiv when Semantic Scholar is busy', async () => {
    const f: Fetcher = async (u) =>
      u.includes('semanticscholar') ? jsonRes({}, 429) : feed('2006.11239', 'Denoising diffusion probabilistic models')
    const r = await new Resolver(f, fast).resolveReference('A. W. Denoising diffusion probabilistic models. 2020.')
    expect(r.ok && r.paper.source).toBe('arxiv')
  })

  it('retries on a busy response, then succeeds', async () => {
    let calls = 0
    const f: Fetcher = async () =>
      ++calls < 2 ? jsonRes({}, 429) : jsonRes({ data: [{ title: 'Some good title here', externalIds: { ArXiv: '3.3' } }] })
    const r = await new Resolver(f, fast).resolveReference('A. W. Some good title here. 2020.')
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('turns a network failure into the normal no-PDF outcome', async () => {
    const f: Fetcher = async () => {
      throw new Error('offline')
    }
    const r = await new Resolver(f, fast).resolveReference('A. W. Some good title here. 2020.')
    expect(r).toMatchObject({ ok: false, reason: 'No open PDF found' })
  })

  it('reports no PDF for a paper with no open copy', async () => {
    const f: Fetcher = async (u) =>
      u.includes('semanticscholar') ? jsonRes({ data: [{ title: 'Some good title here', externalIds: {} }] }) : new Response('<feed></feed>')
    expect((await new Resolver(f, fast).resolveReference('A. W. Some good title here. 2020.')).ok).toBe(false)
  })
})

describe('SerialQueue', () => {
  it('runs tasks one at a time with the gap between them', async () => {
    let active = 0
    let maxActive = 0
    const waits: number[] = []
    const q = new SerialQueue(50, async (ms) => {
      waits.push(ms)
    })
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 2))
      active--
    }
    await Promise.all([q.run(task), q.run(task), q.run(task)])
    expect(maxActive).toBe(1)
    expect(waits.length).toBe(2)
  })
  it('keeps going after a failed task', async () => {
    const q = new SerialQueue(0)
    await expect(q.run(async () => { throw new Error('x') })).rejects.toThrow()
    expect(await q.run(async () => 7)).toBe(7)
  })
})

describe('purgeCache', () => {
  let dir: string
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()

  async function file(name: string, ageDays: number, size = 10): Promise<string> {
    const p = join(dir, name)
    await fs.writeFile(p, 'x'.repeat(size))
    const t = new Date(now - ageDays * DAY)
    await fs.utimes(p, t, t)
    return p
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pr-cache-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('deletes files past the age limit', async () => {
    const old = await file('old.pdf', 4)
    const fresh = await file('fresh.pdf', 1)
    const r = await purgeCache(dir, { maxAgeMs: 3 * DAY, maxBytes: 1e9, keep: new Set(), now })
    expect(r.deleted).toEqual([old])
    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })
  it('never deletes files in use', async () => {
    const old = await file('open.pdf', 10)
    await purgeCache(dir, { maxAgeMs: 3 * DAY, maxBytes: 0, keep: new Set([old]), now })
    await expect(fs.access(old)).resolves.toBeUndefined()
  })
  it('removes the oldest files above the size cap', async () => {
    const a = await file('a.pdf', 2, 100)
    const b = await file('b.pdf', 1, 100)
    const c = await file('c.pdf', 0.5, 100)
    const r = await purgeCache(dir, { maxAgeMs: 3 * DAY, maxBytes: 150, keep: new Set(), now })
    expect(r.deleted.sort()).toEqual([a, b].sort())
    expect(r.remainingBytes).toBe(100)
    await expect(fs.access(c)).resolves.toBeUndefined()
  })
  it('copes with a missing folder', async () => {
    expect((await purgeCache(join(dir, 'nope'), { maxAgeMs: 1, maxBytes: 1, keep: new Set() })).deleted).toEqual([])
  })
})
