/**
 * The local models the app can download, and the llama.cpp server that runs them. Every file is
 * pinned: Hugging Face files by repository commit, llama.cpp by release tag, each with its SHA-256,
 * so a changed or replaced file is refused rather than run.
 *
 * Licences (checked 25 Nov 2026, see docs/production-readiness.md §6): llama.cpp MIT; Uni-MuMER and
 * Qwen3.5 weights Apache-2.0. The files are downloaded from their publishers, not redistributed.
 */

import type { ModelPackId } from '../../shared/types'

export type { ModelPackId }

export interface ModelFile {
  /** Name on disk inside the pack's folder. */
  name: string
  url: string
  sha256: string
  size: number
}

export interface ModelPack {
  id: ModelPackId
  /** Folder under <userData>/models. */
  dir: string
  /** Shown in Settings. */
  title: string
  /** What it is for, one sentence. */
  purpose: string
  credit: string
  /** The model's name for llama-server's --alias, checked before a running server is used. */
  alias: string
  model: ModelFile
  mmproj: ModelFile
  /** Context size the server is started with. */
  context: number
  /** Platforms it is offered on. */
  platforms: NodeJS.Platform[]
}

export const LLAMA_TAG = 'b12633'

export interface ServerBuild {
  /** Archive name on the llama.cpp release. */
  asset: string
  sha256: string
  size: number
  /** Name of the server binary somewhere inside the archive. */
  binary: string
}

/** CPU builds of llama.cpp (the models run on the CPU: as fast as the GPU on the test laptops). */
export const SERVER_BUILDS: Partial<Record<string, ServerBuild>> = {
  'win32-x64': {
    asset: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`,
    sha256: 'bad9fe0c1b554bcb1ce5630d66ad34a2285a8b390400513cc02f56feafd62c8e',
    size: 25038006,
    binary: 'llama-server.exe'
  },
  'linux-x64': {
    asset: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`,
    sha256: '9c4a2c1bd1437f22831e0b56cc75329b321bac87225ffb5c83cd8d13b1f44fa2',
    size: 23225608,
    binary: 'llama-server'
  }
}

export function serverBuild(platform: string = process.platform, arch: string = process.arch): ServerBuild | undefined {
  return SERVER_BUILDS[`${platform}-${arch}`]
}

export function serverUrl(b: ServerBuild): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${b.asset}`
}

const UNIMUMER = 'https://huggingface.co/mradermacher/Uni-MuMER-Qwen3.5-2B-GGUF/resolve/9451fe296d68348d751adc6e71e32be810e6f489'
const QWEN4B = 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523'

export const MODEL_PACKS: Record<ModelPackId, ModelPack> = {
  math: {
    id: 'math',
    dir: 'uni-mumer-qwen3.5-2b',
    title: 'Maths reader',
    purpose: 'Reads handwritten maths in your notes as LaTeX.',
    credit: 'Uni-MuMER-Qwen3.5-2B (Apache-2.0), run by llama.cpp (MIT)',
    alias: 'Uni-MuMER-Qwen3.5-2B-Q8_0',
    model: {
      name: 'model-Q8_0.gguf',
      url: `${UNIMUMER}/Uni-MuMER-Qwen3.5-2B.Q8_0.gguf`,
      sha256: '14d238e613737f612bb6ec82c0fd0085448cd957e5660b820bd4c3f3fa34246e',
      size: 2012013152
    },
    mmproj: {
      name: 'mmproj-f16.gguf',
      url: `${UNIMUMER}/Uni-MuMER-Qwen3.5-2B.mmproj-f16.gguf`,
      sha256: 'efa4e7c7ad19508086a22df9377bd28bc40046a383341f0101c77964ddeb7607',
      size: 668227456
    },
    context: 2048,
    platforms: ['win32']
  },
  text: {
    id: 'text',
    dir: 'qwen3.5-4b',
    title: 'Handwriting reader',
    purpose: 'Turns your handwritten notes into text, with maths as LaTeX.',
    credit: 'Qwen3.5-4B (Apache-2.0), run by llama.cpp (MIT)',
    alias: 'qwen3.5-4b',
    model: {
      name: 'model-Q4_K_M.gguf',
      url: `${QWEN4B}/Qwen3.5-4B-Q4_K_M.gguf`,
      sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
      size: 2740937888
    },
    mmproj: {
      name: 'mmproj-F16.gguf',
      url: `${QWEN4B}/mmproj-F16.gguf`,
      sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
      size: 672423616
    },
    context: 4096,
    platforms: ['linux']
  }
}

/** The packs offered on this system. */
export function packsFor(platform: NodeJS.Platform = process.platform): ModelPack[] {
  return Object.values(MODEL_PACKS).filter((p) => p.platforms.includes(platform))
}
