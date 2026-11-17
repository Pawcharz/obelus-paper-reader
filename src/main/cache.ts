import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface PurgeLimits {
  maxAgeMs: number
  maxBytes: number
  /** Paths in use right now; these are never deleted. */
  keep: Set<string>
  now?: number
}

export interface PurgeReport {
  deleted: string[]
  remainingBytes: number
}

/** The access time on disk is unreliable on Windows, so opening a preview updates its modified time. */
export async function touch(path: string): Promise<void> {
  const now = new Date()
  await fs.utimes(path, now, now).catch(() => undefined)
}

/** Spec section 10: removes previews unopened for too long, then the oldest above the size cap. */
export async function purgeCache(dir: string, limits: PurgeLimits): Promise<PurgeReport> {
  const now = limits.now ?? Date.now()
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return { deleted: [], remainingBytes: 0 }
  }
  const files: { path: string; mtime: number; size: number }[] = []
  for (const n of names) {
    const path = join(dir, n)
    try {
      const st = await fs.stat(path)
      if (st.isFile()) files.push({ path, mtime: st.mtimeMs, size: st.size })
    } catch {
      /* already gone */
    }
  }
  const deleted: string[] = []
  const remove = async (path: string): Promise<boolean> => {
    if (limits.keep.has(path)) return false
    try {
      await fs.rm(path, { force: true })
      deleted.push(path)
      return true
    } catch {
      return false
    }
  }

  const survivors: typeof files = []
  for (const f of files) {
    if (now - f.mtime > limits.maxAgeMs && (await remove(f.path))) continue
    survivors.push(f)
  }
  survivors.sort((a, b) => a.mtime - b.mtime)
  let total = survivors.reduce((s, f) => s + f.size, 0)
  for (const f of survivors) {
    if (total <= limits.maxBytes) break
    if (await remove(f.path)) total -= f.size
  }
  return { deleted, remainingBytes: total }
}
