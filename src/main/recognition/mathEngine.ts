import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanMathLatex, MATH_PROMPT } from '../../shared/mathInk'
import { MODEL_PACKS } from '../models/catalog'
import { labFiles, ModelMissingError, ServerFiles } from '../models/store'
import { LlamaServer } from './llamaServer'

export interface MathResult {
  ok: boolean
  latex: string
  /** What the model wrote before cleanup. */
  raw: string
  ms: number
  error?: string
  /** The maths model is not downloaded: the note keeps its plain text and nothing is shown as an error. */
  missing?: boolean
}

/** Where the equation lab's setup.ps1 put llama.cpp and the model (the author's computers only). */
export function defaultMathDir(): string {
  return join(homedir(), 'code', 'math-ink-demo')
}

const REQUEST_TIMEOUT_MS = 120000

export interface MathEngineOptions {
  /** A fixed port and fewer threads, for tests that run beside the app. */
  port?: number
  threads?: number
  idleMs?: number
}

/**
 * Handwritten maths through a local llama.cpp server running Uni-MuMER-Qwen3.5-2B. The server is
 * started on first use (loading takes ~10 s, a reading 1–12 s on CPU), stopped after a while unused
 * and with the app. CPU only: on both test laptops it was as fast as or faster than the GPU.
 */
export class MathEngine {
  private readonly server: LlamaServer

  /** `files` says where the server and model are; it throws ModelMissingError when they are not there. */
  constructor(files: () => Promise<ServerFiles>, opts: MathEngineOptions = {}) {
    this.server = new LlamaServer({
      alias: MODEL_PACKS.math.alias,
      files,
      context: MODEL_PACKS.math.context,
      label: 'maths model',
      ...opts
    })
  }

  /** Reads one PNG (a data: URL) of handwritten maths. */
  async recognize(image: string): Promise<MathResult> {
    const started = Date.now()
    try {
      return await this.server.use(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: MATH_PROMPT }] }],
            temperature: 0, max_tokens: 512, chat_template_kwargs: { enable_thinking: false }
          })
        })
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
        if (!res.ok) throw new Error(j.error?.message ?? res.statusText)
        const raw = (j.choices?.[0]?.message?.content ?? '').trim()
        return { ok: true, latex: cleanMathLatex(raw), raw, ms: Date.now() - started }
      })
    } catch (e) {
      return {
        ok: false, latex: '', raw: '', ms: Date.now() - started, error: (e as Error).message,
        ...(e instanceof ModelMissingError ? { missing: true } : {})
      }
    }
  }

  dispose(): void {
    this.server.stop()
  }
}

/** The lab's files, for tests on the author's computers. */
export async function labMathFiles(): Promise<ServerFiles> {
  return labFiles('math')!
}
