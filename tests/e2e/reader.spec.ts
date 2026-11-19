import { expect, Page, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fixtures, launch, Launched } from './helpers'
import type { Layer, PaperEntry } from '../../src/shared/types'

/** Dispatches a simulated pen stroke. Points are in PDF page units. */
async function penStroke(page: Page, pageIndex: number, points: [number, number][], pointerType = 'pen', stepMs = 2) {
  await page.evaluate(
    async ({ pageIndex, points, pointerType, stepMs }) => {
      const canvas = document.querySelector(`[data-testid="live-${pageIndex}"]`) as HTMLCanvasElement
      const wrap = canvas.closest('.page-wrap') as HTMLElement
      const zoom = Number(wrap.dataset.zoom)
      const margin = Number(wrap.dataset.margin)
      const rect = wrap.getBoundingClientRect()
      const client = ([x, y]: [number, number]) => ({
        clientX: rect.left + (x + margin) * zoom,
        clientY: rect.top + y * zoom
      })
      const base = { bubbles: true, pointerId: 77, pointerType, isPrimary: true, pressure: 0.5 }
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...client(points[0]), button: 0, buttons: 1 }))
      for (const p of points.slice(1)) {
        canvas.dispatchEvent(new PointerEvent('pointermove', { ...base, ...client(p), button: -1, buttons: 1 }))
        if (stepMs) await new Promise((r) => setTimeout(r, stepMs))
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...base, ...client(points[points.length - 1]), button: 0, buttons: 0 }))
    },
    { pageIndex, points, pointerType, stepMs }
  )
}

function hline(x0: number, x1: number, y: number): [number, number][] {
  const out: [number, number][] = []
  for (let x = x0; x <= x1; x += 5) out.push([x, y + Math.sin(x / 6) * 0.8])
  return out
}

/** A squiggle that looks like a written word and lands in blank space. */
function writing(x: number, y: number, w = 24): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= w; i += 2) out.push([x + i, y + 5 + Math.sin(i / 2) * 5])
  return out
}

async function layerOf(page: Page, id: string): Promise<Layer> {
  await page.waitForTimeout(600)
  return page.evaluate((id) => window.api.loadLayer(id), id)
}

async function openSample(run: Launched): Promise<PaperEntry> {
  const entry = await run.page.evaluate(
    async ({ path }) => {
      const r = await window.api.addPaperFromFile(path, { firstPageText: '', titleGuess: '' }, 'A Sample Paper About Handwriting Margins')
      if (!r.ok) throw new Error(r.reason)
      return r.entry
    },
    { path: join(fixtures, 'sample.pdf') }
  )
  await run.page.getByTestId('nav-map').click()
  await run.page.getByTestId('nav-library').click()
  await run.page.getByTestId('paper-row').first().click()
  await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await run.page.waitForTimeout(300)
  return entry
}

let run: Launched
test.beforeEach(async () => {
  run = await launch()
})
test.afterEach(async () => {
  await run.close().catch(() => undefined)
  await fs.rm(run.dir, { recursive: true, force: true }).catch(() => undefined)
})

test('renders a real PDF with a wider margin', async () => {
  await openSample(run)
  const info = await run.page.evaluate(() => {
    const wrap = document.querySelector('.page-wrap') as HTMLElement
    const sheet = document.querySelector('.page-sheet') as HTMLElement
    const pdf = document.querySelector('[data-testid="pdf-0"]') as HTMLCanvasElement
    const ctx = pdf.getContext('2d')!
    const data = ctx.getImageData(0, 0, pdf.width, pdf.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4 * 17) if (data[i] < 90 && data[i + 3] > 200) dark++
    return { wrapW: wrap.clientWidth, sheetW: sheet.clientWidth, dark }
  })
  expect(info.wrapW).toBeGreaterThan(info.sheetW + 150)
  expect(info.dark).toBeGreaterThan(50)
})

test('handwriting is saved, recognized, and survives a restart', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-120, 200))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.ink.strokes).toHaveLength(1)
  const note = layer.annotations.marginNotes[0]
  expect(note.engine?.name).toBe('windows-ink')
  expect(note.targetIds).toEqual([])
  expect(note.strokeIds).toEqual([layer.ink.strokes[0].id])

  const again = await run.relaunch()
  run = again
  const after = await run.page.evaluate((id) => window.api.loadLayer(id), entry.meta.id)
  expect(after.ink.strokes).toHaveLength(1)
  expect(after.annotations.marginNotes[0].text).toBe(note.text)
})

test('annotations.json stays free of raw strokes', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-120, 200))
  await run.page.waitForTimeout(2500)
  const dir = join(entry.folder, 'people', 'test-author')
  const a = await fs.readFile(join(dir, 'annotations.json'), 'utf8')
  const i = await fs.readFile(join(dir, 'ink.json'), 'utf8')
  expect(a).not.toContain('"points"')
  expect(i).toContain('"points"')
})

test('an underline snaps to the words and a note written next links to it', async () => {
  const entry = await openSample(run)
  // "Diffusion models have" on the first body line, whose baseline is at page y = 112.
  await penStroke(run.page, 0, hline(100, 215, 114))
  let layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets).toHaveLength(1)
  const t = layer.annotations.targets[0]
  expect(t.kind).toBe('text')
  expect(t.quote?.exact.startsWith('Diffusion models')).toBe(true)
  expect(t.rects).toHaveLength(1)
  expect(layer.annotations.marginNotes).toHaveLength(0)

  await penStroke(run.page, 0, writing(-140, 100))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 })
    .toBe(1)
  layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes[0].targetIds).toEqual([t.id])

  // Only the first note after a mark links; the next one has no target.
  await penStroke(run.page, 0, writing(-140, 400))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 })
    .toBe(2)
  layer = await layerOf(run.page, entry.meta.id)
  const second = layer.annotations.marginNotes.find((n) => n.box[1] > 300)
  expect(second?.targetIds).toEqual([])
  await expect(run.page.getByTestId('filter-no-target')).toContainText('No target (1)')
})

test('Region tool makes a target over a figure and saves its picture', async () => {
  const entry = await openSample(run)
  await run.page.getByTestId('tool-region').click()
  const pts: [number, number][] = [[100, 245], [250, 300], [400, 390]]
  await penStroke(run.page, 0, pts)
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.targets[0]?.image ?? '', { timeout: 10000 })
    .toContain('regions/')
  const layer = await layerOf(run.page, entry.meta.id)
  const t = layer.annotations.targets[0]
  expect(t.kind).toBe('region')
  const png = await fs.readFile(join(entry.folder, 'people', 'test-author', t.image as string))
  expect(png.subarray(1, 4).toString()).toBe('PNG')
})

test('note-first linking joins an existing note to a new mark', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 })
    .toBe(1)
  await run.page.waitForTimeout(2000)
  const note = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  const [x, y, w, h] = note.box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.5, y + h / 2]], 'pen', 0)
  await expect(run.page.getByTestId('note-menu')).toBeVisible()
  await run.page.getByTestId('note-link').click()
  await expect(run.page.getByTestId('linking-banner')).toBeVisible()
  await penStroke(run.page, 0, hline(100, 215, 130))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].targetIds.length)
    .toBe(1)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets[0].quote?.exact).toContain('they')
  await expect(run.page.getByTestId('linking-banner')).toHaveCount(0)
})

test('a note can be edited, and a correction is kept and marked', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  await run.page.waitForTimeout(300)
  const note = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  const [x, y, w, h] = note.box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.5, y + h / 2]], 'pen', 0)
  await run.page.getByTestId('note-edit-open').click()
  await run.page.getByTestId('note-edit-text').fill('why does this hold?')
  await run.page.getByTestId('note-save-text').click()
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes[0].text).toBe('why does this hold?')
  expect(layer.annotations.marginNotes[0].corrected).toBe(true)
  expect(layer.ink.strokes).toHaveLength(1)
})

test('another language reading can be swapped in with one tap', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  const before = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  expect(before.engine?.recognizer).not.toBe('')
  expect(before.alternatives?.length).toBeGreaterThan(0)
  const [x, y, w, h] = before.box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.5, y + h / 2]], 'pen', 0)
  await expect(run.page.getByTestId('note-alternatives')).toBeVisible()
  // Other readings start folded, below the links, so they don't look like links.
  await expect(run.page.getByTestId('note-alternative')).toHaveCount(0)
  await run.page.getByTestId('readings-toggle').click()
  const choice = before.alternatives![0]
  await run.page.getByTestId('note-alternative').first().click()
  const after = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  expect(after.text).toBe(choice.text)
  expect(after.engine?.recognizer).toBe(choice.recognizer)
  expect(after.corrected).toBe(true)
  expect(after.alternatives?.some((a) => a.text === before.text)).toBe(true)
  expect(after.alternatives?.some((a) => a.text === choice.text)).toBe(false)
  expect(after.strokeIds).toEqual(before.strokeIds)
})

test('undo and redo work, and the eraser removes a note', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, hline(100, 215, 114))
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(1)
  await run.page.getByTestId('undo').click()
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(0)
  await run.page.getByTestId('redo').click()
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(1)

  await run.page.getByTestId('tool-eraser').click()
  await penStroke(run.page, 0, [[150, 112], [152, 113]])
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets).toHaveLength(0)
  expect(layer.ink.strokes).toHaveLength(0)
})

test('undo takes back a whole written note, and writing left unprocessed is picked up on reopening', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 300))
  await penStroke(run.page, 0, writing(-140, 312))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  await run.page.getByTestId('undo').click()
  let layer = await layerOf(run.page, entry.meta.id)
  expect(layer.ink.strokes).toHaveLength(0)
  expect(layer.annotations.marginNotes).toHaveLength(0)

  // Simulates quitting before recognition ran.
  layer.ink.strokes.push({
    id: 's_orphan', page: 0, color: '#000', width: 1, createdAt: '', handwriting: true,
    points: writing(-140, 500).map(([x, y], i) => [x, y, 0.5, i * 8])
  })
  await run.page.evaluate(([id, l]) => window.api.saveLayer(id as string, l as Layer), [entry.meta.id, layer] as const)
  run = await run.relaunch()
  await run.page.getByTestId('paper-row').first().locator('.title-cell').click()
  await expect
    .poll(async () => (await run.page.evaluate((id) => window.api.loadLayer(id), entry.meta.id)).annotations.marginNotes.length, { timeout: 15000 })
    .toBe(1)
})

test('undo only reaches the visible tab', async () => {
  const first = await openSample(run)
  await penStroke(run.page, 0, hline(100, 215, 114))
  expect((await layerOf(run.page, first.meta.id)).annotations.targets).toHaveLength(1)
  await run.page.getByTestId('nav-library').click()
  await run.page.keyboard.press('Control+z')
  expect((await layerOf(run.page, first.meta.id)).annotations.targets).toHaveLength(1)
})

/** Screen position of a page point, to check it stays put while zooming. */
async function clientOf(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => {
    const wrap = document.querySelector('[data-page="0"]') as HTMLElement
    const r = wrap.getBoundingClientRect()
    const zoom = Number(wrap.dataset.zoom)
    const margin = Number(wrap.dataset.margin)
    return [r.left + (x + margin) * zoom, r.top + y * zoom]
  }, [x, y]) as Promise<[number, number]>
}

test('zooming with Ctrl and the wheel keeps the point under the cursor in place', async () => {
  await openSample(run)
  const before = await clientOf(run.page, 200, 150)
  await run.page.evaluate(([cx, cy]) => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    for (let i = 0; i < 6; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }))
  }, before)
  await run.page.waitForTimeout(400)
  const after = await clientOf(run.page, 200, 150)
  expect(Math.abs(after[0] - before[0])).toBeLessThan(4)
  expect(Math.abs(after[1] - before[1])).toBeLessThan(4)
})

test('a pinch keeps the point between the fingers in place, and follows them', async () => {
  await openSample(run)
  await run.page.waitForTimeout(1000)
  const zoomOf = () => run.page.evaluate(() => Number((document.querySelector('[data-page="0"]') as HTMLElement).dataset.zoom))
  const startZoom = await zoomOf()
  const mid = await clientOf(run.page, 260, 200)
  const pinch = (a: number, b: number, shiftY = 0, type = 'pointermove') =>
    run.page.evaluate(({ a, b, shiftY, type, mid }) => {
      const input = document.querySelector('[data-testid="live-0"]') as HTMLElement
      for (const [id, x] of [[1, mid[0] - a], [2, mid[0] + b]] as [number, number][]) {
        input.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: mid[1] + shiftY, button: type === 'pointermove' ? -1 : 0, buttons: 1 }))
      }
    }, { a, b, shiftY, type, mid })
  await pinch(50, 50, 0, 'pointerdown')
  for (const d of [60, 75, 90, 110]) {
    await pinch(d, d)
    await run.page.waitForTimeout(40)
  }
  await run.page.waitForTimeout(100)
  expect(await zoomOf()).toBeGreaterThan(startZoom * 1.8)
  const after = await clientOf(run.page, 260, 200)
  expect(Math.abs(after[0] - mid[0])).toBeLessThan(5)
  expect(Math.abs(after[1] - mid[1])).toBeLessThan(5)

  await pinch(110, 110, 40)
  await expect.poll(async () => Math.abs((await clientOf(run.page, 260, 200))[1] - (mid[1] + 40))).toBeLessThan(5)
})

test('ink stays visible after recognition, and typed text is behind a toggle', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-100, 300))
  await expect
    .poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.text ?? '', { timeout: 15000 })
    .not.toBe('')
  await run.page.waitForTimeout(300)
  const inkPixels = () => run.page.evaluate(() => {
    const c = document.querySelector('[data-testid="ink-0"]') as HTMLCanvasElement
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n
  })
  expect(await inkPixels()).toBeGreaterThan(40)
  await expect(run.page.locator('.note-box')).toHaveCount(0)
  await run.page.getByTestId('toggle-text').click()
  await expect(run.page.locator('.note-box')).toHaveCount(1)
  expect(await inkPixels()).toBeGreaterThan(40)
  await run.page.getByTestId('toggle-text').click()
  await expect(run.page.locator('.note-box')).toHaveCount(0)
})

test('a slightly shaky pen tap selects a note, and a tap on nothing leaves no mark', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-100, 300))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  const note = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  const [x, y, w, h] = note.box
  const strokesBefore = (await layerOf(run.page, entry.meta.id)).ink.strokes.length
  const wrapZoom = await run.page.evaluate(() => Number((document.querySelector('[data-page="0"]') as HTMLElement).dataset.zoom))
  const jitter = 5 / wrapZoom
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + jitter, y + h / 2 + jitter], [x + w / 2 + jitter / 2, y + h / 2]], 'pen', 0)
  await expect(run.page.getByTestId('note-menu')).toBeVisible()
  await run.page.keyboard.press('Escape')
  await run.page.waitForTimeout(9000) // long past the punctuation window
  await penStroke(run.page, 0, [[-100, 650], [-100 + jitter, 650]], 'pen', 0)
  await run.page.waitForTimeout(2500)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.ink.strokes).toHaveLength(strokesBefore)
  expect(layer.annotations.marginNotes).toHaveLength(1)
})

test('linking can be left without a keyboard: Cancel, a tap elsewhere, or another tool', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(2000)
  const [x, y, w, h] = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box
  const tapNote = () => penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)

  await tapNote()
  await run.page.getByTestId('note-link').click()
  await run.page.getByTestId('linking-cancel').click()
  await expect(run.page.getByTestId('linking-banner')).toHaveCount(0)

  await tapNote()
  await run.page.getByTestId('note-link').click()
  await penStroke(run.page, 0, [[-60, 650], [-60.3, 650]], 'pen', 0)
  await expect(run.page.getByTestId('linking-banner')).toHaveCount(0)

  await tapNote()
  await run.page.getByTestId('note-link').click()
  await run.page.getByTestId('tool-region').click()
  await expect(run.page.getByTestId('linking-banner')).toHaveCount(0)
  await expect(run.page.getByTestId('tool-link')).toHaveCount(0)
  expect((await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].targetIds).toEqual([])
})

test('a tap on a citation offers to preview it, and a marked reference can be previewed from its menu', async () => {
  await openSample(run)
  const links = JSON.parse(await fs.readFile(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>
  const [cx, cy] = links.ref1
  await penStroke(run.page, 0, [[cx, cy], [cx + 0.2, cy]], 'pen', 0)
  await expect(run.page.getByTestId('menu-preview')).toBeVisible()
  await run.page.getByTestId('menu-preview').click()
  await expect(run.page.getByTestId('preview-banner')).toContainText('Implicit Curves', { timeout: 15000 })
  await run.page.getByTestId('doc-close').last().click()

  await run.page.getByTestId('doc-tab').first().click()
  // Underlining a reference title in the bibliography on page 2, then tapping it.
  const page2Top = await run.page.evaluate(() => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const wrap = document.querySelector('[data-page="1"]') as HTMLElement
    el.scrollTop = wrap.offsetTop
    return true
  })
  expect(page2Top).toBe(true)
  await run.page.waitForSelector('[data-testid="pdf-1"][data-rendered]')
  await run.page.waitForTimeout(300)
  await penStroke(run.page, 1, hline(205, 360, 104))
  await penStroke(run.page, 1, [[280, 99], [280.2, 99]], 'pen', 0)
  await expect(run.page.getByTestId('target-preview')).toBeVisible()
})

test('while linking, a circle drawn next to fresh writing becomes the link, not more writing', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(1200)
  const older = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  // Fresh writing just left of the first printed line.
  await penStroke(run.page, 0, writing(55, 96, 35))
  const [x, y, w, h] = older.box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  await run.page.getByTestId('note-link').click()
  const ring: [number, number][] = []
  for (let i = 0; i <= 40; i++) ring.push([140 + 44 * Math.cos((2 * Math.PI * i) / 40), 108 + 11 * Math.sin((2 * Math.PI * i) / 40)])
  await penStroke(run.page, 0, ring)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(2)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets).toHaveLength(1)
  expect(layer.annotations.targets[0].style).toBe('circle')
  expect(layer.annotations.marginNotes.find((n) => n.id === older.id)?.targetIds).toEqual([layer.annotations.targets[0].id])
  const fresh = layer.annotations.marginNotes.find((n) => n.id !== older.id)!
  expect(fresh.strokeIds).not.toContain(layer.annotations.targets[0].strokeIds![0])
})

test('erasing part of a note shrinks its area', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 300))
  await penStroke(run.page, 0, writing(-140, 314))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  const before = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box
  await run.page.getByTestId('tool-eraser').click()
  await penStroke(run.page, 0, [[-140, 319], [-139, 319]])
  // Polled: the save after an erase can land after the first read.
  await expect.poll(async () => {
    const after = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box
    return after[1] + after[3]
  }, { timeout: 5000 }).toBeLessThan(before[1] + before[3] - 5)
})

test('a note menu near the right edge stays fully in view', async () => {
  const entry = await openSample(run)
  await run.page.getByTestId('fit').click()
  await run.page.waitForTimeout(400)
  await penStroke(run.page, 0, writing(560, 360, 40))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(1200)
  const [x, y, w, h] = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  await expect(run.page.getByTestId('note-menu')).toBeVisible()
  await run.page.waitForTimeout(100)
  const fits = await run.page.evaluate(() => {
    const m = document.querySelector('[data-testid="note-menu"]')!.getBoundingClientRect()
    const v = document.querySelector('[data-testid="pages-scroll"]')!.getBoundingClientRect()
    return { right: m.right, viewRight: v.right, left: m.left, viewLeft: v.left }
  })
  expect(fits.right).toBeLessThanOrEqual(fits.viewRight)
  expect(fits.left).toBeGreaterThanOrEqual(fits.viewLeft)
})

test('Fit page fills the width with the page, Fit with margins includes them, and the margin comes from Settings', async () => {
  await openSample(run)
  const measure = () => run.page.evaluate(() => {
    const view = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const sheet = document.querySelector('.page-sheet')!.getBoundingClientRect()
    const wrap = document.querySelector('.page-wrap')!.getBoundingClientRect()
    const v = view.getBoundingClientRect()
    return { sheetLeft: sheet.left - v.left, sheetW: sheet.width, wrapLeft: wrap.left - v.left, wrapW: wrap.width, viewW: view.clientWidth, margin: Number((document.querySelector('.page-wrap') as HTMLElement).dataset.margin) }
  })
  await run.page.getByTestId('fit').click()
  await run.page.waitForTimeout(400)
  let m = await measure()
  expect(Math.abs(m.sheetW - (m.viewW - 30))).toBeLessThan(3)
  expect(Math.abs(m.sheetLeft - 12)).toBeLessThan(3)
  await run.page.getByTestId('fit').click()
  await run.page.waitForTimeout(400)
  m = await measure()
  expect(Math.abs(m.wrapW - (m.viewW - 30))).toBeLessThan(3)
  // The test setup uses 50%; Settings switches to 100%, where each side is half a page wide.
  expect(m.margin).toBe(153)
  await expect(run.page.getByTestId('margin-100')).toHaveCount(0)
  await run.page.getByTestId('nav-settings').click()
  await run.page.getByTestId('margin-select').selectOption('1')
  await run.page.getByTestId('settings-save').click()
  await run.page.waitForTimeout(300)
  m = await measure()
  expect(m.margin).toBe(306)
  expect((await run.page.evaluate(() => window.api.getSettings())).marginShare).toBe(1)
})

test('Find counts matches in the text and in notes, and Previous/Next go through the ticked kinds', async () => {
  const entry = await openSample(run)
  const p = run.page
  const sideNote = await p.evaluate((id) => window.api.createSideNote(id, { title: 'Thoughts' }), entry.meta.id)
  await p.evaluate((n) => window.api.saveSideNote({ ...n, body: 'curious about sequences here' }), sideNote)
  await p.getByTestId('find-open').click()
  await p.getByTestId('find-input').fill('sequences')
  await expect(p.getByTestId('find-in-text')).toBeChecked()
  await expect(p.locator('label', { has: p.getByTestId('find-in-text') })).toContainText('In text (2)')
  await expect(p.locator('label', { has: p.getByTestId('find-in-margin') })).toContainText('Margin notes (0)')
  await expect(p.locator('label', { has: p.getByTestId('find-in-side') })).toContainText('Side notes (1)')
  await expect(p.getByTestId('find-count')).toHaveText('– of 3')
  await p.getByTestId('find-next').click()
  await expect(p.getByTestId('find-count')).toHaveText('1 of 3')
  await expect(p.locator('[data-find="current"]')).toHaveCount(1)
  await p.keyboard.press('Shift+Enter')
  await expect(p.getByTestId('find-count')).toHaveText('3 of 3')

  // Only the text: two stops. Only notes: one.
  await p.getByTestId('find-in-side').uncheck()
  await expect(p.getByTestId('find-count')).toHaveText('– of 2')
  await p.getByTestId('find-in-side').check()
  await p.getByTestId('find-in-text').uncheck()
  await expect(p.getByTestId('find-count')).toHaveText('– of 1')
  await expect(p.locator('[data-find]')).toHaveCount(0)
  await p.getByTestId('find-in-text').check()

  // Spaces are kept as typed, so a phrase with a space matches only that phrase.
  await p.getByTestId('find-input').fill('long sequences')
  await expect(p.locator('label', { has: p.getByTestId('find-in-text') })).toContainText('In text (1)')
  await expect(p.getByTestId('find-results')).toHaveCount(0)
  await p.getByTestId('find-close').click()
  await expect(p.locator('[data-find]')).toHaveCount(0)
  await p.keyboard.press('Control+f')
  await expect(p.getByTestId('find-input')).toBeFocused()
})

test('Find goes to each match in a side note, highlighted, and the three kinds are ticked apart', async () => {
  const entry = await openSample(run)
  const p = run.page
  const sideNote = await p.evaluate((id) => window.api.createSideNote(id, { title: 'Thoughts' }), entry.meta.id)
  const body = 'first **world** model\n\n' + 'filler line\n\n'.repeat(60) + 'the second world model, far down'
  await p.evaluate(([n, b]) => window.api.saveSideNote({ ...(n as object), body: b } as never), [sideNote, body] as const)
  await p.getByTestId('find-open').click()
  await p.getByTestId('find-input').fill('world model')
  await expect(p.locator('label', { has: p.getByTestId('find-in-side') })).toContainText('Side notes (2)')
  await p.getByTestId('find-in-text').uncheck()
  await expect(p.getByTestId('find-count')).toHaveText('– of 2')
  await p.getByTestId('find-next').click()
  const editor = p.getByTestId('note-editor')
  await expect(editor).toHaveAttribute('data-find-count', '2')
  await expect(editor).toHaveAttribute('data-find-current', '0')
  await p.getByTestId('find-next').click()
  await expect(editor).toHaveAttribute('data-find-current', '1')
  // The second match is scrolled into the pane.
  const seen = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="note-editor"]')!
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n as Text).data.includes('second world')) {
        const r = document.createRange(); r.selectNodeContents(n)
        const box = r.getBoundingClientRect()
        const pane = document.querySelector('[data-testid="right-pane"]')!.getBoundingClientRect()
        return box.top >= pane.top && box.bottom <= pane.bottom
      }
    }
    return false
  })
  expect(seen).toBe(true)
  await p.getByTestId('find-in-side').uncheck()
  await expect(p.getByTestId('find-count')).toHaveText('No matches')
  await expect(editor).not.toHaveAttribute('data-find-count', /.*/)
  await p.getByTestId('find-close').click()
})

test('a note is deleted with the Delete key without asking, and Undo brings it back', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(1200)
  const [x, y, w, h] = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  await run.page.keyboard.press('Delete')
  await expect(run.page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(0)
  await run.page.keyboard.press('Control+z')
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(1)
})

test('Ctrl+W closes the paper tab, not the app', async () => {
  await openSample(run)
  await expect(run.page.getByTestId('doc-tab')).toHaveCount(1)
  await run.page.keyboard.press('Control+w')
  await expect(run.page.getByTestId('doc-tab')).toHaveCount(0)
  await expect(run.page.getByTestId('library')).toBeVisible()
})

test('the notes pane groups notes by page, marks the ones without a target, and filters them', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, hline(100, 215, 114))
  await penStroke(run.page, 0, writing(-140, 100))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await penStroke(run.page, 0, writing(-140, 500))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(2)
  await expect(run.page.getByTestId('notes-page')).toHaveCount(1)
  await expect(run.page.getByTestId('notes-page')).toContainText('Page 1')
  await expect(run.page.getByTestId('mark-item')).toHaveCount(2)
  await expect(run.page.getByTestId('no-target-badge')).toHaveCount(1)
  await run.page.getByTestId('filter-no-target').click()
  await expect(run.page.getByTestId('mark-item')).toHaveCount(1)
  await run.page.getByTestId('filter-all').click()
  await expect(run.page.getByTestId('mark-item')).toHaveCount(2)
})

test('lines from notes to their targets show without tapping, and can be hidden', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, hline(100, 215, 114))
  await penStroke(run.page, 0, writing(-140, 100))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.targetIds.length ?? 0, { timeout: 10000 }).toBe(1)
  await run.page.keyboard.press('Escape')
  await expect(run.page.locator('[data-link]')).toHaveCount(1)
  await run.page.getByTestId('toggle-links').click()
  await expect(run.page.locator('[data-link]')).toHaveCount(0)
  await run.page.getByTestId('toggle-links').click()
  await expect(run.page.locator('[data-link]')).toHaveCount(1)
})

test('the eraser takes out only the line of a mark it touches', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, hline(100, 215, 114))
  await penStroke(run.page, 0, hline(100, 215, 130))
  let t = (await layerOf(run.page, entry.meta.id)).annotations.targets
  expect(t).toHaveLength(1)
  expect(t[0].rects).toHaveLength(2)
  await run.page.getByTestId('tool-eraser').click()
  await penStroke(run.page, 0, [[150, 124], [151, 124]])
  t = (await layerOf(run.page, entry.meta.id)).annotations.targets
  expect(t).toHaveLength(1)
  expect(t[0].rects).toHaveLength(1)
  expect(t[0].quote?.exact.startsWith('Diffusion models')).toBe(true)
  expect(t[0].quote?.exact).not.toContain('they')
})

test('a long zigzag read as a couple of letters becomes a drawing', async () => {
  const entry = await openSample(run)
  const zig: [number, number][] = []
  for (let i = 0; i <= 50; i++) zig.push([-150 + i * 2.6, 500 + (i % 2 ? 9 : 0)])
  await penStroke(run.page, 0, zig)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]?.engine?.name ?? '', { timeout: 10000 }).toBe('windows-ink')
  const note = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  expect(note.kind).toBe('drawing')
  await expect(run.page.getByTestId('filter-no-target')).toContainText('No target (0)')
})

test('a tap on a region opens a menu that deletes it', async () => {
  const entry = await openSample(run)
  await run.page.getByTestId('tool-region').click()
  await penStroke(run.page, 0, [[100, 245], [250, 300], [400, 390]])
  await run.page.keyboard.press('Escape')
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(1)
  await expect(run.page.getByTestId('target-menu')).toHaveCount(0)
  await penStroke(run.page, 0, [[250, 320], [250.3, 320.2]], 'pen', 0)
  await expect(run.page.getByTestId('target-menu')).toContainText('Region')
  await run.page.getByTestId('target-delete').click()
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(0)
  await expect(run.page.getByTestId('target-menu')).toHaveCount(0)
})

test('the dot of a question mark stays, and a dash inside writing is not an underline', async () => {
  const entry = await openSample(run)
  // Writing just left of the text, then a dash over the first printed line, then a dot.
  await penStroke(run.page, 0, writing(40, 100, 50))
  await penStroke(run.page, 0, hline(100, 130, 114))
  await penStroke(run.page, 0, [[118, 122], [118.2, 122.1]], 'pen', 0)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets).toHaveLength(0)
  expect(layer.ink.strokes).toHaveLength(3)
  expect(layer.annotations.marginNotes[0].strokeIds).toHaveLength(3)
})

test('where note areas overlap, a tap picks the smaller one', async () => {
  const entry = await openSample(run)
  const now = new Date().toISOString()
  const base = { candidates: [], corrected: false, kind: 'note' as const, targetIds: [], createdAt: now, updatedAt: now, page: 0 }
  const layer = await layerOf(run.page, entry.meta.id)
  layer.annotations.marginNotes.push(
    { ...base, id: 'big', box: [-100, 300, 90, 60], strokeIds: [], text: 'big one' },
    { ...base, id: 'small', box: [-60, 310, 20, 12], strokeIds: [], text: 'small one' }
  )
  await run.page.evaluate(([id, l]) => window.api.saveLayer(id as string, l as Layer), [entry.meta.id, layer] as const)
  run = await run.relaunch()
  await run.page.getByTestId('paper-row').first().click()
  await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await run.page.waitForTimeout(300)
  await penStroke(run.page, 0, [[-50, 316], [-50, 316.2]], 'pen', 0)
  await expect(run.page.getByTestId('note-transcription')).toHaveText('small one')
})

test('stays quick at high zoom with a lot of ink', async () => {
  const entry = await openSample(run)
  const layer = await layerOf(run.page, entry.meta.id)
  const old = new Date(Date.now() - 3600000).toISOString()
  for (let i = 0; i < 600; i++) {
    layer.ink.strokes.push({
      id: `s${i}`, page: 0, color: '#1f3a93', width: 1.1, createdAt: old,
      points: Array.from({ length: 150 }, (_, k) => [-110 + (i % 30) * 3 + k * 0.1, 20 + (i % 40) * 18 + Math.sin(k / 3) * 3, 0.5, k * 4] as [number, number, number, number])
    })
  }
  await run.page.evaluate(([id, l]) => window.api.saveLayer(id as string, l as Layer), [entry.meta.id, layer] as const)
  run = await run.relaunch()
  await run.page.getByTestId('paper-row').first().click()
  await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await run.page.evaluate(() => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const r = el.getBoundingClientRect()
    for (let i = 0; i < 16; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: r.left + 200, clientY: r.top + 200, bubbles: true, cancelable: true }))
  })
  await run.page.waitForTimeout(3000)
  const stats = await run.page.evaluate(async () => {
    const input = document.querySelector('[data-testid="live-0"]') as HTMLElement
    const r = (document.querySelector('[data-testid="pages-scroll"]') as HTMLElement).getBoundingClientRect()
    const base = { bubbles: true, pointerId: 9, pointerType: 'pen', isPrimary: true, pressure: 0.5 }
    const cx = r.left + 150
    const cy = r.top + 150
    input.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: cx, clientY: cy, button: 0, buttons: 1 }))
    const times: number[] = []
    for (let i = 0; i < 300; i++) {
      const t = performance.now()
      input.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: cx + i * 0.6, clientY: cy + Math.sin(i / 5) * 12, button: -1, buttons: 1 }))
      times.push(performance.now() - t)
    }
    const t = performance.now()
    input.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: cx + 180, clientY: cy, button: 0, buttons: 0 }))
    await new Promise((r) => setTimeout(r, 0))
    const commit = performance.now() - t
    times.sort((a, b) => a - b)
    const canvases = [...document.querySelectorAll('canvas')].map((c) => c.width * c.height)
    return { median: times[150], worst: times[299], commit, pixels: canvases.reduce((a, b) => a + b, 0), count: canvases.length, zoom: (document.querySelector('[data-page="0"]') as HTMLElement).dataset.zoom }
  })
  console.log('perf', JSON.stringify(stats))
  expect(Number(stats.zoom)).toBeGreaterThan(3.5)
  expect(stats.median).toBeLessThan(2)
  expect(stats.commit).toBeLessThan(150)
  expect(stats.pixels).toBeLessThan(40_000_000)
})

test('touch does not draw, and a resting palm is ignored while the pen is near', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-120, 500), 'touch')
  await run.page.waitForTimeout(200)
  expect((await layerOf(run.page, entry.meta.id)).ink.strokes).toHaveLength(0)
})

test('a finger scrolls, unless the pen was just in use', async () => {
  await openSample(run)
  const scrollTop = () => run.page.evaluate(() => document.querySelector('[data-testid="pages-scroll"]')!.scrollTop)
  const start = await scrollTop()
  await run.page.waitForTimeout(1000) // past the palm window from opening
  await penStroke(run.page, 0, [[300, 500], [300, 450], [300, 400], [300, 350]], 'touch')
  const scrolled = await scrollTop()
  expect(scrolled).toBeGreaterThan(start + 20)

  // The pen stops the page if it is still moving from the swipe.
  await penStroke(run.page, 0, writing(-120, 600))
  const still = await scrollTop()
  await penStroke(run.page, 0, [[300, 500], [300, 450], [300, 400], [300, 350]], 'touch', 0)
  await run.page.waitForTimeout(200)
  expect(await scrollTop()).toBe(still)
})

test('a mouse selection is marked only when Mark is chosen', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, [[105, 108], [160, 108], [212, 108]], 'mouse')
  await expect(run.page.getByTestId('selection-bar')).toBeVisible()
  expect((await layerOf(run.page, entry.meta.id)).annotations.targets).toHaveLength(0)
  await run.page.getByTestId('sel-mark').click()
  await expect(run.page.getByTestId('selection-bar')).toHaveCount(0)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets[0].style).toBe('selection')
  expect(layer.annotations.targets[0].quote?.exact).toContain('models')
  expect(layer.ink.strokes).toHaveLength(0)
})

test('a circle around an equation becomes one equation box with its number and a picture', async () => {
  const entry = await openSample(run)
  // The fixture draws L = x2 + yi glyph by glyph at x 200..270, baseline 792 - 250, with (1) at x 400.
  const pts: [number, number][] = []
  for (let i = 0; i <= 40; i++) {
    const t = (2 * Math.PI * i) / 40
    pts.push([236 + 46 * Math.cos(t), 538 + 16 * Math.sin(t)])
  }
  await penStroke(run.page, 0, pts)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.targets[0]?.image ?? '', { timeout: 10000 })
    .toContain('regions/')
  const t = (await layerOf(run.page, entry.meta.id)).annotations.targets
  expect(t).toHaveLength(1)
  expect(t[0].kind).toBe('region')
  expect(t[0].style).toBe('equation')
  expect(t[0].equation).toBe('1')
  expect(t[0].quote?.exact).toContain('=')
  expect(t[0].latex?.replace(/\s+/g, '')).toBe('L=x^{2}+y_{i}')
  await expect(run.page.locator('[data-equation="1"]')).toHaveCount(1)
  // Tapping the box shows the maths typeset, not loose symbols.
  await penStroke(run.page, 0, [[236, 538], [236.3, 538]], 'pen', 0)
  await expect(run.page.getByTestId('target-label').locator('.katex')).toHaveCount(1)
  await expect(run.page.getByTestId('target-label')).toContainText('in Eq. (1)')
})

test('reader shortcuts: tools, toggles, zoom, pages and a new side note', async () => {
  await openSample(run)
  const p = run.page
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press('r')
  await expect(p.getByTestId('tool-region')).toHaveClass(/on/)
  await p.keyboard.press('e')
  await expect(p.getByTestId('tool-eraser')).toHaveClass(/on/)
  await p.keyboard.press('p')
  await expect(p.getByTestId('tool-pen')).toHaveClass(/on/)

  const textOn = await p.getByTestId('toggle-text').getAttribute('class')
  await p.keyboard.press('t')
  expect(await p.getByTestId('toggle-text').getAttribute('class')).not.toBe(textOn)
  const linksOn = await p.getByTestId('toggle-links').getAttribute('class')
  await p.keyboard.press('l')
  expect(await p.getByTestId('toggle-links').getAttribute('class')).not.toBe(linksOn)

  const zoomText = () => p.getByTestId('zoom-level').textContent()
  const before = parseInt((await zoomText()) ?? '0')
  await p.keyboard.press('Control+=')
  await expect.poll(async () => parseInt((await zoomText()) ?? '0')).toBeGreaterThan(before)
  await p.keyboard.press('Control+-')
  await p.keyboard.press('Control+-')
  await expect.poll(async () => parseInt((await zoomText()) ?? '0')).toBeLessThan(before)

  const pageTop = (i: number) => p.evaluate((i) => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const wrap = el.querySelector(`[data-page="${i}"]`) as HTMLElement
    return wrap.getBoundingClientRect().top - el.getBoundingClientRect().top
  }, i)
  await p.keyboard.press('ArrowRight')
  await expect.poll(async () => await pageTop(1)).toBeLessThan(400)
  await p.keyboard.press('ArrowLeft')
  await expect.poll(async () => Math.abs(await pageTop(0))).toBeLessThan(30)
  await p.keyboard.press('End')
  await expect.poll(async () => await pageTop(1)).toBeLessThan(400)
  await p.keyboard.press('Home')
  await expect.poll(async () => Math.abs(await pageTop(0))).toBeLessThan(30)

  const notesBefore = await p.getByTestId('tab-note').count()
  await p.keyboard.press('Control+n')
  await expect(p.getByTestId('tab-note')).toHaveCount(notesBefore + 1)
})

test('tab shortcuts: Ctrl+Shift+T reopens a closed tab, Ctrl+Tab and Ctrl+1/2 switch views', async () => {
  await openSample(run)
  const p = run.page
  await p.keyboard.press('Control+w')
  await expect(p.getByTestId('doc-tab')).toHaveCount(0)
  await p.keyboard.press('Control+Shift+T')
  await expect(p.getByTestId('doc-tab')).toHaveCount(1)
  await expect(p.getByTestId('reader')).toBeVisible()
  await p.keyboard.press('Control+1')
  await expect(p.getByTestId('library')).toBeVisible()
  await p.keyboard.press('Control+2')
  await expect(p.getByTestId('map-view')).toBeVisible()
  await p.keyboard.press('Control+Tab')
  await expect(p.locator('.doc-tab', { has: p.getByTestId('doc-tab') })).toHaveClass(/(^| )on( |$)/)
  await p.keyboard.press('Control+Tab')
  await expect(p.getByTestId('library')).toBeVisible()
  await p.keyboard.press('Control+Shift+Tab')
  await expect(p.locator('.doc-tab', { has: p.getByTestId('doc-tab') })).toHaveClass(/(^| )on( |$)/)
})

test('library and map shortcuts: / focuses search, Enter opens, S and Esc for Select mode', async () => {
  await openSample(run)
  const p = run.page
  await p.keyboard.press('Control+1')
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press('/')
  await expect(p.getByTestId('search')).toBeFocused()
  await p.keyboard.press('Control+w') // nothing to close here
  await p.keyboard.press('Enter')
  await expect(p.getByTestId('reader')).toBeVisible()

  await p.keyboard.press('Control+2')
  await p.getByTestId('new-map-name').fill('Keys')
  await p.getByTestId('new-map-btn').click()
  await expect(p.getByTestId('map-select-mode')).toBeVisible()
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press('s')
  await expect(p.getByTestId('map-select-mode')).toHaveClass(/on/)
  await p.keyboard.press('Escape')
  await expect(p.getByTestId('map-select-mode')).not.toHaveClass(/on/)
})

test('the usage log is off at first, and while on records keys, clicks and pen actions with times, but never typed text', async () => {
  const entry = await openSample(run)
  const p = run.page
  const logDir = await p.evaluate(() => window.api.usageLogFolder())
  const readLog = async () => {
    const files = await fs.readdir(logDir).catch(() => [] as string[])
    const lines: Record<string, unknown>[] = []
    for (const f of files) {
      for (const l of (await fs.readFile(join(logDir, f), 'utf8')).split('\n')) if (l.trim()) lines.push(JSON.parse(l))
    }
    return lines
  }
  await expect(p.getByTestId('log-toggle')).toHaveText('Log off')
  await p.keyboard.press('r')
  await p.waitForTimeout(1300)
  expect(await readLog()).toHaveLength(0)

  await p.getByTestId('log-toggle').click()
  await expect(p.getByTestId('log-toggle')).toHaveText('Logging')
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press('p')
  await penStroke(p, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(p, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await p.keyboard.press('Control+f')
  await p.getByTestId('find-input').pressSequentially('secret')
  await p.keyboard.press('Escape')
  await p.waitForTimeout(1500)

  const log = await readLog()
  const types = log.map((e) => e.type)
  expect(types[0]).toBe('log.on')
  expect(types).toContain('stroke')
  expect(types).toContain('note.create')
  expect(types).toContain('typing')
  expect(log.some((e) => e.type === 'key' && e.key === 'P')).toBe(true)
  expect(log.some((e) => e.type === 'key' && e.key === 'Ctrl+F')).toBe(true)
  expect(log.some((e) => e.type === 'click' && e.target === 'log-toggle')).toBe(false)
  expect(JSON.stringify(log)).not.toContain('secret')
  for (const e of log) {
    expect(typeof e.ms).toBe('number')
    expect(String(e.time)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/)
  }
  const seqs = log.map((e) => e.seq as number)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

  await p.getByTestId('log-toggle').click()
  await expect(p.getByTestId('log-toggle')).toHaveText('Log off')
  await p.waitForTimeout(300)
  const count = (await readLog()).length
  expect((await readLog()).at(-1)?.type).toBe('log.off')
  await p.keyboard.press('e')
  await p.waitForTimeout(1300)
  expect((await readLog()).length).toBe(count)
})

test('pages are numbered, and the page box shows the page in view and jumps to a typed page', async () => {
  await openSample(run)
  const p = run.page
  await expect(p.getByTestId('page-number-0')).toHaveText('1 / 2')
  await expect(p.getByTestId('page-number-1')).toHaveText('2 / 2')
  await expect(p.getByTestId('page-count')).toHaveText('/ 2')
  await expect(p.getByTestId('page-input')).toHaveValue('1')
  // Zoomed in, so page 2 can scroll to the top of the view.
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let k = 0; k < 4; k++) await p.keyboard.press('Control+=')
  await p.waitForTimeout(400)
  await p.getByTestId('page-input').fill('2')
  await p.getByTestId('page-input').press('Enter')
  await expect(p.getByTestId('page-input')).toHaveValue('2')
  // Page 2 is at the top of the view, or as near as scrolling allows.
  const r = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const top = (el.querySelector('[data-page="1"]') as HTMLElement).getBoundingClientRect().top - el.getBoundingClientRect().top
    return { top, atEnd: Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 2 }
  })
  expect(Math.abs(r.top) < 40 || r.atEnd).toBe(true)
})

test('a note linked to its page or to the whole paper shows a tag in the page corner', async () => {
  const entry = await openSample(run)
  const p = run.page
  await penStroke(p, 0, writing(-140, 500))
  await expect.poll(async () => (await layerOf(p, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await p.waitForTimeout(1200)
  const [x, y, w, h] = (await layerOf(p, entry.meta.id)).annotations.marginNotes[0].box
  await penStroke(p, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  await p.getByText('This page').click()
  await expect(p.locator('[data-page-link="page"]')).toHaveCount(1)
  await expect(p.locator('[data-page-link="page"]')).toContainText('Page 1')
  await p.getByTestId('toggle-links').click()
  await p.keyboard.press('Escape')
  await expect(p.locator('[data-page-link]')).toHaveCount(0)
  await p.getByTestId('toggle-links').click()
  await expect(p.locator('[data-page-link="page"]')).toHaveCount(1)
})

test('a mostly vertical finger swipe scrolls straight down, not sideways', async () => {
  await openSample(run)
  const p = run.page
  await p.waitForTimeout(1000) // past the palm window from opening
  // Make the page wider than the view, so it could move sideways.
  for (let k = 0; k < 4; k++) await p.keyboard.press('Control+=')
  await p.waitForTimeout(400)
  const pos = () => p.evaluate(() => { const el = document.querySelector('[data-testid="pages-scroll"]')!; return [el.scrollLeft, el.scrollTop] })
  const [left0, top0] = await pos()
  // Down by 150 px while drifting 30 px sideways.
  const pts: [number, number][] = []
  for (let i = 0; i <= 10; i++) pts.push([300 - i * 3, 500 - i * 15])
  await penStroke(p, 0, pts, 'touch')
  const [left1, top1] = await pos()
  expect(top1).toBeGreaterThan(top0 + 50)
  expect(left1).toBe(left0)
})

test('a selected note can be dragged by its grip, with its ink, and one undo puts it back', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  // Recognition finishes first, so the text compared below is final.
  await expect.poll(async () => !!(await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].engine, { timeout: 15000 }).toBe(true)
  const before = await layerOf(run.page, entry.meta.id)
  const [x, y, w, h] = before.annotations.marginNotes[0].box
  const firstPoint = before.ink.strokes[0].points[0]
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  await expect(run.page.getByTestId('note-move-hint')).toBeVisible()
  const grip = run.page.getByTestId('note-grip')
  const g = (await grip.boundingBox())!
  const zoom = Number(await run.page.locator('[data-page="0"]').getAttribute('data-zoom'))
  await run.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await run.page.mouse.down()
  // Further into the margin, towards the page; it was written near the margin's left edge.
  await run.page.mouse.move(g.x + g.width / 2 + 20, g.y + g.height / 2 + 30, { steps: 5 })
  await run.page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2 + 60, { steps: 5 })
  await run.page.mouse.up()
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box[1], { timeout: 5000 })
    .toBeCloseTo(y + 60 / zoom, 0)
  const after = await layerOf(run.page, entry.meta.id)
  const moved = after.annotations.marginNotes[0]
  expect(moved.box[0]).toBeCloseTo(x + 40 / zoom, 0)
  expect(moved.text).toBe(before.annotations.marginNotes[0].text)
  expect(after.ink.strokes[0].points[0][0]).toBeCloseTo(firstPoint[0] + 40 / zoom, 0)
  expect(after.ink.strokes[0].points[0][1]).toBeCloseTo(firstPoint[1] + 60 / zoom, 0)
  await run.page.getByTestId('undo').click()
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box[1], { timeout: 5000 }).toBeCloseTo(y, 0)
  // Dragged past the margin's left edge, it stops at the edge.
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  const g2 = (await run.page.getByTestId('note-grip').boundingBox())!
  await run.page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2)
  await run.page.mouse.down()
  await run.page.mouse.move(g2.x - 600, g2.y + g2.height / 2, { steps: 8 })
  await run.page.mouse.up()
  const margin = Number(await run.page.locator('[data-page="0"]').getAttribute('data-margin'))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box[0], { timeout: 5000 }).toBeCloseTo(-margin, 0)
})

test('a dot added a few seconds after a word stays as ink and joins the note', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(2500)
  const before = await layerOf(run.page, entry.meta.id)
  const [x, y, w] = before.annotations.marginNotes[0].box
  // Just past the end of the word, as for a full stop.
  await penStroke(run.page, 0, [[x + w + 7, y + 8], [x + w + 7.2, y + 8]], 'pen', 0)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).ink.strokes.length, { timeout: 5000 }).toBe(before.ink.strokes.length + 1)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(1)
})

test('a moved note in the middle of others is drawn where it was dropped, not left behind', async () => {
  const entry = await openSample(run)
  for (const y of [300, 400, 500]) {
    await penStroke(run.page, 0, writing(-140, y))
    await run.page.waitForTimeout(1500)
  }
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(3)
  const middle = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.find((n) => n.box[1] > 380 && n.box[1] < 420)!
  const [x, y, w, h] = middle.box
  // Dark ink pixels on the ink canvas inside a box given in page units.
  const inkIn = (bx: number, by: number, bw: number, bh: number) => run.page.evaluate(([bx, by, bw, bh]) => {
    const wrap = document.querySelector('[data-page="0"]') as HTMLElement
    const zoom = Number(wrap.dataset.zoom)
    const margin = Number(wrap.dataset.margin)
    const c = document.querySelector('[data-testid="ink-0"]') as HTMLCanvasElement
    const scale = c.width / (wrap.getBoundingClientRect().width / zoom)
    const px = Math.floor((bx + margin) * scale)
    const py = Math.floor(by * scale)
    const d = c.getContext('2d')!.getImageData(px, py, Math.ceil(bw * scale), Math.ceil(bh * scale)).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++
    return n
  }, [bx, by, bw, bh])
  expect(await inkIn(x, y, w, h)).toBeGreaterThan(20)
  await penStroke(run.page, 0, [[x + w / 2, y + h / 2], [x + w / 2 + 0.3, y + h / 2]], 'pen', 0)
  const g = (await run.page.getByTestId('note-grip').boundingBox())!
  const zoom = Number(await run.page.locator('[data-page="0"]').getAttribute('data-zoom'))
  await run.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await run.page.mouse.down()
  await run.page.mouse.move(g.x + g.width / 2 + 40 * zoom, g.y + g.height / 2 + 40 * zoom, { steps: 6 })
  await run.page.mouse.move(g.x + g.width / 2 + 80 * zoom, g.y + g.height / 2 + 45 * zoom, { steps: 6 })
  await run.page.mouse.up()
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.find((n) => n.id === middle.id)!.box[0], { timeout: 5000 })
    .toBeCloseTo(x + 80, 0)
  // The old place is empty and the ink is at the new one.
  await expect.poll(() => inkIn(x, y, w, h), { timeout: 3000 }).toBeLessThan(5)
  expect(await inkIn(x + 80, y + 45, w, h)).toBeGreaterThan(20)
})

test('Select ink: a loop picks out one word of a note; dragging it away makes it a note of its own, and Delete removes it', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await penStroke(run.page, 0, writing(-100, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].strokeIds.length, { timeout: 5000 }).toBe(2)
  await run.page.getByTestId('tool-select').click()
  // A loop round the second word only.
  await penStroke(run.page, 0, [[-106, 392], [-88, 390], [-70, 392], [-68, 407], [-70, 423], [-88, 425], [-106, 423], [-108, 407], [-106, 392]])
  await expect(run.page.getByTestId('ink-selection-0')).toBeVisible()
  await expect(run.page.getByTestId('ink-selection-menu')).toContainText('1 stroke')
  // Dragged from inside the box, well below.
  const drag: [number, number][] = []
  for (let i = 0; i <= 10; i++) drag.push([-88, 407 + i * 10])
  await penStroke(run.page, 0, drag)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(2)
  const notes = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes
  expect(notes.map((n) => n.strokeIds.length)).toEqual([1, 1])
  expect(Math.max(...notes.map((n) => n.box[1]))).toBeGreaterThan(490)
  // Undo puts it back as one note.
  await run.page.getByTestId('undo').click()
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(1)
  await run.page.getByTestId('redo').click()
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 5000 }).toBe(2)
  // The moved word is still selected; Delete removes only it.
  await run.page.keyboard.press('Delete')
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).ink.strokes.length, { timeout: 5000 }).toBe(1)
  expect((await layerOf(run.page, entry.meta.id)).annotations.marginNotes).toHaveLength(1)
  await expect(run.page.getByTestId('ink-selection-0')).toHaveCount(0)
})

test('Select ink: with nothing selected, a tap on a note selects it as with the pen', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.keyboard.press('Escape')
  await run.page.getByTestId('tool-select').click()
  // A slightly wobbly tap, as a real pen makes.
  await penStroke(run.page, 0, [[-130, 405], [-129.5, 405.3], [-129.8, 404.8], [-130, 405]])
  await expect(run.page.getByTestId('note-menu')).toBeVisible()
  await expect(run.page.getByTestId('note-grip')).toBeVisible()
  await expect(run.page.getByTestId('tool-select')).toHaveClass(/on/)
  // A tap on empty paper clears it, and a loop still selects ink.
  await penStroke(run.page, 0, [[300, 700], [300.4, 700.2]])
  await expect(run.page.getByTestId('note-menu')).toHaveCount(0)
  await penStroke(run.page, 0, [[-146, 392], [-110, 390], [-108, 425], [-146, 425], [-146, 392]])
  await expect(run.page.getByTestId('ink-selection-0')).toBeVisible()
  // With ink selected, a tap only clears the ink selection.
  await penStroke(run.page, 0, [[-130, 405], [-129.6, 405.2]])
  await expect(run.page.getByTestId('ink-selection-0')).toHaveCount(0)
  await expect(run.page.getByTestId('note-menu')).toHaveCount(0)
})

test('side notes: links to a handwritten note and a page jump there; web links offer preview, map and open', async () => {
  const entry = await openSample(run)
  const p = run.page
  // The library tells agents how to write these links.
  await expect.poll(() => fs.readFile(join(run.workspace, 'AGENTS.md'), 'utf8').catch(() => ''), { timeout: 5000 }).toContain('(note:<')
  expect(await fs.readFile(join(run.workspace, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
  await penStroke(p, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(p, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  const noteId = (await layerOf(p, entry.meta.id)).annotations.marginNotes[0].id
  await p.keyboard.press('Escape')
  const side = await p.evaluate((id) => window.api.createSideNote(id, { title: 'Answers' }), entry.meta.id)
  await p.evaluate(({ n, noteId }) => window.api.saveSideNote({
    ...n,
    body: `### [p. 1: my question](note:${noteId})\n\nSee [p. 1](page:1), [a lost note](note:m_missing) and [MuZero (Schrittwieser et al., 2019)](https://arxiv.org/abs/1911.08265).`
  }), { n: side, noteId })
  await p.getByTestId('tab-note').filter({ hasText: 'Answers' }).click()
  await expect(p.getByTestId('note-link-broken')).toHaveText('a lost note')
  // Scrolled away first, so the link has to bring the note back into the middle of the view.
  await p.getByTestId('pages-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await p.getByTestId('note-link-note').click()
  // The note flashes without being selected, and sits in the middle of the view.
  await expect(p.getByTestId('link-flash').first()).toBeVisible()
  await expect(p.getByTestId('note-menu')).toHaveCount(0)
  const centred = await p.evaluate(() => {
    const flash = document.querySelector('[data-testid="link-flash"]')!.getBoundingClientRect()
    const view = document.querySelector('[data-testid="pages-scroll"]')!.getBoundingClientRect()
    return flash.top >= view.top && flash.bottom <= view.bottom && flash.left >= view.left && flash.right <= view.right
  })
  expect(centred).toBe(true)
  await expect(p.getByTestId('link-flash')).toHaveCount(0, { timeout: 4000 })
  await p.getByTestId('note-link-page').click()
  await p.getByTestId('note-link-web').click()
  await expect(p.getByTestId('context-menu')).toBeVisible()
  await expect(p.getByTestId('menu-preview')).toHaveText('Preview this reference')
  await expect(p.getByTestId('menu-add-to-map')).toHaveText('Add to map as a suggestion')
  await expect(p.getByTestId('menu-go-to-link')).toHaveText('Go to link')
})

test('a quick finger swipe keeps the page moving and slowing, a slow one does not, and a touch stops it', async () => {
  await openSample(run)
  const p = run.page
  await p.waitForTimeout(1000) // past the palm window from opening
  const top = () => p.evaluate(() => document.querySelector('[data-testid="pages-scroll"]')!.scrollTop)
  // A quick flick upwards: 10 moves of 20 units, 8 ms apart.
  const flick: [number, number][] = []
  for (let i = 0; i <= 10; i++) flick.push([300, 600 - i * 20])
  const t0 = await top()
  await penStroke(p, 0, flick, 'touch', 8)
  const atLift = await top()
  await p.waitForTimeout(300)
  const later = await top()
  expect(atLift).toBeGreaterThan(t0)
  expect(later).toBeGreaterThan(atLift + 100)
  // A touch catches it.
  await p.evaluate(() => {
    const c = document.querySelector('[data-testid="live-0"]')!
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 78, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 400, buttons: 1 }))
  })
  const caught = await top()
  await p.waitForTimeout(300)
  expect(Math.abs((await top()) - caught)).toBeLessThan(2)
  await p.evaluate(() => {
    const c = document.querySelector('[data-testid="live-0"]')!
    c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 78, pointerType: 'touch', isPrimary: true, clientX: 400, clientY: 400 }))
  })
  // A slow drag moves only as far as the finger.
  const slow: [number, number][] = []
  for (let i = 0; i <= 6; i++) slow.push([300, 600 - i * 2])
  await penStroke(p, 0, slow, 'touch', 80)
  const afterSlow = await top()
  await p.waitForTimeout(300)
  expect(Math.abs((await top()) - afterSlow)).toBeLessThan(2)
})

test('with "a finger, the mouse or a simple stylus" in Settings, one finger writes and does not scroll; the setting is kept', async () => {
  const p = run.page
  await p.getByTestId('nav-settings').click()
  await p.getByTestId('input-mode-select').selectOption('touch')
  await expect(p.getByTestId('input-mode-hint')).toBeVisible()
  await p.getByTestId('settings-save').click()
  expect((await p.evaluate(() => window.api.getSettings())).inputMode).toBe('touch')
  const entry = await openSample(run)
  await p.waitForTimeout(1000)
  const top = () => p.evaluate(() => document.querySelector('[data-testid="pages-scroll"]')!.scrollTop)
  const before = await top()
  await penStroke(p, 0, writing(-120, 500), 'touch')
  await expect.poll(async () => (await layerOf(p, entry.meta.id)).ink.strokes.length).toBeGreaterThan(0)
  expect(await top()).toBe(before)
})

test('a marked citation still offers the link choices in the mark menu', async () => {
  const entry = await openSample(run)
  const links = JSON.parse(await fs.readFile(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>
  const [cx, cy] = links.ref1
  // Underlining the citation, then tapping it.
  await penStroke(run.page, 0, hline(cx - 12, cx + 12, cy + 6), 'pen', 30)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.targets.length).toBe(1)
  await run.page.keyboard.press('Escape')
  await penStroke(run.page, 0, [[cx, cy], [cx + 0.2, cy]], 'pen', 0)
  const menu = run.page.getByTestId('target-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('target-delete')).toBeVisible()
  await expect(menu.getByTestId('target-link-preview')).toHaveText('Preview this reference')
  await expect(menu.getByTestId('target-link-to-map')).toHaveText('Add to map as a suggestion')
  await expect(menu.getByTestId('target-link-go')).toHaveText('Go to link')
  await menu.getByTestId('target-link-preview').click()
  await expect(run.page.getByTestId('preview-banner')).toContainText('Implicit Curves', { timeout: 15000 })
})

test('Go to link centres and flashes where it points, and Back returns to where you were', async () => {
  await openSample(run)
  const p = run.page
  const links = JSON.parse(await fs.readFile(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>
  const [cx, cy] = links.ref1
  const scroll = () => p.evaluate(() => { const el = document.querySelector('[data-testid="pages-scroll"]')!; return el.scrollTop })
  const before = await scroll()
  await penStroke(p, 0, [[cx, cy], [cx + 0.2, cy]], 'pen', 0)
  await p.getByText('Go to link').click()
  await expect(p.getByTestId('link-flash').first()).toBeVisible()
  // The flashed line is in the middle of the view, both ways.
  const centred = await p.evaluate(() => {
    const f = document.querySelector('[data-testid="link-flash"]')!.getBoundingClientRect()
    const v = document.querySelector('[data-testid="pages-scroll"]')!.getBoundingClientRect()
    return Math.abs((f.top + f.bottom) / 2 - (v.top + v.bottom) / 2) < v.height / 4 && f.left >= v.left && f.right <= v.right
  })
  expect(centred).toBe(true)
  expect(await scroll()).toBeGreaterThan(before + 200)
  await expect(p.getByTestId('link-back-go')).toHaveText('← Back to p. 1')
  await p.getByTestId('link-back-go').click()
  await expect(p.getByTestId('link-back')).toHaveCount(0)
  expect(Math.abs((await scroll()) - before)).toBeLessThan(60)
})

test('a selected region can be resized by a corner and moved by its grip', async () => {
  const entry = await openSample(run)
  const p = run.page
  await p.getByTestId('tool-region').click()
  await penStroke(p, 0, [[100, 245], [250, 300], [400, 390]])
  await p.keyboard.press('Escape')
  const rectOf = async () => (await layerOf(p, entry.meta.id)).annotations.targets[0].rects![0]
  const [x0, y0, w0, h0] = await rectOf()
  await expect(p.getByTestId('region-grip')).toHaveCount(0)
  await penStroke(p, 0, [[250, 320], [250.3, 320.2]], 'pen', 0)
  await expect(p.getByTestId('region-handle-se')).toBeVisible()
  const drag = async (testId: string, dx: number, dy: number) => {
    const b = (await p.getByTestId(testId).boundingBox())!
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await p.mouse.down()
    await p.mouse.move(b.x + b.width / 2 + dx / 2, b.y + b.height / 2 + dy / 2)
    await p.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy)
    await p.mouse.up()
  }
  const zoom = await p.evaluate(() => Number(document.querySelector('[data-page="0"]')!.getAttribute('data-zoom')))
  await drag('region-handle-se', 40 * zoom, 30 * zoom)
  await expect.poll(async () => (await rectOf())[2]).toBeCloseTo(w0 + 40, 0)
  const r1 = await rectOf()
  expect(r1[0]).toBeCloseTo(x0, 0)
  expect(r1[3]).toBeCloseTo(h0 + 30, 0)
  await drag('region-grip', -20 * zoom, 10 * zoom)
  await expect.poll(async () => (await rectOf())[0]).toBeCloseTo(x0 - 20, 0)
  const r2 = await rectOf()
  expect(r2[1]).toBeCloseTo(y0 + 10, 0)
  expect(r2[2]).toBeCloseTo(w0 + 40, 0)
})

test('in a mark that is mostly other text, a tap on its link opens the link menu and elsewhere the mark menu', async () => {
  const entry = await openSample(run)
  const p = run.page
  const links = JSON.parse(await fs.readFile(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>
  const [cx, cy] = links.ref1
  // Underlining the line up to and including the citation.
  await penStroke(p, 0, hline(100, cx + 12, cy + 6))
  await expect.poll(async () => (await layerOf(p, entry.meta.id)).annotations.targets.length).toBe(1)
  await p.keyboard.press('Escape')
  await penStroke(p, 0, [[cx, cy], [cx + 0.2, cy]], 'pen', 0)
  await expect(p.getByTestId('menu-preview')).toBeVisible()
  await expect(p.getByTestId('target-menu')).toHaveCount(0)
  await p.keyboard.press('Escape')
  await penStroke(p, 0, [[140, cy], [140.2, cy]], 'pen', 0)
  await expect(p.getByTestId('target-menu')).toBeVisible()
  await expect(p.getByTestId('target-link-actions')).toHaveCount(0)
})

test('three pen sizes: a stroke keeps the size chosen, and the broad pen is the old one', async () => {
  const entry = await openSample(run)
  await expect(run.page.getByTestId('pen-size-2')).toHaveClass(/on/)
  await run.page.getByTestId('pen-size-0').click()
  await penStroke(run.page, 0, writing(-140, 300))
  await run.page.getByTestId('pen-size-2').click()
  await penStroke(run.page, 0, writing(-140, 500))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).ink.strokes.map((s) => s.width), { timeout: 5000 })
    .toEqual([0.55, 1.1])
})

test('Lock scrollbar hides the bar but the pages still scroll', async () => {
  await openSample(run)
  const scroller = run.page.getByTestId('pages-scroll')
  const bar = () => scroller.evaluate((el) => (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth)
  expect(await bar()).toBeGreaterThan(0)
  await run.page.getByTestId('scroll-lock').click()
  await expect(scroller).toHaveClass(/no-bar/)
  expect(await bar()).toBe(0)
  await scroller.evaluate((el) => { el.scrollTop = 400 })
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(300)
})

/** Drags a corner square with the mouse by dx, dy screen pixels. */
async function dragHandle(page: Page, testId: string, dx: number, dy: number) {
  const h = (await page.getByTestId(testId).boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2 + dy, { steps: 6 })
  await page.mouse.up()
}

test('a tapped note is resized by dragging a corner, the opposite corner staying put; its text stays', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await penStroke(run.page, 0, writing(-100, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(1200)
  const before = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  await penStroke(run.page, 0, [[-120, 405], [-120.2, 405]], 'pen', 0)
  await expect(run.page.getByTestId('note-handle-nw')).toBeVisible()
  await expect(run.page.getByTestId('note-smaller')).toHaveCount(0)
  // The top-left square pulled halfway to the bottom-right corner, which stays put.
  const nw = (await run.page.getByTestId('note-handle-nw').boundingBox())!
  const se = (await run.page.getByTestId('note-handle-se').boundingBox())!
  // The squares sit 7 px outside the corners.
  await dragHandle(run.page, 'note-handle-nw', (se.x - 7 - nw.x) / 2, (se.y - 7 - nw.y) / 2)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box[2], { timeout: 5000 })
    .toBeCloseTo(before.box[2] / 2, -0.5)
  const after = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  expect(after.id).toBe(before.id)
  expect(after.text).toBe(before.text)
  expect(after.box[0] + after.box[2]).toBeCloseTo(before.box[0] + before.box[2], 0)
  expect(after.box[1] + after.box[3]).toBeCloseTo(before.box[1] + before.box[3], 0)
})

test('selected ink has corner squares that resize it', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  const before = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  await run.page.getByTestId('tool-select').click()
  await penStroke(run.page, 0, [[-150, 390], [-100, 390], [-100, 420], [-150, 420], [-150, 390]])
  await expect(run.page.getByTestId('ink-handle-se')).toBeVisible()
  const zoom = Number(await run.page.locator('[data-page="0"]').getAttribute('data-zoom'))
  await dragHandle(run.page, 'ink-handle-se', before.box[2] * zoom, before.box[2] * zoom)
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0].box[2], { timeout: 5000 })
    .toBeGreaterThan(before.box[2] * 1.6)
  const after = (await layerOf(run.page, entry.meta.id)).annotations.marginNotes[0]
  expect(after.box[0]).toBeCloseTo(before.box[0], 0)
  expect(after.box[1]).toBeCloseTo(before.box[1], 0)
})

test('at 600% the ink and the page on screen are drawn sharp', async () => {
  await openSample(run)
  await penStroke(run.page, 0, writing(-140, 120))
  await run.page.evaluate(() => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const r = el.getBoundingClientRect()
    for (let i = 0; i < 30; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: r.left + 100, clientY: r.top + 100, bubbles: true, cancelable: true }))
  })
  await expect.poll(() => run.page.evaluate(() => Number((document.querySelector('[data-page="0"]') as HTMLElement).dataset.zoom)), { timeout: 5000 }).toBeCloseTo(6, 1)
  const detail = run.page.getByTestId('ink-detail-0')
  await expect(detail).toBeVisible({ timeout: 5000 })
  const sharp = await detail.evaluate((c) => {
    const canvas = c as HTMLCanvasElement
    return canvas.width / canvas.getBoundingClientRect().width / (window.devicePixelRatio || 1)
  })
  expect(sharp).toBeCloseTo(1, 1)
  await expect(run.page.getByTestId('ink-0')).toHaveCSS('visibility', 'hidden')
  // The printed page is sharp: either the whole-page picture is fine enough, or the part on screen is redrawn.
  await expect.poll(() => run.page.evaluate(() => {
    const dpr = window.devicePixelRatio || 1
    const fine = (c: HTMLCanvasElement | null) => !!c && getComputedStyle(c).display !== 'none' && c.width / c.getBoundingClientRect().width / dpr >= 0.95
    return fine(document.querySelector('[data-testid="pdf-0"]')) || fine(document.querySelector('[data-testid="pdf-detail-0"]'))
  }), { timeout: 5000 }).toBe(true)
})

test('on a 2x screen at 600%, the printed page on screen is redrawn sharp, matching the page', async () => {
  const cdp = await run.page.context().newCDPSession(run.page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 2, mobile: false })
  await openSample(run)
  expect(await run.page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(2, 3)
  // Zoomed in on a citation, so there is printed text on screen.
  const links = JSON.parse(await fs.readFile(join(fixtures, 'sample-links.json'), 'utf8')) as Record<string, [number, number]>
  const [cx, cy] = links.ref1
  await run.page.evaluate(([x, y]) => {
    const el = document.querySelector('[data-testid="pages-scroll"]') as HTMLElement
    const wrap = document.querySelector('[data-page="0"]') as HTMLElement
    const r = wrap.getBoundingClientRect()
    const zoom = Number(wrap.dataset.zoom)
    const margin = Number(wrap.dataset.margin)
    const clientX = r.left + (x + margin) * zoom
    const clientY = r.top + y * zoom
    for (let i = 0; i < 30; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX, clientY, bubbles: true, cancelable: true }))
  }, [cx, cy])
  await expect(run.page.getByTestId('pdf-detail-0')).toBeVisible({ timeout: 8000 })
  await run.page.waitForTimeout(500)
  const check = await run.page.evaluate(() => {
    const det = document.querySelector('[data-testid="pdf-detail-0"]') as HTMLCanvasElement
    const base = document.querySelector('[data-testid="pdf-0"]') as HTMLCanvasElement
    const dr = det.getBoundingClientRect()
    const br = base.getBoundingClientRect()
    const dark = (c: HTMLCanvasElement, x: number, y: number, w: number, h: number) => {
      const d = c.getContext('2d')!.getImageData(x, y, w, h).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++
      return n / (w * h)
    }
    const kx = base.width / br.width
    const ky = base.height / br.height
    return {
      sharp: det.width / dr.width / 2,
      detail: dark(det, 0, 0, det.width, det.height),
      page: dark(base, Math.round((dr.left - br.left) * kx), Math.round((dr.top - br.top) * ky), Math.round(dr.width * kx), Math.round(dr.height * ky))
    }
  })
  expect(check.sharp).toBeCloseTo(1, 1)
  // The same printed text as the coarse page under it, in the same place: about as much of it is dark.
  expect(check.page).toBeGreaterThan(0.002)
  expect(check.detail).toBeGreaterThan(check.page * 0.6)
  expect(check.detail).toBeLessThan(check.page * 1.6)
})

test('zoomed out, a tap on the grey around the pages closes a selected note', async () => {
  const entry = await openSample(run)
  await penStroke(run.page, 0, writing(-140, 400))
  await expect.poll(async () => (await layerOf(run.page, entry.meta.id)).annotations.marginNotes.length, { timeout: 10000 }).toBe(1)
  await run.page.waitForTimeout(1200)
  await penStroke(run.page, 0, [[-128, 405], [-128.2, 405]], 'pen', 0)
  await expect(run.page.getByTestId('note-menu')).toBeVisible()
  for (let i = 0; i < 6; i++) await run.page.keyboard.press('Control+-')
  const scroller = run.page.getByTestId('pages-scroll')
  const page0 = await run.page.locator('[data-page="0"]').boundingBox()
  const area = await scroller.boundingBox()
  // Grey space to the right of the page.
  expect(page0!.x + page0!.width).toBeLessThan(area!.x + area!.width - 40)
  await run.page.mouse.click(area!.x + area!.width - 20, page0!.y + 50)
  await expect(run.page.getByTestId('note-menu')).toHaveCount(0)
})
