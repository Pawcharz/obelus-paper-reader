import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'UNKNOWN'])
let counter = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Retries an operation that OneDrive or an antivirus can briefly block by holding a lock. */
export async function withRetry<T>(op: () => Promise<T>, attempts = 8): Promise<T> {
  let delay = 40
  for (let i = 0; ; i++) {
    try {
      return await op()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (i >= attempts - 1 || !RETRYABLE.has(code)) throw e
      await sleep(delay)
      delay = Math.min(delay * 2, 1500)
    }
  }
}

/** Writes to a temporary name and renames, so a reader or sync client never sees half a file. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${counter++}`
  try {
    await withRetry(() => fs.writeFile(tmp, data))
    await withRetry(() => fs.rename(tmp, path))
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await withRetry(() => fs.readFile(path, 'utf8'))) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Moves a file, falling back to copy and delete across drives. */
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true })
  try {
    await withRetry(() => fs.rename(from, to))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await withRetry(() => fs.copyFile(from, to))
    await fs.rm(from, { force: true })
  }
}
