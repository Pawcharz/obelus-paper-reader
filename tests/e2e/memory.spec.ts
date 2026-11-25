import { expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fixtures, launch, Launched } from './helpers'

// The app reopens the papers you had open, with the same one in front, at the place you left it.
let run: Launched
test.afterEach(async () => {
  await run?.close().catch(() => undefined)
  if (run) await fs.rm(run.dir, { recursive: true, force: true }).catch(() => undefined)
})

test('open tabs and the reading position come back after a restart', async () => {
  run = await launch()
  await run.page.evaluate(async ({ path }) => {
    const r = await window.api.addPaperFromFile(path, { firstPageText: '', titleGuess: '' }, 'A Sample Paper About Handwriting Margins')
    if (!r.ok) throw new Error(r.reason)
  }, { path: join(fixtures, 'sample.pdf') })
  await run.page.getByTestId('nav-map').click()
  await run.page.getByTestId('nav-library').click()
  await run.page.getByTestId('paper-row').first().click()
  await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await run.page.waitForTimeout(400)

  // Scroll down in the reader, then wait for the position to be saved.
  const before = await run.page.evaluate(() => {
    let s: HTMLElement | null = document.querySelector('[data-page="0"]') as HTMLElement
    while (s && s.scrollHeight <= s.clientHeight + 1) s = s.parentElement
    if (!s) return 0
    s.scrollTop = Math.min(s.scrollHeight - s.clientHeight, 700)
    return Math.round(s.scrollTop)
  })
  expect(before).toBeGreaterThan(100)
  await run.page.waitForTimeout(900)

  run = await run.relaunch()
  // No click on the Library: the paper's tab is open and in front.
  await expect(run.page.getByTestId('doc-tab')).toHaveCount(1)
  await run.page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await expect.poll(async () => run.page.evaluate(() => {
    let s: HTMLElement | null = document.querySelector('[data-page="0"]') as HTMLElement
    while (s && s.scrollHeight <= s.clientHeight + 1) s = s.parentElement
    return Math.round(s?.scrollTop ?? 0)
  }), { timeout: 10000 }).toBeGreaterThan(before - 40)
})
