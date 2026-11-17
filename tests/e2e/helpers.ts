import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Launched {
  app: ElectronApplication
  page: Page
  dir: string
  workspace: string
  userData: string
  cache: string
  relaunch: () => Promise<Launched>
  close: () => Promise<void>
}

export const repoRoot = resolve(__dirname, '../..')
export const fixtures = join(repoRoot, 'tests', 'fixtures')

export async function launch(existing?: { dir: string; settings?: boolean }): Promise<Launched> {
  const dir = existing?.dir ?? (await fs.mkdtemp(join(tmpdir(), 'pr-e2e-')))
  const workspace = join(dir, 'workspace')
  const userData = join(dir, 'userdata')
  const cache = join(dir, 'cache')
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(userData, { recursive: true })
  if (!existing) {
    const wsId = randomUUID()
    await fs.writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({
        schema: 1,
        profile: { authorId: 'test-author', displayName: 'Tester' },
        workspaces: [{ id: wsId, name: 'Personal', path: workspace }],
        activeWorkspaceId: wsId,
        // Tests were laid out with half-page margins; the 100% default is tested on its own.
        marginShare: 0.5
      })
    )
    await fs.mkdir(join(workspace, 'papers'), { recursive: true })
    await fs.mkdir(join(workspace, 'maps'), { recursive: true })
  }
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PAPER_READER_USERDATA: userData,
      PAPER_READER_CACHE: cache,
      PAPER_READER_FAKE_NET: fixtures,
      PAPER_READER_HIDDEN: '1'
    }
  })
  const page = await app.firstWindow()
  // The same size on any screen, so a tablet held upright (800 px wide) gives the same layout as a laptop.
  await page.setViewportSize({ width: 1280, height: 760 })
  await page.waitForSelector('[data-testid="app-root"]')
  const self: Launched = {
    app,
    page,
    dir,
    workspace,
    userData,
    cache,
    close: async () => {
      await app.close()
    },
    relaunch: async () => {
      await app.close()
      return launch({ dir })
    }
  }
  return self
}
