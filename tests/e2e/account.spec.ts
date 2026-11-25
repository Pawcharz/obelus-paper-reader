import { expect, Page, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { fixtures, launch, Launched } from './helpers'
import type { PaperEntry } from '../../src/shared/types'

async function addSample(run: Launched): Promise<PaperEntry> {
  return run.page.evaluate(async (path) => {
    const r = await window.api.addPaperFromFile(path, { firstPageText: '', titleGuess: '' }, 'Sample')
    if (!r.ok) throw new Error(r.reason)
    return r.entry
  }, join(fixtures, 'sample.pdf'))
}

async function openFirst(page: Page) {
  await page.getByTestId('nav-map').click()
  await page.getByTestId('nav-library').click()
  await page.getByTestId('paper-row').first().locator('.title-cell').click()
  await page.waitForSelector('[data-testid="pdf-0"][data-rendered]')
  await page.waitForTimeout(300)
}

const scrollOf = (page: Page) => page.getByTestId('note-rendered').evaluate((el) => el.scrollTop)

let run: Launched
test.beforeEach(async () => {
  delete process.env.OBELUS_GOOGLE_CLIENT_ID
  delete process.env.OBELUS_GOOGLE_CLIENT_SECRET
  run = await launch()
})
test.afterEach(async () => {
  await run.close().catch(() => undefined)
  await fs.rm(run.dir, { recursive: true, force: true }).catch(() => undefined)
})

test('a side note opens where it was left: after closing the pane, another tab, or a restart', async () => {
  const entry = await addSample(run)
  const body = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long note.`).join('\n\n')
  await run.page.evaluate(({ id, body }) =>
    (window.api.createSideNote as (id: string, init: object) => Promise<unknown>)(id, { title: 'Long', body }), { id: entry.meta.id, body })
  await openFirst(run.page)
  await run.page.getByTestId('tab-note').click()
  const rendered = run.page.getByTestId('note-rendered')
  await expect(rendered).toContainText('Paragraph 120')
  await rendered.hover()
  await run.page.mouse.wheel(0, 900)
  await expect.poll(() => scrollOf(run.page)).toBeGreaterThan(500)
  const left = await scrollOf(run.page)

  await run.page.getByTestId('notes-toggle').click()
  await expect(run.page.getByTestId('right-pane')).toHaveCount(0)
  await run.page.getByTestId('notes-toggle').click()
  await expect(rendered).toBeVisible()
  await expect.poll(() => scrollOf(run.page)).toBe(left)

  await run.page.getByTestId('tab-marks').click()
  await run.page.getByTestId('tab-note').click()
  await expect.poll(() => scrollOf(run.page)).toBe(left)

  run = await run.relaunch()
  await openFirst(run.page)
  // The note's tab is still the one showing, at the same place.
  await expect(run.page.getByTestId('note-rendered')).toBeVisible()
  await expect.poll(() => scrollOf(run.page)).toBe(left)
})

test('notes made on another computer can be moved in from the account panel', async () => {
  const entry = await addSample(run)
  // What another computer, signed out, left in the shared library.
  const other = join(entry.folder, 'people', 'other-computer')
  await fs.mkdir(other, { recursive: true })
  await fs.writeFile(join(other, 'annotations.json'), JSON.stringify({
    schema: 1, paperId: entry.meta.id, authorId: 'other-computer', targets: [],
    marginNotes: [{ id: 'm_far', page: 0, box: [0, 0, 10, 10], strokeIds: [], text: 'written on the tablet', candidates: [], corrected: true, kind: 'note', targetIds: [], createdAt: '', updatedAt: '' }]
  }))
  expect((await run.page.evaluate((id) => window.api.loadLayer(id), entry.meta.id)).annotations.marginNotes).toHaveLength(0)

  await expect(run.page.getByTestId('account-button')).toContainText('Sign in')
  await run.page.getByTestId('account-button').click()
  const account = run.page.getByTestId('account')
  await expect(account).toContainText('Not signed in')
  // No Google client in the test environment: the button says why it cannot be used.
  await expect(run.page.getByTestId('sign-in-google')).toBeDisabled()
  await expect(run.page.getByTestId('google-not-configured')).toBeVisible()
  await expect(run.page.getByTestId('layer-owner')).toHaveCount(1)
  await expect(run.page.getByTestId('layer-owners')).toContainText('Another computer (other-co)')
  await run.page.getByTestId('layer-owner').check()
  await run.page.getByTestId('merge-layers').click()
  await run.page.getByTestId('confirm-ok').click()
  await run.page.waitForSelector('[data-testid="app-root"]')
  await expect.poll(async () =>
    (await run.page.evaluate((id) => window.api.loadLayer(id), entry.meta.id)).annotations.marginNotes.map((n) => n.text)
  ).toEqual(['written on the tablet'])
  expect(await fs.readdir(join(entry.folder, 'people'))).toEqual(['test-author'])
})

test('the account cannot be changed through ordinary settings saves', async () => {
  const s = await run.page.evaluate(() => window.api.updateSettings({
    profile: { authorId: 'forged', displayName: 'X', account: { provider: 'google', subject: '1', email: '', name: '', signedInAt: '' } }
  }))
  expect(s.profile.authorId).toBe('test-author')
  expect(s.profile.account).toBeUndefined()
  expect(s.profile.displayName).toBe('X')
})
