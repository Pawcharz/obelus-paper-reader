import { expect, test } from '@playwright/test'
import { launch } from './helpers'

test('the app opens and the bridge answers', async () => {
  const run = await launch()
  await expect(run.page.getByTestId('app-root')).toBeVisible()
  const settings = await run.page.evaluate(() => window.api.getSettings())
  expect(settings.profile.authorId).toBe('test-author')
  const recognizers = await run.page.evaluate(() => window.api.listRecognizers())
  expect(recognizers.length).toBeGreaterThan(0)
  await run.close()
})
