import { _electron as electron, test } from '@playwright/test'
import { join } from 'node:path'
import { repoRoot } from './helpers'

// Takes pictures of the demo library, for looking at. Run with SHOT_DIR set after making the demo.
const SHOTS = process.env.SHOT_DIR ?? ''
test.skip(!SHOTS, 'SHOT_DIR is needed')

test('screens', async () => {
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, PAPER_READER_USERDATA: join(repoRoot, 'demo', 'userdata'), PAPER_READER_HIDDEN: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="library"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, 'demo-library.png') })
  await page.getByTestId('nav-map').click()
  await page.getByTestId('map-item').filter({ hasText: 'Bezier' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, 'demo-map-bezier.png') })
  await page.getByTestId('map-item').filter({ hasText: 'research' }).click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: join(SHOTS, 'demo-map-research.png') })
  await page.getByTestId('group-toggle').first().click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(SHOTS, 'demo-map-research-open.png') })
  await app.close()
})
