import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsStore } from '../../src/main/settings'

describe('settings', () => {
  it('saves a change to disk, so it survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-settings-'))
    const first = new SettingsStore(dir)
    await first.get()
    await first.update({ usageLog: true })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).usageLog).toBe(true)
    expect((await new SettingsStore(dir).get()).usageLog).toBe(true)
  })
})

describe('defaults', () => {
  it('starts with 100% writing margins', async () => {
    const { defaultSettings } = await import('../../src/main/settings')
    expect(defaultSettings().marginShare).toBe(1)
  })
})
