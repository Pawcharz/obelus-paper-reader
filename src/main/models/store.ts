import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLAMA_TAG, MODEL_PACKS, ModelPackId, ServerBuild, serverBuild, serverUrl } from './catalog'
import { downloadFile } from './download'
import type { ModelStatus } from '../../shared/types'

/** What llama-server needs to run one model. */
export interface ServerFiles {
  server: string
  model: string
  mmproj: string
}

export class ModelMissingError extends Error {
  readonly missing = true
}

/** Finds a file by name in a folder or the folders below it (llama.cpp archives nest the binaries). */
export async function findFile(dir: string, name: string, depth = 3): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name)
  if (depth > 0) {
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const found = await findFile(join(dir, e.name), name, depth - 1)
      if (found) return found
    }
  }
  return null
}

/** Unpacks a .zip or .tar.gz with the system's tar (Windows 10+ ships bsdtar, which reads zip). */
export function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking llama.cpp failed (tar exit ${code}).`))))
  })
}

function allExist(f: ServerFiles | null): f is ServerFiles {
  return !!f && existsSync(f.server) && existsSync(f.model) && existsSync(f.mmproj)
}

export interface ModelStoreOptions {
  /** A folder the user chose (settings), laid out as `llama/` + `models/` like the equation lab. */
  overrideDir?: (id: ModelPackId) => Promise<string | undefined>
  /** Called whenever a pack's status changes (download progress, done, failed, removed). */
  onStatus?: (s: ModelStatus) => void
  /** Files set up earlier by the lab scripts on the author's computers; used when present. */
  legacy?: (id: ModelPackId) => ServerFiles | null
  platform?: string
  arch?: string
}

/** The lab layout: ~/code/math-ink-demo (maths) and ~/code/vlm-models (Linux text model). */
export function labFiles(id: ModelPackId): ServerFiles | null {
  const lab = join(homedir(), 'code', 'math-ink-demo')
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  if (id === 'math') return { server: join(lab, 'llama', exe), model: join(lab, 'models', 'model-Q8_0.gguf'), mmproj: join(lab, 'models', 'mmproj-f16.gguf') }
  const dir = join(homedir(), 'code', 'vlm-models', MODEL_PACKS.text.dir)
  return { server: join(lab, 'llama', exe), model: join(dir, MODEL_PACKS.text.model.name), mmproj: join(dir, MODEL_PACKS.text.mmproj.name) }
}

/**
 * The downloaded models, in <userData>/models: one folder per pack and one for llama.cpp, shared.
 * Nothing is downloaded unless `download` is called (the user said yes).
 */
export class ModelStore {
  private readonly jobs = new Map<ModelPackId, { abort: AbortController; done: number; total: number }>()
  private readonly errors = new Map<ModelPackId, string>()
  private readonly build: ServerBuild | undefined

  constructor(readonly root: string, private readonly o: ModelStoreOptions = {}) {
    this.build = serverBuild(o.platform, o.arch)
  }

  private serverDir(): string {
    return join(this.root, `llama-${LLAMA_TAG}`)
  }

  private async downloadedServer(): Promise<string | null> {
    return this.build ? findFile(this.serverDir(), this.build.binary) : null
  }

  private async downloaded(id: ModelPackId): Promise<ServerFiles | null> {
    const pack = MODEL_PACKS[id]
    const server = await this.downloadedServer()
    if (!server) return null
    const dir = join(this.root, pack.dir)
    return { server, model: join(dir, pack.model.name), mmproj: join(dir, pack.mmproj.name) }
  }

  /** The files to run, from the first place that has all of them; null when the pack is missing. */
  async files(id: ModelPackId): Promise<{ files: ServerFiles; source: 'downloaded' | 'folder' } | null> {
    const chosen = await this.o.overrideDir?.(id)
    if (chosen) {
      const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
      const pack = MODEL_PACKS[id]
      const f = { server: join(chosen, 'llama', exe), model: join(chosen, 'models', pack.model.name), mmproj: join(chosen, 'models', pack.mmproj.name) }
      if (allExist(f)) return { files: f, source: 'folder' }
    }
    const d = await this.downloaded(id)
    if (allExist(d)) return { files: d, source: 'downloaded' }
    const legacy = this.o.legacy?.(id) ?? null
    if (allExist(legacy)) return { files: legacy, source: 'folder' }
    return null
  }

  /** Bytes still to download for a pack (llama.cpp only when it is not there yet). */
  private async plan(id: ModelPackId): Promise<number> {
    const pack = MODEL_PACKS[id]
    const server = (await this.downloadedServer()) ? 0 : this.build?.size ?? 0
    return server + pack.model.size + pack.mmproj.size
  }

  async status(id: ModelPackId): Promise<ModelStatus> {
    const pack = MODEL_PACKS[id]
    const base = { id, title: pack.title, purpose: pack.purpose, credit: pack.credit }
    if (!this.build || !pack.platforms.includes((this.o.platform ?? process.platform) as NodeJS.Platform)) {
      return { ...base, state: 'unsupported', bytes: 0, done: 0 }
    }
    const job = this.jobs.get(id)
    if (job) return { ...base, state: 'downloading', bytes: job.total, done: job.done }
    const found = await this.files(id)
    if (found) {
      const size = (await Promise.all([found.files.model, found.files.mmproj].map((f) => fs.stat(f).then((s) => s.size).catch(() => 0)))).reduce((a, b) => a + b, 0)
      return { ...base, state: 'ready', bytes: size, done: size, source: found.source, folder: join(found.files.model, '..') }
    }
    const error = this.errors.get(id)
    return { ...base, state: error ? 'error' : 'missing', bytes: await this.plan(id), done: 0, ...(error ? { error } : {}) }
  }

  private async emit(id: ModelPackId): Promise<void> {
    this.o.onStatus?.(await this.status(id))
  }

  /** Downloads what is missing of a pack; resolves when it is ready, rejects when it failed or was cancelled. */
  async download(id: ModelPackId): Promise<void> {
    if (this.jobs.has(id)) return
    const pack = MODEL_PACKS[id]
    const build = this.build
    if (!build) throw new Error('Local models are not available on this system (needs 64-bit Windows or Linux on x64).')
    const abort = new AbortController()
    const job = { abort, done: 0, total: await this.plan(id) }
    this.jobs.set(id, job)
    this.errors.delete(id)
    void this.emit(id)
    let before = 0
    const progress = (n: number) => { job.done = before + n; void this.emit(id) }
    try {
      await fs.mkdir(this.root, { recursive: true })
      if (!(await this.downloadedServer())) {
        const archive = join(this.root, build.asset)
        await downloadFile(serverUrl(build), archive, { sha256: build.sha256, size: build.size, signal: abort.signal, onProgress: progress })
        const tmp = `${this.serverDir()}.tmp`
        await fs.rm(tmp, { recursive: true, force: true })
        await fs.mkdir(tmp, { recursive: true })
        await extract(archive, tmp)
        const bin = await findFile(tmp, build.binary)
        if (!bin) throw new Error(`${build.binary} was not found in ${build.asset}.`)
        if (process.platform !== 'win32') await fs.chmod(bin, 0o755)
        await fs.rm(this.serverDir(), { recursive: true, force: true })
        await fs.rename(tmp, this.serverDir())
        await fs.rm(archive, { force: true })
        before += build.size
      }
      const dir = join(this.root, pack.dir)
      await fs.mkdir(dir, { recursive: true })
      for (const f of [pack.mmproj, pack.model]) {
        await downloadFile(f.url, join(dir, f.name), { sha256: f.sha256, size: f.size, signal: abort.signal, onProgress: progress })
        before += f.size
      }
    } catch (e) {
      if (!abort.signal.aborted) this.errors.set(id, (e as Error).message)
      throw abort.signal.aborted ? new Error('Download cancelled.') : e
    } finally {
      this.jobs.delete(id)
      void this.emit(id)
    }
  }

  /** Stops a download; what was fetched so far is kept and the next download resumes from it. */
  cancel(id: ModelPackId): void {
    this.jobs.get(id)?.abort.abort()
  }

  /** Deletes a downloaded pack (never a folder the user chose), and llama.cpp when no pack needs it. */
  async remove(id: ModelPackId): Promise<void> {
    this.cancel(id)
    await fs.rm(join(this.root, MODEL_PACKS[id].dir), { recursive: true, force: true })
    const others = Object.values(MODEL_PACKS).filter((p) => p.id !== id && existsSync(join(this.root, p.dir)))
    if (others.length === 0) await fs.rm(this.serverDir(), { recursive: true, force: true })
    this.errors.delete(id)
    await this.emit(id)
  }
}
