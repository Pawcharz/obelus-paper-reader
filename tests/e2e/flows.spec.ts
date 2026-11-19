import { expect, Page, test } from '@playwright/test'
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtures, launch, Launched } from './helpers'
import type { PaperEntry, ReadingMap } from '../../src/shared/types'

const links = JSON.parse(readFileSync(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>

async function rightClick(page: Page, pageIndex: number, [x, y]: [number, number]) {
  await page.evaluate(
    ({ pageIndex, x, y }) => {
      const canvas = document.querySelector(`[data-testid="live-${pageIndex}"]`) as HTMLCanvasElement
      const wrap = canvas.closest('.page-wrap') as HTMLElement
      const zoom = Number(wrap.dataset.zoom)
      const margin = Number(wrap.dataset.margin)
      const rect = wrap.getBoundingClientRect()
      canvas.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: rect.left + (x + margin) * zoom, clientY: rect.top + y * zoom
      }))
    },
    { pageIndex, x, y }
  )
}

async function addSample(run: Launched, title = 'Sample'): Promise<PaperEntry> {
  return run.page.evaluate(
    async ({ path, title }) => {
      const r = await window.api.addPaperFromFile(path, { firstPageText: '', titleGuess: '' }, title)
      if (!r.ok) throw new Error(r.reason)
      return r.entry
    },
    { path: join(fixtures, 'sample.pdf'), title }
  )
}

async function refreshLibrary(page: Page) {
  await page.getByTestId('nav-map').click()
  await page.getByTestId('nav-library').click()
}

async function openFirst(page: Page) {
  await page.getByTestId('paper-row').first().locator('.title-cell').click()
  await page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await page.waitForTimeout(300)
}

let run: Launched
test.beforeEach(async () => {
  run = await launch()
})
test.afterEach(async () => {
  await run.close().catch(() => undefined)
  await fs.rm(run.dir, { recursive: true, force: true }).catch(() => undefined)
})

test.describe('side notes', () => {
  test('a file written by another program appears live, with math', async () => {
    const entry = await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    const dir = join(entry.folder, 'people', 'test-author', 'notes')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'claude.md'), '---\ntitle: AI summary\ngenerated_by: claude\nkind: summary\n---\n\nThe loss is $x^2$.\n')
    const tab = run.page.getByTestId('tab-note').filter({ hasText: 'AI summary' })
    await expect(tab).toBeVisible({ timeout: 8000 })
    await tab.click()
    await expect(run.page.getByTestId('note-rendered').locator('.katex')).toHaveCount(1)
    await fs.writeFile(join(dir, 'claude.md'), '---\ntitle: AI summary\ngenerated_by: claude\n---\n\nUpdated text.\n')
    await expect(run.page.getByTestId('note-rendered')).toContainText('Updated text', { timeout: 8000 })
    await fs.rm(join(dir, 'claude.md'))
    await expect(tab).toHaveCount(0, { timeout: 8000 })
  })

  test('a long display equation wraps onto new lines, or scrolls on its own; the note stays the width of the pane', async () => {
    const entry = await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    const dir = join(entry.folder, 'people', 'test-author', 'notes')
    await fs.mkdir(dir, { recursive: true })
    const eq = String.raw`\ln \int \prod_{t=1}^{T} p(s_t\mid s_{t-1},a_{t-1})\,p(o_t\mid s_t)\;ds_{1:T} \;\ge\; \sum_{t=1}^{T}\Big(\underbrace{\mathbb{E}_q[\ln p(o_t\mid s_t)]}_{\text{reconstruction}} - \underbrace{\mathbb{E}\big[\mathrm{KL}[q(s_t\mid\cdot)\,\|\,p(s_t\mid s_{t-1},a_{t-1})]\big]}_{\text{complexity}}\Big)`
    await fs.writeFile(join(dir, 'eq.md'), '---\ntitle: Bound\n---\n\nThe bound:\n\n$$\n' + eq + '\n$$\n\nAnd $p(s_t \\mid s_{t-1})$ inline.\n')
    await run.page.getByTestId('tab-note').filter({ hasText: 'Bound' }).click()
    const rendered = run.page.getByTestId('note-rendered')
    const block = rendered.getByTestId('math-block')
    await expect(block).toHaveClass(/wrap/)
    const sizes = () => rendered.evaluate((el) => {
      const b = el.querySelector('[data-testid="math-block"]') as HTMLElement
      const sub = el.querySelector('p .msupsub') as HTMLElement
      const base = sub?.closest('.mord')?.firstElementChild as HTMLElement
      return {
        noteScroll: el.scrollWidth - el.clientWidth, blockScroll: b.scrollWidth - b.clientWidth, blockHeight: b.clientHeight,
        // A subscript sits below the letter it belongs to.
        subLower: sub && base ? sub.getBoundingClientRect().bottom > base.getBoundingClientRect().bottom + 2 : false
      }
    })
    let m = await sizes()
    expect(m.noteScroll).toBe(0)
    expect(m.subLower).toBe(true)
    // Wrapped: on more than one line, so taller than the one-line version below.
    const wrappedHeight = m.blockHeight
    await run.page.getByTestId('nav-settings').click()
    await run.page.getByTestId('math-layout-select').selectOption('scroll')
    await run.page.getByTestId('settings-save').click()
    expect((await run.page.evaluate(() => window.api.getSettings())).mathLayout).toBe('scroll')
    await expect(block).toHaveClass(/scroll/)
    m = await sizes()
    expect(m.noteScroll).toBe(0)
    expect(m.blockScroll).toBeGreaterThan(50)
    expect(wrappedHeight).toBeGreaterThan(m.blockHeight * 1.4)
  })

  test('several notes per paper, created and edited in the app', async () => {
    const entry = await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await run.page.getByTestId('add-note').click()
    await run.page.getByTestId('note-edit').click()
    await run.page.getByTestId('note-title').fill('Questions')
    await run.page.getByTestId('note-body').fill('## Heading\n\nSome **text**')
    await run.page.getByTestId('note-done').click()
    await expect(run.page.getByTestId('note-rendered').locator('h2')).toHaveText('Heading')
    await run.page.getByTestId('add-note').click()
    await expect(run.page.getByTestId('tab-note')).toHaveCount(2)
    const notes = await run.page.evaluate((id) => window.api.listSideNotes(id), entry.meta.id)
    const saved = notes.find((n) => n.title === 'Questions')
    expect(saved?.body).toContain('**text**')
    expect(saved?.author).toBe('test-author')
    expect(saved?.generated_by).toBe('')
  })
})

test.describe('library', () => {
  test('the library lists papers being read first, then read, then unread, and any column sorts on a tap', async () => {
    const ids = await run.page.evaluate(async (path) => {
      const one = await window.api.addPaperFromFile(path, { firstPageText: '', titleGuess: '' }, 'Unread Sample')
      const two = await window.api.addPaperById('2301.00001', true)
      const three = await window.api.addPaperById('2301.00002', true)
      if (!one.ok || !two.ok || !three.ok) throw new Error('add failed')
      await window.api.updatePaper(two.entry.meta.id, { status: 'read', read_on: '2026-11-01' })
      await window.api.updatePaper(three.entry.meta.id, { status: 'reading' })
      return [one.entry.meta.id, two.entry.meta.id, three.entry.meta.id]
    }, join(fixtures, 'sample.pdf'))
    expect(ids).toHaveLength(3)
    await refreshLibrary(run.page)
    const statuses = () => run.page.getByTestId('paper-row').evaluateAll((rows) => rows.map((r) => r.querySelector('.status-dot')?.className.replace(/.*status-/, '') ?? ''))
    await expect.poll(statuses).toEqual(['reading', 'read', 'unread'])
    await run.page.getByTestId('sort-status').click()
    await expect.poll(statuses).toEqual(['unread', 'read', 'reading'])
    await run.page.getByTestId('sort-title').click()
    const titles = await run.page.getByTestId('paper-row').evaluateAll((rows) => rows.map((r) => r.querySelector('.title-cell')?.textContent ?? ''))
    expect(titles).toEqual([...titles].sort((x, y) => x.localeCompare(y)))
  })

  test('adding by arXiv ID names the paper by its title and fetches the PDF', async () => {
    await run.page.getByTestId('add-id').fill('https://arxiv.org/abs/2410.24034v2')
    await run.page.getByTestId('add-id-btn').click()
    await expect(run.page.getByTestId('paper-row')).toContainText('Fake Paper 2410.24034')
    const list = await run.page.evaluate(() => window.api.listPapers())
    expect(list[0].meta.id).toBe('arxiv:2410.24034')
    expect(list[0].meta.has_pdf).toBe(true)
    expect(list[0].folder).toContain('arxiv-2410.24034--fake-paper-2410-24034')
    await expect(run.page.getByTestId('source-link')).toHaveText('arXiv 2410.24034v1')
    await openFirst(run.page)
  })

  test('a PDF with no details asks for a title', async () => {
    const outcome = await run.page.evaluate(
      (path) => window.api.addPaperFromFile(path, { firstPageText: 'nothing useful', titleGuess: '' }),
      join(fixtures, 'sample.pdf')
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.needsTitle).toBe(true)
  })

  test('tags, status filter and search', async () => {
    await addSample(run, 'Alpha Paper')
    await run.page.evaluate(async () => {
      await window.api.addPaperById('2301.00001')
    })
    await refreshLibrary(run.page)
    await expect(run.page.getByTestId('paper-row')).toHaveCount(2)
    const row = run.page.getByTestId('paper-row').filter({ hasText: 'Alpha Paper' })
    await row.getByTestId('tag-input').fill('motion')
    await row.getByTestId('tag-input').press('Enter')
    await expect(row).toContainText('motion')
    await run.page.getByTestId('search').fill('motion')
    await expect(run.page.getByTestId('paper-row')).toHaveCount(1)
    await run.page.getByTestId('search').fill('')
    await expect(run.page.getByTestId('paper-row')).toHaveCount(2)
    await run.page.getByTestId('status-filter').selectOption('read')
    await expect(run.page.getByTestId('paper-row')).toHaveCount(0)
  })

  test('status set in the reader records the read date', async () => {
    const entry = await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await run.page.getByTestId('status-select').selectOption('read')
    await expect
      .poll(async () => (await run.page.evaluate(() => window.api.listPapers())).find((p) => p.meta.id === entry.meta.id)?.meta.read_on)
      .toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('a switcher holds several workspaces, each with its own papers', async () => {
    await addSample(run, 'Personal Paper')
    const other = join(run.dir, 'company')
    await run.page.evaluate((p) => window.api.addWorkspace(p, 'Company'), other)
    await run.page.reload()
    await run.page.waitForSelector('[data-testid="library"]')
    await expect(run.page.getByTestId('paper-row')).toHaveCount(0)
    const settings = await run.page.evaluate(() => window.api.getSettings())
    await run.page.getByTestId('workspace-select').selectOption(settings.workspaces[0].id)
    await expect(run.page.getByTestId('paper-row')).toHaveCount(1)
  })
})

test.describe('citations', () => {
  test('a preview opens from a citation, shows the banner and joins the library named by title', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('preview-banner')).toContainText('Implicit Curves for Motion Synthesis', { timeout: 15000 })
    const cached = await fs.readdir(join(run.cache, 'previews'))
    expect(cached).toHaveLength(1)
    await run.page.getByTestId('add-preview').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Added' })).toBeVisible()
    const list = await run.page.evaluate(() => window.api.listPapers())
    const added = list.find((p) => p.meta.title === 'Implicit Curves for Motion Synthesis')
    expect(added?.meta.has_pdf).toBe(true)
    expect(added?.folder).toContain('arxiv-2301.00001--implicit-curves-for-motion-synthesis')
    expect(await fs.readdir(join(run.cache, 'previews'))).toHaveLength(0)
  })

  test('a lookup keeps going while you browse, is not run twice, and reopens instantly', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('lookup-status')).toContainText('Looking up')
    // Asking again while it runs does not start a second lookup.
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('lookup-status')).toHaveCount(1)
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Already looking' })).toBeVisible()
    // Moving to the library does not lose the result.
    await run.page.getByTestId('nav-library').click()
    const ready = run.page.getByTestId('toast').filter({ hasText: 'Preview ready' })
    await expect(ready).toBeVisible({ timeout: 15000 })
    await ready.getByTestId('toast-action').click()
    await expect(run.page.getByTestId('preview-banner')).toContainText('Implicit Curves')
    // A second request is answered from the cache and shows the same tab.
    await run.page.getByTestId('doc-tab').first().click()
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('preview-banner')).toBeVisible({ timeout: 3000 })
    await expect(run.page.getByTestId('lookup-status')).toHaveCount(0)
    await expect(run.page.getByTestId('doc-tab')).toHaveCount(2)
  })

  test('a cited paper already in the library opens from the library instead of as a preview', async () => {
    await run.page.evaluate(() => window.api.addPaperById('2301.12345'))
    await addSample(run, 'Citing Paper')
    await refreshLibrary(run.page)
    await run.page.getByTestId('paper-row').filter({ hasText: 'Citing Paper' }).locator('.title-cell').click()
    await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
    await run.page.waitForTimeout(300)
    await rightClick(run.page, 0, links.ref2)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Already in your library' })).toBeVisible({ timeout: 15000 })
    await expect(run.page.getByTestId('doc-tab').filter({ hasText: 'Fake Paper 2301.12345' })).toBeVisible()
    await expect(run.page.getByTestId('preview-banner')).toHaveCount(0)
  })

  test('deleting a paper or a map asks first and moves it to the Recycle Bin', async () => {
    const entry = await addSample(run, 'Doomed Paper')
    await run.page.evaluate(() => window.api.createMap('Doomed Map'))
    await refreshLibrary(run.page)
    await run.page.getByTestId('row-menu').click()
    await run.page.getByTestId('delete-paper').click()
    await run.page.getByTestId('confirm-cancel').click()
    await expect(run.page.getByTestId('paper-row')).toHaveCount(1)
    await run.page.getByTestId('row-menu').click()
    await run.page.getByTestId('delete-paper').click()
    await run.page.getByTestId('confirm-ok').click()
    await expect(run.page.getByTestId('paper-row')).toHaveCount(0)
    await expect.poll(async () => fs.access(entry.folder).then(() => true, () => false)).toBe(false)

    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-item')).toHaveCount(1)
    await run.page.getByTestId('map-menu').click()
    await run.page.getByTestId('delete-map').click()
    await run.page.getByTestId('confirm-ok').click()
    await expect(run.page.getByTestId('map-item')).toHaveCount(0)
  })

  test('an arXiv ID in the reference is used directly', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await rightClick(run.page, 0, links.ref2)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('preview-banner')).toContainText('Fake Paper 2301.12345', { timeout: 15000 })
  })

  test('when nothing is found the app says so and offers a web search', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await rightClick(run.page, 0, links.ref3)
    await run.page.getByTestId('menu-preview').click()
    const toast = run.page.getByTestId('toast').filter({ hasText: 'No open PDF found' })
    await expect(toast).toBeVisible({ timeout: 15000 })
    await toast.getByTestId('toast-action').click()
    await expect
      .poll(async () => fs.readFile(join(run.userData, 'last-search.txt'), 'utf8').catch(() => ''))
      .toContain('https://www.google.com/search?q=Nothing%20Here')
  })

  test('adding from a citation suggests a dashed arrow on the map you came from', async () => {
    const entry = await addSample(run, 'Citing Paper')
    const id = entry.meta.id
    await run.page.evaluate(async (id) => {
      const m = await window.api.createMap('Bezier')
      await window.api.saveMap({ ...m, nodes: [{ paperId: id }] })
    }, id)
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(1)
    await run.page.getByTestId('map-node').click()
    await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
    await run.page.waitForTimeout(300)
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-preview').click()
    await expect(run.page.getByTestId('preview-banner')).toBeVisible({ timeout: 15000 })
    await run.page.getByTestId('add-preview').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Added' })).toBeVisible()

    const maps = (await run.page.evaluate(() => window.api.listMaps())) as ReadingMap[]
    expect(maps[0].nodes).toHaveLength(2)
    expect(maps[0].edges[0]).toMatchObject({ from: 'arxiv:2301.00001', to: id, status: 'suggested' })

    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await expect(run.page.getByTestId('edge-buttons')).toBeVisible()
    await run.page.getByTestId('edge-accept').click()
    await expect(run.page.getByTestId('edge-buttons')).toHaveCount(0)
    await expect
      .poll(async () => ((await run.page.evaluate(() => window.api.listMaps())) as ReadingMap[])[0].edges[0].status)
      .toBe('confirmed')
  })

  test('old previews are removed when the app starts', async () => {
    const dir = join(run.cache, 'previews')
    await fs.mkdir(dir, { recursive: true })
    const old = join(dir, 'old.pdf')
    await fs.writeFile(old, '%PDF')
    const t = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    await fs.utimes(old, t, t)
    const fresh = join(dir, 'fresh.pdf')
    await fs.writeFile(fresh, '%PDF')
    run = await run.relaunch()
    await expect.poll(async () => (await fs.readdir(dir)).sort()).toEqual(['fresh.pdf'])
  })
})

test.describe('reading maps', () => {
  test('a file written by Claude shows up, and title-only papers need no lookups', async () => {
    await fs.writeFile(
      join(run.workspace, 'maps', 'directions.json'),
      JSON.stringify({
        name: 'Research directions',
        nodes: [
          { paperId: 'arxiv:1706.03762', title: 'Attention Is All You Need' },
          { paperId: 'arxiv:2006.11239', title: 'Denoising Diffusion' }
        ],
        edges: [{ from: 'arxiv:1706.03762', to: 'arxiv:2006.11239' }]
      })
    )
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await expect(run.page.getByTestId('map-node').filter({ hasText: 'Attention Is All' })).toContainText('No PDF yet')
    const y = async (text: string) =>
      (await run.page.getByTestId('map-node').filter({ hasText: text }).boundingBox())!.y
    expect(await y('Attention')).toBeLessThan(await y('Denoising'))
  })

  test('groups fold and unfold; read papers are marked', async () => {
    const entry = await addSample(run, 'Read Paper')
    await run.page.evaluate(async (id) => {
      await window.api.updatePaper(id, { status: 'read', read_on: '2026-11-09' })
      const m = await window.api.createMap('Test')
      await window.api.saveMap({ ...m, nodes: [{ paperId: id, group: 'g' }, { paperId: 'x', title: 'Other', group: 'g' }], groups: [{ id: 'g', title: 'IBMM line', collapsed: false }] })
    }, entry.meta.id)
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node').filter({ hasText: 'Read Paper' })).toContainText('Read on 2026-11-09')
    await run.page.getByTestId('group-toggle').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(0)
    await expect(run.page.getByTestId('map-group')).toContainText('IBMM line (2)')
    await run.page.getByTestId('group-toggle').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
  })

  test('papers can be added, grouped and removed in the app', async () => {
    await run.page.getByTestId('nav-map').click()
    await run.page.getByTestId('new-map-name').fill('Mine')
    await run.page.getByTestId('new-map-btn').click()
    await run.page.getByTestId('map-add-text').fill('2301.00002')
    await run.page.getByTestId('map-add-btn').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(1)
    await run.page.getByTestId('map-node').click({ modifiers: ['Control'] })
    await run.page.getByTestId('group-name').fill('Foundations')
    await run.page.getByTestId('group-btn').click()
    await expect(run.page.getByTestId('map-group')).toContainText('Foundations')
    await run.page.getByTestId('map-node').click({ modifiers: ['Control'] })
    await run.page.getByTestId('remove-node').click()
    await run.page.getByTestId('confirm-cancel').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(1)
    await run.page.getByTestId('remove-node').click()
    await run.page.getByTestId('confirm-ok').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(0)
  })

  test('papers can be selected and arrows removed without a keyboard', async () => {
    await run.page.evaluate(async () => {
      const m = await window.api.createMap('Touch')
      await window.api.saveMap({
        ...m,
        nodes: [{ paperId: 'a', title: 'Paper A' }, { paperId: 'b', title: 'Paper B' }],
        edges: [{ from: 'a', to: 'b', status: 'confirmed' }]
      })
    })
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await run.page.getByTestId('map-select-mode').click()
    await run.page.getByTestId('map-node').filter({ hasText: 'Paper A' }).click()
    await run.page.getByTestId('map-node').filter({ hasText: 'Paper B' }).click()
    await expect(run.page.getByTestId('map-select-mode')).toHaveText('Selecting (2)')
    await run.page.getByTestId('group-name').fill('Pair')
    await run.page.getByTestId('group-btn').click()
    await expect(run.page.getByTestId('map-group')).toContainText('Pair')
    await expect(run.page.getByTestId('map-select-mode')).toHaveText('Select')

    await run.page.locator('.react-flow__edge').first().click({ force: true })
    await expect(run.page.getByTestId('remove-edge')).toBeEnabled()
    await run.page.getByTestId('remove-edge').click()
    await expect
      .poll(async () => ((await run.page.evaluate(() => window.api.listMaps())) as ReadingMap[])[0].edges.length)
      .toBe(0)
  })

  test('a big map opens at a readable zoom, and opening a group moves to it without zooming out', async () => {
    const groups = Array.from({ length: 10 }, (_, g) => ({ id: `g${g}`, title: `Area ${g}`, collapsed: true }))
    const nodes = Array.from({ length: 200 }, (_, i) => ({ paperId: `p${i}`, title: `Paper number ${i}`, group: `g${i % 10}` }))
    await fs.writeFile(join(run.workspace, 'maps', 'areas.json'), JSON.stringify({ name: 'Areas', nodes, edges: [], groups }))
    await run.page.getByTestId('nav-map').click()
    const zoom = () => run.page.evaluate(() => {
      const t = (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform
      return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 0)
    })
    await expect(run.page.getByTestId('map-group')).toHaveCount(10)
    await expect.poll(zoom).toBeGreaterThanOrEqual(0.6)
    await run.page.getByTestId('group-toggle').first().click()
    await expect(run.page.getByTestId('map-node').first()).toBeVisible()
    await run.page.waitForTimeout(500)
    expect(await zoom()).toBeGreaterThanOrEqual(0.6)
    const inView = await run.page.evaluate(() => {
      const box = document.querySelector('[data-testid="map-flow"]')!.getBoundingClientRect()
      const open = [...document.querySelectorAll('[data-testid="map-group"]')].find((g) => !g.classList.contains('collapsed'))!
      const r = open.getBoundingClientRect()
      return r.top >= box.top - 2 && r.top < box.bottom && r.left < box.right && r.right > box.left
    })
    expect(inView).toBe(true)
  })

  test('map changes can be undone; empty fields and missing selections explain themselves', async () => {
    await run.page.evaluate(async () => {
      const m = await window.api.createMap('Undo')
      await window.api.saveMap({ ...m, nodes: [{ paperId: 'a', title: 'Paper A' }, { paperId: 'b', title: 'Paper B' }] })
    })
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await run.page.getByTestId('map-add-btn').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Type a paper title' })).toBeVisible()
    await expect(run.page.getByTestId('map-add-text')).toBeFocused()
    await run.page.getByTestId('group-btn').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'Select papers or groups first' })).toBeVisible()
    await run.page.getByTestId('map-select-mode').click()
    await run.page.getByTestId('map-node').filter({ hasText: 'Paper A' }).click()
    await run.page.getByTestId('group-btn').click()
    await expect(run.page.getByTestId('group-name')).toBeFocused()
    await run.page.getByTestId('remove-node').click()
    await run.page.getByTestId('confirm-ok').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(1)
    await run.page.getByTestId('map-undo').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await run.page.getByTestId('map-redo').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(1)
  })

  test('a citation can go straight onto the map as a suggestion, without a preview', async () => {
    const entry = await addSample(run, 'Citing Paper')
    const id = entry.meta.id
    await run.page.evaluate(async (id) => {
      const m = await window.api.createMap('Bezier')
      await window.api.saveMap({ ...m, nodes: [{ paperId: id }] })
    }, id)
    await run.page.getByTestId('nav-map').click()
    await run.page.getByTestId('map-node').click()
    await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
    await run.page.waitForTimeout(300)
    await rightClick(run.page, 0, links.ref1)
    await run.page.getByTestId('menu-add-to-map').click()
    await expect(run.page.getByTestId('toast').filter({ hasText: 'as a suggestion' })).toBeVisible({ timeout: 15000 })
    await expect(run.page.getByTestId('preview-banner')).toHaveCount(0)
    const maps = (await run.page.evaluate(() => window.api.listMaps())) as ReadingMap[]
    expect(maps[0].nodes).toHaveLength(2)
    expect(maps[0].edges[0]).toMatchObject({ from: 'arxiv:2301.00001', to: id, status: 'suggested' })
    // Nothing was added to the library: the PDF is fetched only when the box is opened.
    expect((await run.page.evaluate(() => window.api.listPapers())).length).toBe(1)
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(2)
    await expect(run.page.getByTestId('map-node').filter({ hasText: 'No PDF yet' })).toHaveCount(1)
  })

  test('papers can be dragged, box-selected, moved into a group, and tidied back up', async () => {
    await run.page.evaluate(async () => {
      const m = await window.api.createMap('Moves')
      await window.api.saveMap({
        ...m,
        nodes: [{ paperId: 'a', title: 'Paper A' }, { paperId: 'b', title: 'Paper B' }, { paperId: 'c', title: 'Paper C', group: 'g' }],
        groups: [{ id: 'g', title: 'Grp', collapsed: false }]
      })
    })
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toHaveCount(3)
    const saved = async () => (await run.page.evaluate(() => window.api.listMaps())).find((m) => m.name === 'Moves')!
    const centre = async (text: string) => {
      const b = (await run.page.getByTestId('map-node').filter({ hasText: text }).boundingBox())!
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await run.page.mouse.move(from.x, from.y)
      await run.page.mouse.down()
      for (let i = 1; i <= 12; i++) await run.page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12)
      await run.page.mouse.up()
    }

    // Drag one paper: it stays where it was dropped, and does not open.
    const a = await centre('Paper A')
    await drag(a, { x: a.x + 40, y: a.y + 260 })
    await expect.poll(async () => (await saved()).positions?.a !== undefined).toBe(true)
    await expect(run.page.getByTestId('reader')).toHaveCount(0)
    const movedA = await centre('Paper A')
    expect(Math.abs(movedA.y - (a.y + 260))).toBeLessThan(25)

    // Drop paper B inside the group's box: it joins the group.
    const g = (await run.page.getByTestId('map-group').boundingBox())!
    await drag(await centre('Paper B'), { x: g.x + g.width / 2, y: g.y + g.height - 20 })
    await expect.poll(async () => (await saved()).nodes.find((n) => n.paperId === 'b')?.group).toBe('g')

    // Select mode: a box drawn across empty space selects what is inside.
    await run.page.getByTestId('map-select-mode').click()
    const pa = (await run.page.getByTestId('map-node').filter({ hasText: 'Paper A' }).boundingBox())!
    await drag({ x: pa.x - 30, y: pa.y - 30 }, { x: pa.x + pa.width + 30, y: pa.y + pa.height + 30 })
    await expect(run.page.getByTestId('map-select-mode')).toContainText('Selecting (1)')
    await run.page.getByTestId('map-select-mode').click()

    // Tidy up clears the hand placements; Undo brings them back.
    await run.page.getByTestId('map-tidy').click()
    await expect.poll(async () => Object.keys((await saved()).positions ?? {}).length).toBe(0)
    await run.page.getByTestId('map-undo').click()
    await expect.poll(async () => Object.keys((await saved()).positions ?? {}).length).toBeGreaterThan(0)
  })

  test('a group can be put inside a new group, and ungrouping it keeps the inner one', async () => {
    await run.page.evaluate(async () => {
      const m = await window.api.createMap('Nested')
      await window.api.saveMap({
        ...m,
        nodes: [{ paperId: 'a', title: 'Paper A', group: 'g1' }, { paperId: 'b', title: 'Paper B', group: 'g1' }, { paperId: 'c', title: 'Paper C' }],
        groups: [{ id: 'g1', title: 'Inner', collapsed: false }]
      })
    })
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-group')).toHaveCount(1)
    await run.page.getByTestId('map-select-mode').click()
    await run.page.getByTestId('map-group').locator('.group-head span').first().click()
    await run.page.getByTestId('map-node').filter({ hasText: 'Paper C' }).click()
    await expect(run.page.getByTestId('map-select-mode')).toContainText('Selecting (2)')
    await run.page.getByTestId('group-name').fill('Outer')
    await run.page.keyboard.press('Enter')
    await expect(run.page.getByTestId('map-group')).toHaveCount(2)
    const saved = await run.page.evaluate(async () => (await window.api.listMaps()).find((m) => m.name === 'Nested'))
    const outer = saved!.groups.find((g) => g.title === 'Outer')!
    expect(saved!.groups.find((g) => g.title === 'Inner')!.parent).toBe(outer.id)
    // The inner box sits inside the outer one on screen.
    const box = async (title: string) => (await run.page.getByTestId('map-group').filter({ hasText: title }).first().boundingBox())!
    const o = await box('Outer')
    const i = await run.page.getByTestId('map-group').filter({ hasText: 'Inner' }).last().boundingBox()
    expect(i!.x).toBeGreaterThan(o.x)
    expect(i!.y).toBeGreaterThan(o.y)
  })

  test('a map with 200 papers lays out', async () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ paperId: `p${i}`, title: `Paper number ${i}` }))
    const edges = Array.from({ length: 199 }, (_, i) => ({ from: `p${Math.floor(i / 3)}`, to: `p${i + 1}`, status: 'confirmed' }))
    await fs.writeFile(join(run.workspace, 'maps', 'big.json'), JSON.stringify({ name: 'Big', nodes, edges, groups: [] }))
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-flow')).toHaveAttribute('data-layout-count', '200', { timeout: 30000 })
    await expect(run.page.getByTestId('map-node').first()).toBeVisible()
  })
})

test('first run asks where the library should live', async () => {
  await run.close()
  await fs.rm(join(run.userData, 'settings.json'))
  run = await launch({ dir: run.dir })
  await expect(run.page.getByTestId('welcome')).toBeVisible()
  await expect(run.page.getByTestId('welcome-path')).toHaveValue(/Paper Library$/)
  await run.page.getByTestId('welcome-path').fill(join(run.dir, 'lib'))
  await run.page.getByTestId('welcome-create').click()
  await expect(run.page.getByTestId('library')).toBeVisible()
})

test.describe('layout and details', () => {
  test('a paper\'s authors and year can be typed in Edit details', async () => {
    await addSample(run, 'LSTM Tutorial')
    await refreshLibrary(run.page)
    await run.page.getByTestId('row-menu').first().click()
    await run.page.getByTestId('edit-details').click()
    await run.page.getByTestId('authors-input').fill('Christopher Olah')
    await run.page.getByTestId('year-input').fill('2015')
    await run.page.getByTestId('title-save').click()
    await expect(run.page.getByTestId('paper-row').first()).toContainText('Christopher Olah')
    await expect(run.page.getByTestId('paper-row').first()).toContainText('2015')
  })

  test('the sorted column has no coloured box', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await run.page.getByTestId('sort-title').click()
    const bg = await run.page.getByTestId('sort-title').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  })

  test('maps come back on the map you left', async () => {
    await run.page.evaluate(async () => {
      for (const name of ['First', 'Second']) {
        const m = await window.api.createMap(name)
        await window.api.saveMap({ ...m, nodes: [{ paperId: 'x', title: name }] })
      }
    })
    await run.page.getByTestId('nav-map').click()
    await run.page.getByTestId('map-item').filter({ hasText: 'Second' }).click()
    await expect(run.page.getByTestId('map-node')).toContainText('Second')
    await run.page.getByTestId('nav-library').click()
    await run.page.getByTestId('nav-map').click()
    await expect(run.page.getByTestId('map-node')).toContainText('Second')
    await expect(run.page.locator('.map-item.on')).toContainText('Second')
  })

  test('side panes fold with an icon and can be dragged wider', async () => {
    await addSample(run)
    await refreshLibrary(run.page)
    await openFirst(run.page)
    const shell = run.page.getByTestId('notes-shell')
    const before = (await shell.boundingBox())!.width
    const h = (await run.page.getByTestId('notes-resize').boundingBox())!
    await run.page.mouse.move(h.x + h.width / 2, h.y + 200)
    await run.page.mouse.down()
    await run.page.mouse.move(h.x + h.width / 2 - 120, h.y + 200, { steps: 5 })
    await run.page.mouse.up()
    await expect.poll(async () => (await shell.boundingBox())!.width).toBeGreaterThan(before + 100)
    await run.page.getByTestId('notes-toggle').click()
    await expect(run.page.getByTestId('right-pane')).toHaveCount(0)
    await run.page.getByTestId('notes-toggle').click()
    await expect(run.page.getByTestId('right-pane')).toBeVisible()

    await run.page.evaluate(async () => {
      const m = await window.api.createMap('M')
      await window.api.saveMap({ ...m, nodes: [{ paperId: 'x', title: 'X' }] })
    })
    await run.page.getByTestId('nav-map').click()
    await run.page.getByTestId('maps-toggle').click()
    await expect(run.page.getByTestId('maps-shell')).toHaveCount(0)
    await run.page.getByTestId('maps-toggle').click()
    await expect(run.page.getByTestId('maps-shell')).toBeVisible()
  })

  test('many open papers do not push the top bar off screen', async () => {
    // The test PDFs are all one file, so a narrow window stands in for many tabs.
    await addSample(run, 'A rather long paper title about world models and what came after them')
    await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(520, 800))
    await refreshLibrary(run.page)
    await openFirst(run.page)
    await expect(run.page.getByTestId('doc-tab')).toHaveCount(1)
    const width = await run.page.evaluate(() => window.innerWidth)
    const settings = (await run.page.getByTestId('nav-settings').boundingBox())!
    expect(settings.x + settings.width).toBeLessThanOrEqual(width + 1)
    const scroll = await run.page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width + 1)
  })
})

test('an open paper shows its short name and title, and its details can be edited from the reader', async () => {
  const entry = await addSample(run, 'Mastering Diverse Domains through World Models')
  await refreshLibrary(run.page)
  await openFirst(run.page)
  await expect(run.page.getByTestId('paper-head-name')).toHaveText('Mastering Diverse Domains through World Models')
  await expect(run.page.getByTestId('paper-head-title')).toHaveCount(0)
  await run.page.getByTestId('edit-paper-details').click()
  await run.page.getByTestId('short-name-input').fill('DreamerV3')
  await run.page.getByTestId('title-save').click()
  await expect(run.page.getByTestId('paper-head-name')).toHaveText('DreamerV3')
  await expect(run.page.getByTestId('paper-head-title')).toHaveText('Mastering Diverse Domains through World Models')
  await expect(run.page.getByTestId('doc-tab')).toHaveText('DreamerV3')

  await run.page.evaluate(async (id) => {
    const m = await window.api.createMap('M')
    await window.api.saveMap({ ...m, nodes: [{ paperId: id }] })
  }, entry.meta.id)
  await run.page.getByTestId('nav-map').click()
  await expect(run.page.getByTestId('map-node-name')).toHaveText('DreamerV3')
  await expect(run.page.getByTestId('map-node-title')).toHaveText('Mastering Diverse Domains through World Models')
})

test('Accept and Dismiss on a suggested arrow inside a group can be tapped, not hidden under the group', async () => {
  await run.page.evaluate(async () => {
    const m = await window.api.createMap('G')
    await window.api.saveMap({
      ...m,
      nodes: [{ paperId: 'a', title: 'A', group: 'g' }, { paperId: 'b', title: 'B', group: 'g' }],
      groups: [{ id: 'g', title: 'World models', collapsed: false }],
      edges: [{ from: 'a', to: 'b', status: 'suggested' }]
    })
  })
  await run.page.getByTestId('nav-map').click()
  const accept = run.page.getByTestId('edge-accept')
  await expect(accept).toBeVisible()
  const box = (await accept.boundingBox())!
  const onTop = await run.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="edge-accept"]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(onTop).toBe(true)
  await accept.click()
  await expect(run.page.getByTestId('edge-buttons')).toHaveCount(0)
})

test('an open group shows no dots; a folded one shows faded dots nothing can be linked from', async () => {
  await run.page.evaluate(async () => {
    const m = await window.api.createMap('H')
    await window.api.saveMap({
      ...m,
      nodes: [{ paperId: 'a', title: 'A', group: 'g' }, { paperId: 'b', title: 'B' }],
      groups: [{ id: 'g', title: 'Background', collapsed: false }],
      edges: []
    })
  })
  await run.page.getByTestId('nav-map').click()
  const group = run.page.getByTestId('map-group')
  await expect(group).toBeVisible()
  const dots = group.locator(':scope > .react-flow__handle')
  await expect(dots).toHaveCount(2)
  for (const d of await dots.all()) {
    await expect(d).toBeHidden()
    expect(await d.evaluate((el) => el.classList.contains('connectable'))).toBe(false)
  }
  await group.getByTestId('group-toggle').click()
  await expect(group).toHaveClass(/collapsed/)
  for (const d of await dots.all()) {
    await expect(d).toBeVisible()
    expect(await d.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    expect(await d.evaluate((el) => el.classList.contains('connectable'))).toBe(false)
  }
})

test('two fingers zoom the map even when they start on a group box (pinching in zooms out)', async () => {
  await run.page.evaluate(async () => {
    const m = await window.api.createMap('P')
    await window.api.saveMap({
      ...m,
      nodes: [{ paperId: 'a', title: 'A', group: 'g' }, { paperId: 'b', title: 'B', group: 'g' }],
      groups: [{ id: 'g', title: 'Big group', collapsed: false }],
      edges: []
    })
  })
  await run.page.getByTestId('nav-map').click()
  const group = run.page.getByTestId('map-group')
  await expect(group).toBeVisible()
  const zoomOf = () => run.page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a)
  const before = await zoomOf()
  await run.page.evaluate(() => {
    const el = document.querySelector('[data-testid="map-group"] .group-head')!.parentElement!
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + Math.min(r.height / 2, 40)
    const touch = (id: number, x: number) => new Touch({ identifier: id, target: el, clientX: x, clientY: cy })
    const fire = (type: string, a: number, b: number, lifted = false) => {
      const t = [touch(1, a), touch(2, b)]
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: lifted ? [] : t, targetTouches: lifted ? [] : t, changedTouches: t }))
    }
    fire('touchstart', cx - 60, cx + 60)
    fire('touchmove', cx - 40, cx + 40)
    fire('touchmove', cx - 20, cx + 20)
    fire('touchend', cx - 20, cx + 20, true)
  })
  const after = await zoomOf()
  expect(after).toBeLessThan(before * 0.5)
})
