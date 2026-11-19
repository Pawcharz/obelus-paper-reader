import { expect, Page, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fixtures, launch, Launched } from './helpers'
import type { Layer, PaperEntry } from '../../src/shared/types'

/** Mouse drags as the app sees them, in page units from the page's top left. */
async function mouseDrag(page: Page, pageIndex: number, points: [number, number][]) {
  await page.evaluate(
    async ({ pageIndex, points }) => {
      const layer = document.querySelector(`[data-testid="live-${pageIndex}"]`) as HTMLElement
      const wrap = layer.closest('.page-wrap') as HTMLElement
      const zoom = Number(wrap.dataset.zoom)
      const margin = Number(wrap.dataset.margin)
      const rect = wrap.getBoundingClientRect()
      const client = ([x, y]: [number, number]) => ({ clientX: rect.left + (x + margin) * zoom, clientY: rect.top + y * zoom })
      const base = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5 }
      layer.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...client(points[0]), button: 0, buttons: 1 }))
      for (const p of points.slice(1)) {
        layer.dispatchEvent(new PointerEvent('pointermove', { ...base, ...client(p), button: -1, buttons: 1 }))
        await new Promise((r) => setTimeout(r, 2))
      }
      layer.dispatchEvent(new PointerEvent('pointerup', { ...base, ...client(points[points.length - 1]), button: 0, buttons: 0 }))
    },
    { pageIndex, points }
  )
}

async function clientOf(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => {
    const wrap = document.querySelector('[data-page="0"]') as HTMLElement
    const r = wrap.getBoundingClientRect()
    return [r.left + (x + Number(wrap.dataset.margin)) * Number(wrap.dataset.zoom), r.top + y * Number(wrap.dataset.zoom)]
  }, [x, y]) as Promise<[number, number]>
}

async function layerOf(page: Page, id: string): Promise<Layer> {
  await page.waitForTimeout(600)
  return page.evaluate((id) => window.api.loadLayer(id), id)
}

async function openSampleInPcMode(run: Launched): Promise<PaperEntry> {
  await run.page.getByTestId('mode-toggle').click()
  await expect(run.page.getByTestId('mode-toggle')).toContainText('PC mode')
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

test('PC mode: select text, Note, type, Enter makes a typed margin note linked to a new mark', async () => {
  const entry = await openSampleInPcMode(run)
  await expect(run.page.getByTestId('pc-tools')).toBeVisible()
  await expect(run.page.getByTestId('tool-pen')).toHaveCount(0)
  await mouseDrag(run.page, 0, [[105, 108], [160, 108], [212, 108]])
  await run.page.getByTestId('sel-note').click()
  await expect(run.page.getByTestId('typed-editor')).toBeVisible()
  await expect(run.page.getByTestId('typed-chip')).toContainText('p. 1')
  await run.page.keyboard.type('Why does this hold?')
  await run.page.keyboard.press('Enter')
  await expect(run.page.getByTestId('typed-editor')).toHaveCount(0)
  const layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.targets).toHaveLength(1)
  const note = layer.annotations.marginNotes[0]
  expect(note.input).toBe('typed')
  expect(note.text).toBe('Why does this hold?')
  expect(note.targetIds).toEqual([layer.annotations.targets[0].id])
  expect(note.strokeIds).toEqual([])
  expect(layer.ink.strokes).toHaveLength(0)
  await expect(run.page.locator(`[data-typed-note="${note.id}"]`)).toContainText('Why does this hold?')
  // One Undo takes the note back; another, the mark.
  await run.page.getByTestId('undo').click()
  expect((await layerOf(run.page, entry.meta.id)).annotations.marginNotes).toHaveLength(0)
})

test('PC mode: double-click the margin for a note there; Esc keeps it; an empty note is never kept; double-click edits', async () => {
  const entry = await openSampleInPcMode(run)
  const [x, y] = await clientOf(run.page, 640, 300)
  await run.page.mouse.dblclick(x, y)
  await expect(run.page.getByTestId('typed-chip-none')).toBeVisible()
  await run.page.keyboard.type('an aside')
  await run.page.keyboard.press('Escape')
  let layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes.map((n) => n.text)).toEqual(['an aside'])
  expect(layer.annotations.marginNotes[0].targetIds).toEqual([])
  const [x2, y2] = await clientOf(run.page, 640, 500)
  await run.page.mouse.dblclick(x2, y2)
  await expect(run.page.getByTestId('typed-editor')).toBeVisible()
  await run.page.keyboard.press('Enter')
  layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes).toHaveLength(1)
  // Double-clicking the note opens it for editing.
  const box = layer.annotations.marginNotes[0].box
  const [nx, ny] = await clientOf(run.page, box[0] + 10, box[1] + 4)
  await run.page.mouse.dblclick(nx, ny)
  await expect(run.page.getByTestId('typed-input')).toHaveValue('an aside')
  await run.page.keyboard.type(', edited')
  await run.page.keyboard.press('Enter')
  layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes[0].text).toBe('an aside, edited')
})

test('PC mode: N with an active mark; a rubber band from the margin chooses notes, Delete removes them', async () => {
  const entry = await openSampleInPcMode(run)
  await mouseDrag(run.page, 0, [[105, 108], [212, 108]])
  await run.page.keyboard.press('h')
  await run.page.keyboard.press('n')
  await run.page.keyboard.type('first')
  await run.page.keyboard.press('Enter')
  let layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes[0].targetIds).toEqual([layer.annotations.targets[0].id])
  const b = layer.annotations.marginNotes[0].box
  await mouseDrag(run.page, 0, [[b[0] + b[2] + 10, b[1] - 10], [b[0] - 4, b[1] + b[3] + 10]])
  await run.page.keyboard.press('Delete')
  layer = await layerOf(run.page, entry.meta.id)
  expect(layer.annotations.marginNotes).toHaveLength(0)
})

test('PC mode: ? opens the key sheet, and Settings offers the two modes', async () => {
  await openSampleInPcMode(run)
  await run.page.keyboard.press('?')
  await expect(run.page.getByTestId('key-sheet')).toBeVisible()
  await run.page.keyboard.press('Escape')
  await run.page.getByTestId('nav-settings').click()
  await expect(run.page.getByTestId('mode-select')).toHaveValue('pc')
})
