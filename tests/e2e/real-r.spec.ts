import { _electron as electron, expect, test } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './helpers'

// The R cases with the real network and a brand-new setup. Run with REAL_NET=1.
test.skip(!process.env.REAL_NET, 'REAL_NET is needed')

test('R1–R3 on the real network', async () => {
  test.setTimeout(180000)
  const dir = await fs.mkdtemp(join(tmpdir(), 'pr-real-'))
  const env = { ...process.env, PAPER_READER_USERDATA: join(dir, 'userdata'), PAPER_READER_HIDDEN: '1' }
  delete (env as Record<string, string | undefined>).PAPER_READER_FAKE_NET
  let app = await electron.launch({ args: ['.'], cwd: repoRoot, env })
  let page = await app.firstWindow()
  // R2: first run asks where the library lives.
  await expect(page.getByTestId('welcome')).toBeVisible()
  await expect(page.getByTestId('welcome-path')).toHaveValue(/Paper Library$/)
  await page.getByTestId('welcome-path').fill(join(dir, 'library'))
  await page.getByTestId('welcome-create').click()
  // R3: add by arXiv ID, named by its real title, with the PDF.
  await page.getByTestId('add-id').fill('1706.03762')
  await page.getByTestId('add-id-btn').click()
  await expect(page.getByTestId('paper-row')).toContainText('Attention Is All You Need', { timeout: 60000 })
  await expect(page.getByTestId('source-link')).toContainText('arXiv 1706.03762v')
  const list = await page.evaluate(() => window.api.listPapers())
  expect(list[0].meta.has_pdf).toBe(true)
  console.log('folder', list[0].folder)
  await page.getByTestId('paper-row').first().locator('.title-cell').click()
  await page.waitForSelector('[data-testid="pdf-0"][data-rendered]', { timeout: 30000 })
  // R1: everything is still there after closing and reopening.
  await page.evaluate((id) => window.api.updatePaper(id, { tags: ['kept'] }), list[0].meta.id)
  await app.close()
  app = await electron.launch({ args: ['.'], cwd: repoRoot, env })
  page = await app.firstWindow()
  await expect(page.getByTestId('paper-row')).toContainText('Attention Is All You Need')
  await expect(page.getByTestId('paper-row')).toContainText('kept')
  await app.close()
  await fs.rm(dir, { recursive: true, force: true })
})
