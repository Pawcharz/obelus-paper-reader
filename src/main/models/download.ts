import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadOptions {
  sha256: string
  /** Expected size in bytes; also the progress total. */
  size: number
  signal?: AbortSignal
  /** Bytes of this file on disk so far (including a resumed part). */
  onProgress?: (done: number) => void
  fetchImpl?: typeof fetch
}

export class ChecksumError extends Error {}

/** SHA-256 of a file, hex. */
export async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), h)
  return h.digest('hex')
}

/**
 * Downloads `url` to `dest`. Bytes go to `dest.part` first, so an interrupted download resumes
 * where it stopped (an HTTP Range request) and a finished file is never half-written. The whole
 * file is checked against its SHA-256 before it is renamed into place; on a mismatch the part is
 * deleted and a ChecksumError thrown. A file already in place with the right size is kept as is.
 */
export async function downloadFile(url: string, dest: string, o: DownloadOptions): Promise<void> {
  const f = o.fetchImpl ?? fetch
  const done = await fs.stat(dest).catch(() => null)
  if (done?.size === o.size) { o.onProgress?.(o.size); return }
  const part = `${dest}.part`
  let have = (await fs.stat(part).catch(() => null))?.size ?? 0
  if (have > o.size) { await fs.rm(part, { force: true }); have = 0 }
  if (have < o.size) {
    const res = await f(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      signal: o.signal,
      redirect: 'follow'
    })
    if (res.status === 200) have = 0 // the server ignored the range: start over
    else if (res.status !== 206) throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`)
    if (!res.body) throw new Error(`Empty response for ${url}`)
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
    let got = have
    let last = 0
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      got += chunk.length
      const now = Date.now()
      if (now - last > 200) { last = now; o.onProgress?.(got) }
    })
    await pipeline(body, out, { signal: o.signal })
    o.onProgress?.(got)
  }
  const size = (await fs.stat(part)).size
  const sum = await fileSha256(part)
  if (size !== o.size || sum !== o.sha256) {
    await fs.rm(part, { force: true })
    throw new ChecksumError(`The downloaded file does not match its checksum: ${url.split('/').pop()}. Try again.`)
  }
  await fs.rename(part, dest)
}
