import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { defaultMathDir, labMathFiles, MathEngine } from '../../src/main/recognition/mathEngine'
import { ModelMissingError } from '../../src/main/models/store'

// Starts the real maths model (set up by lab/equation-recognition/setup.cmd) and reads one of the author's
// handwritten equations, rendered the way the app renders it. Skips when the model is not set up.
const fixture = join(__dirname, '..', 'fixtures', 'real-math-ink-sum.png')
const ready = existsSync(join(defaultMathDir(), 'models', 'model-Q8_0.gguf')) && existsSync(fixture)

describe.skipIf(!ready)('MathEngine with the real model', () => {
  // Port 18091 and 3 threads, so it can run beside the app.
  const engine = new MathEngine(labMathFiles, { port: 18091, threads: 3 })
  afterAll(() => engine.dispose())

  it('reads a handwritten sum as LaTeX', async () => {
    const image = 'data:image/png;base64,' + readFileSync(fixture).toString('base64')
    const r = await engine.recognize(image)
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    // Label: \sum_{i=1}^{n} i=\frac{n(n+1)}{2}
    expect(r.latex.replace(/\s+/g, '')).toBe('\\sum_{i=1}^{n}i=\\frac{n(n+1)}{2}')
  })

  it('reports a missing model instead of throwing', async () => {
    const broken = new MathEngine(async () => { throw new ModelMissingError('The maths reader is not downloaded.') })
    const r = await broken.recognize('data:image/png;base64,')
    expect(r.ok).toBe(false)
    expect(r.missing).toBe(true)
    broken.dispose()
  })
})
