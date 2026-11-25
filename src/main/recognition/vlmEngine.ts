import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { cleanMathLatex } from '../../shared/mathInk'
import { RecognitionResult } from '../../shared/types'
import { FlatStroke, RecognitionEngine, RecognizeRequest } from './engine'
import { LlamaServer } from './llamaServer'
import { ModelMissingError, ServerFiles } from '../models/store'

/**
 * Handwriting (text with maths inside) read by a small local vision-language model through
 * llama.cpp's `llama-server`, for systems without Windows Ink (the Linux build). Each written line
 * is drawn black on white and the model is asked for an exact transcription with maths as `$…$`.
 *
 * Model choice and numbers: lab/text-recognition/README.md (dev repo). The server is started on first
 * use, like the maths model (MathEngine), on a port of its own.
 */

export const VLM_PROMPT =
  'This is a handwritten note, in English or Polish, which may contain some mathematics. ' +
  'Transcribe it exactly as written, keeping its line breaks. Ordinary words, abbreviations (like RNN or MDN) and punctuation are plain text. ' +
  'Only formulas, variables with subscripts or superscripts, and Greek letters go in LaTeX inside $...$. ' +
  'Do not correct, translate, complete or explain anything. Output only the transcription.'

export interface VlmModel {
  /** Folder name under the models dir, and the alias the server reports. */
  id: string
  model: string
  mmproj: string
}

/** The models measured in lab/text-recognition; the first is the default. */
export const VLM_MODELS: VlmModel[] = [
  { id: 'qwen3.5-4b', model: 'model-Q4_K_M.gguf', mmproj: 'mmproj-F16.gguf' },
  { id: 'qwen3.5-2b', model: 'model-Q8_0.gguf', mmproj: 'mmproj-F16.gguf' }
]

export interface VlmOptions {
  /**
   * Where llama-server and the model are (the app: the downloaded "text" pack). Throws
   * ModelMissingError when they are not there. Missing: built from modelsDir and serverDir (the lab).
   */
  files?: () => Promise<ServerFiles>
  /** Folder with one subfolder per model (VLM_MODELS ids). Default ~/code/vlm-models. */
  modelsDir?: string
  /** Folder with llama-server. Default: the one the maths lab set up, ~/code/math-ink-demo/llama. */
  serverDir?: string
  model?: VlmModel
  /** A fixed port, for tests beside the app; missing: a free port. */
  port?: number
  threads?: number
  prompt?: string
  /** Height in pixels of a typical stroke in the drawn line (see textLineLayout). */
  strokePx?: number
  /** Read the whole note as one image (default: measured better) instead of one image per written line. */
  wholeNote?: boolean
}

const REQUEST_TIMEOUT_MS = 180000

export interface VlmReading {
  ok: boolean
  text: string
  raw: string
  ms: number
  error?: string
  missing?: boolean
}

export class VlmEngine implements RecognitionEngine {
  readonly name = 'vlm'
  private readonly server: LlamaServer
  private readonly o: Required<Omit<VlmOptions, 'threads' | 'port' | 'files'>> & { files?: () => Promise<ServerFiles> }

  constructor(opts: VlmOptions = {}) {
    this.o = {
      files: opts.files,
      modelsDir: opts.modelsDir ?? join(homedir(), 'code', 'vlm-models'),
      serverDir: opts.serverDir ?? join(homedir(), 'code', 'math-ink-demo', 'llama'),
      model: opts.model ?? VLM_MODELS[0],
      prompt: opts.prompt ?? VLM_PROMPT,
      strokePx: opts.strokePx ?? TEXT_STROKE_PX,
      wholeNote: opts.wholeNote ?? true
    }
    this.server = new LlamaServer({
      alias: this.o.model.id,
      files: () => this.files(),
      context: 4096,
      port: opts.port,
      threads: opts.threads,
      label: 'handwriting model'
    })
  }

  get recognizerName(): string {
    return `Handwriting (${this.o.model.id}, local)`
  }

  private labPaths(): ServerFiles {
    const dir = join(this.o.modelsDir, this.o.model.id)
    return {
      server: join(this.o.serverDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
      model: join(dir, this.o.model.model),
      mmproj: join(dir, this.o.model.mmproj)
    }
  }

  private async files(): Promise<ServerFiles> {
    if (this.o.files) return this.o.files()
    const p = this.labPaths()
    for (const f of Object.values(p)) if (!existsSync(f)) throw new ModelMissingError(`The handwriting model is not set up (missing ${f}).`)
    return p
  }

  /** Whether the lab's files are there (tests); the app asks the model store instead. */
  available(): boolean {
    return Object.values(this.labPaths()).every((f) => existsSync(f))
  }

  async listRecognizers(): Promise<string[]> {
    try {
      await this.files()
      return [this.recognizerName]
    } catch {
      return []
    }
  }

  /** Reads one PNG (data: URL) of one written line. */
  async readImage(image: string, keepLines = false): Promise<VlmReading> {
    const started = Date.now()
    try {
      return await this.server.use(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: this.o.prompt }] }],
            temperature: 0, max_tokens: 256, chat_template_kwargs: { enable_thinking: false }
          })
        })
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
        if (!res.ok) throw new Error(j.error?.message ?? res.statusText)
        const raw = (j.choices?.[0]?.message?.content ?? '').trim()
        return { ok: true, text: cleanVlmText(raw, keepLines), raw, ms: Date.now() - started }
      })
    } catch (e) {
      return {
        ok: false, text: '', raw: '', ms: Date.now() - started, error: (e as Error).message,
        ...(e instanceof ModelMissingError ? { missing: true } : {})
      }
    }
  }

  /** Reads strokes grouped in lines (flat x, y, x, y, … as RecognizeRequest gives them). */
  async recognize(request: RecognizeRequest): Promise<RecognitionResult> {
    const engine = { name: this.name, recognizer: this.recognizerName }
    const out: string[] = []
    for (const png of noteImages(request.lines.map((l) => l.map(unflatten)), this.o.strokePx, this.o.wholeNote)) {
      const r = await this.readImage(png, this.o.wholeNote)
      if (!r.ok) return { ok: false, text: '', candidates: [], engine, error: r.error, ...(r.missing ? { missing: 'text' as const } : {}) }
      if (r.text) out.push(r.text)
    }
    const text = out.join('\n')
    // One candidate list per whitespace-separated token, as the other engines give per word.
    return { ok: true, text, candidates: text.split(/\s+/).filter(Boolean).map((w) => [w]), engine }
  }

  dispose(): void {
    this.server.stop()
  }
}

function unflatten(s: FlatStroke): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]])
  return pts
}

/** Tidies the model's answer: no code fences, quotes, thinking or display-maths markers; LaTeX spans cleaned. */
export function cleanVlmText(raw: string, keepLines = false): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, '').trim()
  t = t.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, x: string) => `$${x}$`).replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, x: string) => `$${x}$`)
  t = t.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_m, x: string) => `$${x}$`)
  if (/^".*"$/s.test(t)) t = t.slice(1, -1)
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n')
  // Qwen3.5 writes CROHME-style spaced LaTeX ("h _ { t - 1 }", "\operatorname* { m i n }"), like the
  // maths model: tidy each span the same way, and join spelled-out names.
  t = t.replace(/\$([^$\n]+)\$/g, (_m, x: string) => {
    const joined = x.replace(/\\(mathrm|text|operatorname\*?)\s*\{\s*~?\s*((?:[A-Za-z]\s+)*[A-Za-z])\s*~?\s*\}/g, (_n, cmd: string, letters: string) =>
      cmd.startsWith('operatorname') && /^(m\s*i\s*n|m\s*a\s*x)$/.test(letters) ? `\\${letters.replace(/\s+/g, '')}` : `\\${cmd}{${letters.replace(/\s+/g, '')}}`)
    return `$${cleanMathLatex(joined)}$`
  })
  return (keepLines ? t.replace(/\n{2,}/g, '\n') : t.replace(/\n/g, ' ')).trim()
}

// ---- Drawing a written line for the model.

/** Typical stroke height in the image. Chosen on one writer's notes: lab/text-recognition/README.md. */
export const TEXT_STROKE_PX = 24

type Pt = readonly [number, number, ...number[]]

/** Median height of the strokes, ignoring dots and dashes: about one cursive word's height. */
export function strokeHeight(strokes: readonly (readonly Pt[])[]): number {
  const hs = strokes.map((s) => {
    let a = Infinity, b = -Infinity
    for (const p of s) { a = Math.min(a, p[1]); b = Math.max(b, p[1]) }
    return b - a
  }).filter((h) => Number.isFinite(h) && h > 0.5).sort((p, q) => p - q)
  return hs.length ? hs[Math.floor(hs.length / 2)] : 10
}

/**
 * Most pixels in one image. On CPU the model reads about 13 image tokens a second on 3 threads, and a
 * token is 32×32 px, so this keeps one image under ~30 s. A longer note is cut between written lines.
 */
export const MAX_IMAGE_PIXELS = 400_000

/**
 * The images to read for a note, given its strokes per written line. Whole note: as few images as
 * the pixel budget allows, each a run of consecutive lines, so a formula's limits or fraction parts
 * that line splitting cut off stay with it. Otherwise one image per line.
 */
export function noteImages(lines: readonly (readonly (readonly Pt[])[])[], strokePx = TEXT_STROKE_PX, whole = true): string[] {
  const groups: (readonly Pt[])[][] = []
  if (!whole) groups.push(...lines.map((l) => [...l]))
  else {
    // The scale is set by the whole note's strokes, so group sizes are measured at that scale.
    const scale = strokePx / strokeHeight(lines.flat())
    let cur: (readonly Pt[])[] = []
    for (const line of lines) {
      const next = [...cur, ...line]
      const l = layout(next, strokePx, scale)
      if (cur.length > 0 && l && l.w * l.h > MAX_IMAGE_PIXELS) { groups.push(cur); cur = [...line] } else cur = next
    }
    if (cur.length) groups.push(cur)
  }
  return groups.map((g) => textLinePng(g, strokePx)).filter((p): p is string => !!p)
}

function layout(strokes: readonly (readonly Pt[])[], strokePx: number, fixedScale?: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  if (!Number.isFinite(x0)) return null
  const pad = Math.round(strokePx * 0.5)
  const scale = Math.min(fixedScale ?? strokePx / strokeHeight(strokes), (2400 - 2 * pad) / Math.max(x1 - x0, 1))
  return { x0, y0, pad, scale, w: Math.round((x1 - x0) * scale + 2 * pad), h: Math.round((y1 - y0) * scale + 2 * pad) }
}

/** Black-on-white greyscale PNG of the strokes, as a data: URL. */
export function textLinePng(strokes: readonly (readonly Pt[])[], strokePx = TEXT_STROKE_PX): string | null {
  const l = layout(strokes, strokePx)
  if (!l) return null
  const { x0, y0, pad, scale, w, h } = l
  const map = (x: number, y: number): [number, number] => [(x - x0) * scale + pad, (y - y0) * scale + pad]
  const px = new Uint8Array(w * h).fill(255)
  const r = Math.max(1, strokePx * 0.05)
  const dot = (cx: number, cy: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        if (d <= r + 0.5) px[y * w + x] = Math.min(px[y * w + x], d <= r - 0.5 ? 0 : Math.round(255 * (d - (r - 0.5))))
      }
    }
  }
  for (const s of strokes) {
    if (s.length === 0) continue
    let [ax, ay] = map(s[0][0], s[0][1])
    dot(ax, ay)
    for (let i = 1; i < s.length; i++) {
      const [bx, by] = map(s[i][0], s[i][1])
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(r * 0.5, 0.5)))
      for (let k = 1; k <= steps; k++) dot(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps)
      ax = bx; ay = by
    }
  }
  return 'data:image/png;base64,' + encodePng(px, w, h).toString('base64')
}

function encodePng(gray: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1)
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8 // 8-bit greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
