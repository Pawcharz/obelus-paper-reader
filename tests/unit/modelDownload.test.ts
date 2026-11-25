import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, promises as fs, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LLAMA_TAG, MODEL_PACKS, packsFor, SERVER_BUILDS } from '../../src/main/models/catalog'
import { ChecksumError, downloadFile } from '../../src/main/models/download'
import { findFile, ModelStore } from '../../src/main/models/store'

const DATA = Buffer.alloc(300_000, 0).map((_, i) => (i * 7) % 251)
const SHA = createHash('sha256').update(DATA).digest('hex')

let server: Server
let base = ''
let ranges: (string | undefined)[] = []
let slow = false

beforeAll(async () => {
  server = createServer((req, res) => {
    ranges.push(req.headers.range)
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const from = m ? Number(m[1]) : 0
    res.writeHead(m ? 206 : 200, { 'Content-Length': DATA.length - from })
    const body = DATA.subarray(from)
    if (!slow) { res.end(body); return }
    // Slow: a chunk every 20 ms, so a test can cancel in the middle.
    let at = 0
    const t = setInterval(() => {
      if (res.destroyed) { clearInterval(t); return }
      res.write(body.subarray(at, at + 10_000))
      at += 10_000
      if (at >= body.length) { clearInterval(t); res.end() }
    }, 20)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`
})
afterAll(() => { server.close() })

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'obelus-models-'))
}

describe('downloadFile', () => {
  it('downloads, checks the checksum and puts the file in place', async () => {
    const dest = join(tmp(), 'a.gguf')
    const seen: number[] = []
    await downloadFile(base, dest, { sha256: SHA, size: DATA.length, onProgress: (n) => seen.push(n) })
    expect(readFileSync(dest).equals(DATA)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(seen.at(-1)).toBe(DATA.length)
  })

  it('resumes a part from where it stopped', async () => {
    const dest = join(tmp(), 'b.gguf')
    writeFileSync(`${dest}.part`, DATA.subarray(0, 100_000))
    ranges = []
    await downloadFile(base, dest, { sha256: SHA, size: DATA.length })
    expect(ranges).toEqual(['bytes=100000-'])
    expect(readFileSync(dest).equals(DATA)).toBe(true)
  })

  it('refuses a file whose checksum does not match, and deletes the part', async () => {
    const dest = join(tmp(), 'c.gguf')
    await expect(downloadFile(base, dest, { sha256: '0'.repeat(64), size: DATA.length })).rejects.toBeInstanceOf(ChecksumError)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('keeps what it has when cancelled', async () => {
    const dest = join(tmp(), 'd.gguf')
    const abort = new AbortController()
    slow = true
    try {
      const p = downloadFile(base, dest, { sha256: SHA, size: DATA.length, signal: abort.signal })
      await new Promise((r) => setTimeout(r, 120))
      abort.abort()
      await expect(p).rejects.toThrow()
    } finally { slow = false }
    expect(existsSync(dest)).toBe(false)
    const part = (await fs.stat(`${dest}.part`)).size
    expect(part).toBeGreaterThan(0)
    expect(part).toBeLessThan(DATA.length)
  })

  it('does not download a file that is already there', async () => {
    const dest = join(tmp(), 'e.gguf')
    writeFileSync(dest, DATA)
    ranges = []
    await downloadFile(base, dest, { sha256: SHA, size: DATA.length })
    expect(ranges).toEqual([])
  })
})

describe('model catalog', () => {
  it('pins every file to a commit or release tag with a SHA-256', () => {
    for (const pack of Object.values(MODEL_PACKS)) {
      for (const f of [pack.model, pack.mmproj]) {
        expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.size).toBeGreaterThan(1e8)
      }
    }
    for (const b of Object.values(SERVER_BUILDS)) {
      expect(b!.asset).toContain(LLAMA_TAG)
      expect(b!.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('offers the maths reader on Windows and the handwriting reader on Linux', () => {
    expect(packsFor('win32').map((p) => p.id)).toEqual(['math'])
    expect(packsFor('linux').map((p) => p.id)).toEqual(['text'])
    expect(packsFor('darwin')).toEqual([])
  })
})

describe('ModelStore', () => {
  function fakeInstall(root: string): void {
    const bin = join(root, `llama-${LLAMA_TAG}`, 'build', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'llama-server.exe'), 'x')
    const dir = join(root, MODEL_PACKS.math.dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, MODEL_PACKS.math.model.name), 'model')
    writeFileSync(join(dir, MODEL_PACKS.math.mmproj.name), 'mm')
  }

  it('says what is missing and how much there is to download', async () => {
    const store = new ModelStore(tmp(), { platform: 'win32', arch: 'x64' })
    const s = await store.status('math')
    expect(s.state).toBe('missing')
    expect(s.bytes).toBe(MODEL_PACKS.math.model.size + MODEL_PACKS.math.mmproj.size + SERVER_BUILDS['win32-x64']!.size)
    expect(await store.files('math')).toBeNull()
  })

  it('finds a downloaded pack, with the server nested in the archive folder', async () => {
    const root = tmp()
    fakeInstall(root)
    const store = new ModelStore(root, { platform: 'win32', arch: 'x64' })
    const s = await store.status('math')
    expect(s.state).toBe('ready')
    expect(s.source).toBe('downloaded')
    expect((await store.files('math'))?.files.server).toBe(await findFile(join(root, `llama-${LLAMA_TAG}`), 'llama-server.exe'))
  })

  it('is unsupported where there is no llama.cpp build or the pack is for another system', async () => {
    expect((await new ModelStore(tmp(), { platform: 'win32', arch: 'arm64' }).status('math')).state).toBe('unsupported')
    expect((await new ModelStore(tmp(), { platform: 'win32', arch: 'x64' }).status('text')).state).toBe('unsupported')
  })

  it('removes a downloaded pack, and llama.cpp with it when nothing else needs it', async () => {
    const root = tmp()
    fakeInstall(root)
    const seen: string[] = []
    const store = new ModelStore(root, { platform: 'win32', arch: 'x64', onStatus: (s) => seen.push(s.state) })
    await store.remove('math')
    expect(existsSync(join(root, MODEL_PACKS.math.dir))).toBe(false)
    expect(existsSync(join(root, `llama-${LLAMA_TAG}`))).toBe(false)
    expect(seen.at(-1)).toBe('missing')
  })
})

describe('unpacking llama.cpp', () => {
  it('unpacks an archive with the system tar and finds the server in it', async () => {
    const { extract } = await import('../../src/main/models/store')
    const { spawnSync } = await import('node:child_process')
    const src = tmp()
    mkdirSync(join(src, 'build', 'bin'), { recursive: true })
    const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    writeFileSync(join(src, 'build', 'bin', name), 'binary')
    const archive = join(tmp(), process.platform === 'win32' ? 'llama.zip' : 'llama.tar.gz')
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar'
    const made = spawnSync(tar, process.platform === 'win32' ? ['-a', '-cf', archive, '-C', src, 'build'] : ['-czf', archive, '-C', src, 'build'])
    expect(made.status).toBe(0)
    const into = tmp()
    await extract(archive, into)
    expect(await findFile(into, name)).toBe(join(into, 'build', 'bin', name))
  })
})
