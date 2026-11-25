import { ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { availableParallelism, constants, setPriority } from 'node:os'
import { dirname } from 'node:path'
import type { ServerFiles } from '../models/store'

export interface LlamaServerOptions {
  /** The model's name; the server is started with it as --alias, and a running server must report it. */
  alias: string
  /** Where llama-server and the model are; throws (ModelMissingError) when they are not there. */
  files: () => Promise<ServerFiles>
  context: number
  /**
   * A fixed port, for tests and the lab: a server already running there with the same alias is used.
   * Missing: a free port is picked each time the server starts, so nothing else is ever talked to.
   */
  port?: number
  /** CPU threads. Missing: half the logical cores (about one per physical core), at least 2. */
  threads?: number
  /** Stop the server after this long without a request, to give its memory back. 0: never. */
  idleMs?: number
  /** For messages: "maths model", "handwriting model". */
  label: string
}

const START_TIMEOUT_MS = 180000
const DEFAULT_IDLE_MS = 15 * 60 * 1000

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

/** Whether the llama-server at `port` is up and serving the model named `alias`. */
export async function servesModel(port: number, alias: string): Promise<boolean> {
  try {
    const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    if (!h.ok || ((await h.json()) as { status?: string }).status !== 'ok') return false
    const m = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) })
    if (!m.ok) return false
    // llama.cpp b12633 reports the first --alias as the model's id, and all of them as `aliases`.
    const j = (await m.json()) as { data?: { id?: string; aliases?: string[] }[] }
    return (j.data ?? []).some((d) => d.id === alias || (Array.isArray(d.aliases) && d.aliases.includes(alias)))
  } catch {
    return false
  }
}

export function defaultThreads(): number {
  return Math.max(2, Math.floor(availableParallelism() / 2))
}

/**
 * One llama.cpp server for one model, started on first use and kept while it is used. CPU only,
 * below-normal priority so writing and scrolling stay smooth, stopped after a while unused and
 * with the app.
 */
export class LlamaServer {
  private child: ChildProcess | null = null
  private ready: Promise<string> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private busy = 0

  constructor(private readonly o: LlamaServerOptions) {}

  private start(): Promise<string> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      if (this.o.port && (await servesModel(this.o.port, this.o.alias))) return `http://127.0.0.1:${this.o.port}`
      const f = await this.o.files()
      const port = this.o.port ?? (await freePort())
      const child = spawn(f.server, [
        '--alias', this.o.alias, '-m', f.model, '--mmproj', f.mmproj,
        '-ngl', '0', '--no-mmproj-offload', '-dev', 'none', '-c', String(this.o.context), '-np', '1',
        '--host', '127.0.0.1', '--port', String(port), '--no-webui',
        '-t', String(this.o.threads ?? defaultThreads())
      ], {
        windowsHide: true,
        stdio: 'ignore',
        cwd: dirname(f.server),
        // The Linux build keeps its shared libraries beside the binary.
        env: process.platform === 'linux' ? { ...process.env, LD_LIBRARY_PATH: [dirname(f.server), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : process.env
      })
      this.child = child
      let spawnError: Error | null = null
      child.on('error', (e) => { spawnError = e })
      child.on('exit', () => { if (this.child === child) { this.child = null; this.ready = null } })
      try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not allowed: normal priority */ }
      const until = Date.now() + START_TIMEOUT_MS
      while (Date.now() < until) {
        if (spawnError) throw new Error(`The ${this.o.label} could not be started: ${(spawnError as Error).message}`)
        if (child.exitCode !== null) throw new Error(`The ${this.o.label} stopped while starting.`)
        if (await servesModel(port, this.o.alias)) return `http://127.0.0.1:${port}`
        await new Promise((r) => setTimeout(r, 500))
      }
      child.kill()
      throw new Error(`The ${this.o.label} did not start in time.`)
    })().catch((e) => { this.ready = null; throw e })
    return this.ready
  }

  /** Runs one request against the server (started if needed); the idle clock restarts afterwards. */
  async use<T>(fn: (base: string) => Promise<T>): Promise<T> {
    this.busy++
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    try {
      return await fn(await this.start())
    } finally {
      this.busy--
      const idle = this.o.idleMs ?? DEFAULT_IDLE_MS
      if (this.busy === 0 && idle > 0 && this.child) {
        this.idleTimer = setTimeout(() => { if (this.busy === 0) this.stop() }, idle)
        this.idleTimer.unref()
      }
    }
  }

  stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.child?.kill()
    this.child = null
    this.ready = null
  }
}
