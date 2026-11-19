import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import {
  AppSettings,
  DEFAULT_CACHE_MAX_AGE_DAYS,
  DEFAULT_CACHE_MAX_BYTES,
  DEFAULT_MARGIN_WIDTH,
  DEFAULT_SEARCH_URL,
  SCHEMA_VERSION
} from '../shared/types'
import { readJson, writeAtomic } from './storage/atomic'

export function defaultSettings(): AppSettings {
  let name = 'me'
  try {
    name = userInfo().username || name
  } catch {
    /* some systems have no user info */
  }
  return {
    schema: SCHEMA_VERSION,
    profile: { authorId: randomUUID(), displayName: name },
    workspaces: [],
    activeWorkspaceId: '',
    recognizer: '',
    searchUrlTemplate: DEFAULT_SEARCH_URL,
    cacheMaxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
    cacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
    marginWidth: DEFAULT_MARGIN_WIDTH,
    marginShare: 1,
    usageLog: false,
    inputMode: 'pen',
    mathLayout: 'wrap'
  }
}

export class SettingsStore {
  private current: AppSettings | null = null
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, 'settings.json')
  }

  async get(): Promise<AppSettings> {
    if (!this.current) {
      const saved = await readJson<Partial<AppSettings>>(this.file).catch(() => null)
      this.current = { ...defaultSettings(), ...(saved ?? {}) }
      if (!saved) await this.persist()
    }
    return this.current
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const now = await this.get()
    this.current = { ...now, ...patch, schema: SCHEMA_VERSION }
    await this.persist()
    return this.current
  }

  private async persist(): Promise<void> {
    await writeAtomic(this.file, JSON.stringify(this.current, null, 2))
  }
}
