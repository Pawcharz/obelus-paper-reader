import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PaperStore } from '../../src/main/storage/paperStore'
import { MapStore } from '../../src/main/storage/mapStore'
import { folderNameFor, findArxivId, findDoi, slugifyTitle } from '../../src/shared/ids'
import { parseFrontmatter, renderFrontmatter } from '../../src/main/storage/frontmatter'
import { writeAtomic } from '../../src/main/storage/atomic'

let root: string
let store: PaperStore

const base = {
  id: 'arxiv:2410.24034',
  title: 'Handwriting Recognition: A Study',
  authors: ['A. Author', 'B. Writer'],
  year: 2024,
  venue: '',
  arxiv: '2410.24034',
  doi: '',
  url: 'https://arxiv.org/abs/2410.24034'
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pr-test-'))
  store = new PaperStore(root)
  await store.ensure('Test', 'ws1')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('ids', () => {
  it('names folders by ID and title', () => {
    expect(folderNameFor('arxiv:2410.24034', 'Hello, World!')).toBe('arxiv-2410.24034--hello-world')
  })
  it('caps the slug at 60 characters', () => {
    expect(slugifyTitle('word '.repeat(50)).length).toBeLessThanOrEqual(60)
  })
  it('finds arXiv IDs only when marked or bare', () => {
    expect(findArxivId('arXiv preprint arXiv:1706.03762, 2017.')).toBe('1706.03762')
    expect(findArxivId('https://arxiv.org/abs/2410.24034v2')).toBe('2410.24034')
    expect(findArxivId('https://arxiv.org/pdf/2410.24034.pdf')).toBe('2410.24034')
    expect(findArxivId('2410.24034')).toBe('2410.24034')
    expect(findArxivId('In Proc. pages 1234.5678 of the thing')).toBe('')
  })
  it('finds DOIs and drops trailing punctuation', () => {
    expect(findDoi('see https://doi.org/10.1145/3528223.3530178.')).toBe('10.1145/3528223.3530178')
  })
})

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = renderFrontmatter({ id: 'x', tags: ['a', 'b'] }, 'Body text\n')
    const parsed = parseFrontmatter(text)
    expect(parsed.data).toEqual({ id: 'x', tags: ['a', 'b'] })
    expect(parsed.body.trim()).toBe('Body text')
  })
  it('keeps the text of a file with broken YAML', () => {
    const parsed = parseFrontmatter('---\n: : [\n---\nBody')
    expect(parsed.data).toEqual({})
    expect(parsed.body).toContain('Body')
  })
  it('handles a file with no frontmatter', () => {
    expect(parseFrontmatter('just text').body).toBe('just text')
  })
})

describe('atomic write', () => {
  it('leaves no temporary files', async () => {
    const p = join(root, 'a', 'b.txt')
    await writeAtomic(p, 'one')
    await writeAtomic(p, 'two')
    expect(await fs.readFile(p, 'utf8')).toBe('two')
    expect(await fs.readdir(join(root, 'a'))).toEqual(['b.txt'])
  })
})

describe('PaperStore', () => {
  it('adds a paper with a PDF and finds it after reopening', async () => {
    const pdf = join(root, 'source.pdf')
    await fs.writeFile(pdf, '%PDF-test')
    const entry = await store.add({ meta: base, pdf: { path: pdf, move: false } })
    expect(entry.folder.endsWith('arxiv-2410.24034--handwriting-recognition-a-study')).toBe(true)
    expect(await fs.readFile(store.pdfPath(entry), 'utf8')).toBe('%PDF-test')
    expect(await fs.readFile(pdf, 'utf8')).toBe('%PDF-test')

    const reopened = new PaperStore(root)
    const list = await reopened.refresh()
    expect(list).toHaveLength(1)
    expect(list[0].meta.title).toBe('Handwriting Recognition: A Study')
    expect(list[0].meta.has_pdf).toBe(true)
    expect(list[0].meta.status).toBe('unread')
  })

  it('moves the file when asked', async () => {
    const pdf = join(root, 'cache.pdf')
    await fs.writeFile(pdf, '%PDF')
    await store.add({ meta: base, pdf: { path: pdf, move: true } })
    await expect(fs.access(pdf)).rejects.toThrow()
  })

  it('turns a stub into a full paper', async () => {
    const stub = await store.add({ meta: base })
    expect(stub.meta.has_pdf).toBe(false)
    const pdf = join(root, 's.pdf')
    await fs.writeFile(pdf, '%PDF')
    const full = await store.add({ meta: base, pdf: { path: pdf, move: false } })
    expect(full.meta.has_pdf).toBe(true)
    expect(full.folder).toBe(stub.folder)
  })

  it('finds a paper after its folder is renamed', async () => {
    const entry = await store.add({ meta: base })
    await fs.rename(entry.folder, join(root, 'papers', 'renamed'))
    await store.refresh()
    expect((await store.get(base.id))?.folder.endsWith('renamed')).toBe(true)
  })

  it('keeps layers separate per author', async () => {
    await store.add({ meta: base })
    const layer = await store.loadLayer(base.id, 'me')
    expect(layer.annotations.marginNotes).toEqual([])
    layer.ink.strokes.push({
      id: 's1',
      page: 0,
      points: [[1, 2, 0.5, 0]],
      color: '#000',
      width: 1,
      createdAt: 'x'
    })
    await store.saveLayer(base.id, 'me', layer)
    expect((await store.loadLayer(base.id, 'me')).ink.strokes).toHaveLength(1)
    expect((await store.loadLayer(base.id, 'other')).ink.strokes).toHaveLength(0)
  })

  it('preserves the body of paper.md on metadata updates', async () => {
    const entry = await store.add({ meta: base })
    const file = join(entry.folder, 'paper.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')) + 'My own text\n')
    await store.update(base.id, { tags: ['x'], status: 'read', read_on: '2026-11-09' })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('My own text')
    expect(text).toContain('status: read')
  })

  it('reads side notes written by hand and survives odd files', async () => {
    const entry = await store.add({ meta: base })
    const created = await store.createSideNote(base.id, 'me', { title: 'Mine', body: 'hello' })
    expect(created.path).toContain('people')
    const dir = join(entry.folder, 'people', 'me', 'notes')
    await fs.writeFile(join(dir, 'claude.md'), '---\ngenerated_by: claude\ntitle: Summary\n---\nText')
    await fs.writeFile(join(dir, 'plain.md'), 'No frontmatter at all')
    await fs.writeFile(join(dir, 'ignored.txt'), 'not a note')
    const notes = await store.listSideNotes(base.id)
    expect(notes.map((n) => n.title).sort()).toEqual(['Mine', 'Summary', 'plain'])
    expect(notes.find((n) => n.title === 'Summary')?.generated_by).toBe('claude')
  })

  it('refuses to write notes outside the workspace', async () => {
    expect(() => store.sideNotePath(join(tmpdir(), 'elsewhere.md'))).toThrow()
  })

  it('searches titles, tags and margin notes', async () => {
    await store.add({ meta: { ...base, tags: ['motion'] } })
    const layer = await store.loadLayer(base.id, 'me')
    layer.annotations.marginNotes.push({
      id: 'm', page: 0, box: [0, 0, 1, 1], strokeIds: [], text: 'skąd ta metryka',
      candidates: [], corrected: false, kind: 'note', targetIds: [], createdAt: '', updatedAt: ''
    })
    await store.saveLayer(base.id, 'me', layer)
    expect(await store.search('motion', 'me')).toEqual([base.id])
    expect(await store.search('metryka', 'me')).toEqual([base.id])
    expect(await store.search('handwriting skąd', 'me')).toEqual([base.id])
    expect(await store.search('nothere', 'me')).toEqual([])
  })
})

describe('MapStore', () => {
  it('creates, saves and lists maps, tolerating broken files', async () => {
    const maps = new MapStore(root)
    const m = await maps.create('Bezier Motion')
    expect(m.id).toBe('bezier-motion')
    expect((await maps.create('Bezier Motion')).id).toBe('bezier-motion-2')
    await fs.writeFile(join(root, 'maps', 'broken.json'), '{ not json')
    await fs.writeFile(join(root, 'maps', 'hand.json'), JSON.stringify({ name: 'Hand', edges: [{ from: 'a', to: 'b' }] }))
    const list = await maps.list()
    expect(list.map((x) => x.name)).toEqual(['Bezier Motion', 'Bezier Motion', 'Hand'])
    expect(list.find((x) => x.name === 'Hand')?.edges[0].status).toBe('confirmed')
  })
})

describe('map positions', () => {
  it('keeps where papers were moved by hand when a map is saved and loaded', async () => {
    const { MapStore } = await import('../../src/main/storage/mapStore')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'pr-maps-'))
    const store = new MapStore(dir)
    const m = await store.create('Moves')
    await store.save({ ...m, nodes: [{ paperId: 'a' }], positions: { a: { x: 40, y: 300 }, bad: { x: NaN, y: 1 } } })
    const [loaded] = await store.list()
    expect(loaded.positions).toEqual({ a: { x: 40, y: 300 } })
  })
})
