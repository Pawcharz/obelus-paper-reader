import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stands in for the network in end-to-end tests, switched on with PAPER_READER_FAKE_NET.
 * Set it to a folder holding sample.pdf.
 */
export async function fakeFetcher(url: string): Promise<Response> {
  const root = process.env.PAPER_READER_FAKE_NET as string
  if (url.includes('export.arxiv.org')) {
    const id = /id_list=([^&]+)/.exec(url)?.[1] ?? '9999.00001'
    const decoded = decodeURIComponent(id)
    const xml = `<feed><entry><id>http://arxiv.org/abs/${decoded}v1</id>
      <published>2024-01-01T00:00:00Z</published>
      <title>Fake Paper ${decoded}</title>
      <author><name>Test Author</name></author></entry></feed>`
    return new Response(url.includes('id_list') ? xml : '<feed></feed>', { status: 200 })
  }
  if (url.includes('api.semanticscholar.org')) {
    const q = decodeURIComponent(/query=([^&]+)/.exec(url)?.[1] ?? '')
    if (q.toLowerCase().includes('nothing')) return new Response('{}', { status: 404 })
    // One slow answer, so tests can see what happens while a lookup is running.
    if (q.includes('Implicit Curves')) await new Promise((r) => setTimeout(r, 4000))
    return new Response(
      JSON.stringify({
        data: [
          {
            title: q,
            authors: [{ name: 'Test Author' }],
            year: 2023,
            venue: 'Test Venue',
            externalIds: { ArXiv: '2301.00001' },
            openAccessPdf: { url: 'https://example.test/x.pdf' }
          }
        ]
      }),
      { status: 200 }
    )
  }
  if (url.includes('arxiv.org/pdf') || url.endsWith('.pdf')) {
    return new Response(readFileSync(join(root, 'sample.pdf')), { status: 200 })
  }
  return new Response('not found', { status: 404 })
}
