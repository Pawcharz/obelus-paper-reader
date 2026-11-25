/**
 * Handwritten maths → LaTeX helpers shared by the renderer (drawing the ink image) and tests.
 * Ported from the equation recognition lab (lab/equation-recognition), where both were measured on
 * one writer's handwriting (the author's): see that folder's README for the numbers.
 */

/** The prompt the model (Uni-MuMER) was fine-tuned with. Changing it is untested. */
export const MATH_PROMPT =
  'I have an image of a handwritten mathematical expression. Please write out the expression of the formula in the image using LaTeX format.'

/**
 * Constant glyph size: a typical stroke becomes this many pixels, however long the equation.
 * Chosen on 136 lab samples (23 Nov 2026): 16, 20, 24 and 32 px all read 92–96 exactly (noise), and
 * 16 px was fastest: mean 3.3 s against 5.8 s at 32 px and 5.9 s with the old fit-to-box render.
 */
export const MATH_GLYPH_PX = 16
const MAX_W = 2400
const MAX_PIXELS = 1.5e6

import type { MathSegment } from './types'
export type { MathSegment }

type Point = readonly [number, number, ...number[]]

/** Typical glyph size: median over strokes of max(width, height), ignoring dots. */
export function glyphSize(strokes: readonly (readonly Point[])[]): number {
  const sizes = strokes
    .map((s) => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
      for (const [x, y] of s) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y) }
      return Math.max(c - a, d - b)
    })
    .filter((v) => Number.isFinite(v) && v > 2)
    .sort((p, q) => p - q)
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 20
}

export interface MathImageLayout {
  width: number
  height: number
  lineWidth: number
  /** Maps a point in stroke units to image pixels. */
  map: (x: number, y: number) => [number, number]
}

/** Where to draw the strokes so glyphs come out MATH_GLYPH_PX tall, within the size caps. */
export function mathImageLayout(strokes: readonly (readonly Point[])[], glyph = MATH_GLYPH_PX): MathImageLayout | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  if (!Number.isFinite(x0)) return null
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1)
  const pad = Math.round(glyph * 0.6)
  const fit = Math.min((MAX_W - 2 * pad) / w, Math.sqrt(MAX_PIXELS / ((w + 2 * pad) * (h + 2 * pad))))
  const scale = Math.min(glyph / glyphSize(strokes), fit)
  return {
    width: Math.round(w * scale + 2 * pad),
    height: Math.round(h * scale + 2 * pad),
    lineWidth: Math.max(2, glyph * 0.09),
    map: (x, y) => [(x - x0) * scale + pad, (y - y0) * scale + pad]
  }
}

// ---- Cleaning up the model's output.
// The model writes CROHME-style LaTeX: function names as spaced single letters ("l o g"), primes as
// ^{\prime}, and sometimes a pointless \begin{matrix} around a short expression.
const OPERATORS: [string, string][] = [
  ['argmax', '\\arg \\max'], ['argmin', '\\arg \\min'], ['log', '\\log'], ['ln', '\\ln'], ['exp', '\\exp'],
  ['max', '\\max'], ['min', '\\min'], ['sup', '\\sup'], ['inf', '\\inf'], ['lim', '\\lim'], ['det', '\\det'],
  ['sin', '\\sin'], ['cos', '\\cos'], ['tan', '\\tan'], ['tanh', '\\tanh'], ['arg', '\\arg'],
  ['softmax', '\\operatorname{softmax}'], ['Attention', '\\operatorname{Attention}'], ['Normal', '\\operatorname{Normal}'],
  ['ELU', '\\operatorname{ELU}'], ['ReLU', '\\operatorname{ReLU}'], ['clip', '\\operatorname{clip}'],
  ['sim', '\\operatorname{sim}'], ['Var', '\\operatorname{Var}'], ['Cov', '\\operatorname{Cov}']
]
const BY_LENGTH = [...OPERATORS].sort((a, b) => b[0].length - a[0].length)

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** Operator names inside one run of single letters ("s o t t i m a x" → \operatorname{softmax}). */
function joinRun(letters: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < letters.length) {
    let hit: [number, string] | null = null
    for (const [name, tex] of BY_LENGTH) {
      if (letters.slice(i, i + name.length).join('') === name) { hit = [name.length, tex]; break }
    }
    if (!hit) {
      // Misspelled long names, within two edits.
      outer: for (const [name, tex] of BY_LENGTH) {
        if (name.length < 6) continue
        for (const len of [name.length + 1, name.length, name.length - 1, name.length + 2]) {
          const w = letters.slice(i, i + len).join('')
          if (w.length === len && editDistance(w.toLowerCase(), name.toLowerCase()) <= 2) { hit = [len, tex]; break outer }
        }
      }
    }
    if (hit) { out.push(hit[1]); i += hit[0] } else out.push(letters[i++])
  }
  // Trust it only if operators cover the run, give or take one variable ("l o g p" → \log p), so a
  // word like "s i m p l e" is not turned into \operatorname{sim} p l e.
  return out.filter((x) => /^[A-Za-z]$/.test(x)).length > 1 ? letters : out
}

/** Cleans the model's LaTeX. On 136 lab samples this fixed 11 of 42 wrong readings and broke none. */
export function cleanMathLatex(raw: string): string {
  let t = raw.trim()
    .replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    .replace(/^\$+|\$+$/g, '').replace(/^\\\[|\\\]$/g, '').trim()
  t = t.replace(/^\\begin\s*\{matrix\}([\s\S]*)\\end\s*\{matrix\}$/, (m, body: string) => (/&|\\\\/.test(body) ? m : body.trim()))
  t = t.replace(/\^\s*\{\s*((?:\\prime\s*)+)\}/g, (_m, p: string) => "'".repeat((p.match(/\\prime/g) ?? []).length))
    .replace(/\^\s*\\prime\b/g, "'")
  t = t.replace(/\(\s*m\s+o\s+d\s+([^()]+?)\s*\)/g, (_m, x: string) => `\\pmod{${x.trim()}}`)
  const toks = t.split(/\s+/)
  const out: string[] = []
  for (let i = 0; i < toks.length;) {
    if (/^[A-Za-z]$/.test(toks[i])) {
      let j = i
      while (j < toks.length && /^[A-Za-z]$/.test(toks[j])) j++
      out.push(...joinRun(toks.slice(i, j)))
      i = j
    } else out.push(toks[i++])
  }
  return out.join(' ')
}

/** Note text for a maths reading: the LaTeX as $…$, which notes already render as typeset maths. */
export function mathNoteText(latex: string): string {
  const one = latex.replace(/\s*\n\s*/g, ' ').replace(/\$/g, '\\$').trim()
  return one ? `$${one}$` : ''
}

/** The recognizer name shown for a maths reading, and how a note is known to be in maths mode. */
export const MATH_ENGINE = 'math'
export const MATH_RECOGNIZER = 'Maths (Uni-MuMER, local)'

// ---- Two readings → certain parts and uncertain spans.
// The same ink is read at two image sizes. Where both agree the reading was right 85% of the time in
// the lab (136 samples); where they differ the first reading was wrong 27 times out of 29. So the
// differing spans are marked uncertain and the second reading's version is offered as an alternative.

/** A second, slightly larger render for the confirming reading. */
export const MATH_GLYPH_PX_CHECK = 24

export const tokens = (latex: string): string[] => latex.split(/\s+/).filter(Boolean)

/** Lines up two token lists (longest common subsequence) into shared and differing spans. */
export function combineReadings(first: string, second: string): MathSegment[] {
  const a = tokens(first), b = tokens(second)
  const n = a.length, m = b.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: MathSegment[] = []
  let i = 0, j = 0
  const flush = (aSpan: string[], bSpan: string[]) => {
    if (aSpan.length || bSpan.length) out.push({ tex: aSpan.join(' '), alts: [bSpan.join(' ')], why: 'readings' })
  }
  let da: string[] = [], db: string[] = []
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush(da, db); da = []; db = []
      out.push({ tex: a[i] }); i++; j++
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) da.push(a[i++])
    else db.push(b[j++])
  }
  flush(da, db)
  return out
}

export const segmentsLatex = (segs: MathSegment[]): string => segs.map((s) => s.tex).filter(Boolean).join(' ')
export const uncertainCount = (segs: MathSegment[]): number => segs.filter((s) => s.why === 'readings').length

/** Swaps a segment's text with one of its alternatives; the old text becomes an alternative. */
export function pickAlternative(segs: MathSegment[], index: number, alt: string): MathSegment[] {
  return segs.map((s, k) => (k !== index ? s : { ...s, tex: alt, alts: [s.tex, ...(s.alts ?? []).filter((x) => x !== alt)], picked: true }))
}

// ---- Symbols the paper itself uses, offered as suggestions (never applied on their own).
// The model never writes \mathbb, \mathcal or bold, and reads Θ/θ, Φ/φ by shape only. A PDF made
// with TeX names its fonts (MSBM = blackboard, CMSY capitals = calligraphic, CMBX/CMMIB = bold), so the
// paper tells which styled letters and which Greek case it uses. A plain letter you wrote may be
// meant as plain, so these only become alternatives to tap.

export type SymbolStyle = 'mathbb' | 'mathcal' | 'mathbf' | 'boldsymbol' | 'mathfrak' | 'mathscr'

/** Counts of styled letters, keyed by LaTeX of the plain symbol ("E", "\\theta"), and of Greek letters by case. */
export interface PaperSymbols {
  styled: Record<string, Partial<Record<SymbolStyle, number>>>
  greek: Record<string, number>
}

export function emptyPaperSymbols(): PaperSymbols {
  return { styled: {}, greek: {} }
}

/** The style a TeX font gives to letters, from its PDF name such as "RAZVEJ+MSBM10". */
export function fontStyle(fontName: string): SymbolStyle | null {
  const n = fontName.replace(/^[A-Z]+\+/, '').toUpperCase()
  if (/^(MSBM|BBM|DSROM|BBOLD|STIXDOUBLESTRUCK)/.test(n)) return 'mathbb'
  if (/^(CMSY|EUSM|EUSB|MATHCAL)/.test(n)) return 'mathcal'
  if (/^(RSFS|MATHSCR)/.test(n)) return 'mathscr'
  if (/^(EUFM|EUFB)/.test(n)) return 'mathfrak'
  if (/^CMMIB/.test(n)) return 'boldsymbol'
  if (/^CMBX/.test(n)) return 'mathbf'
  return null
}

const GREEK_NAMES: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota',
  κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi',
  ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi',
  Σ: 'Sigma', Υ: 'Upsilon', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega'
}
const UNICODE_STYLED: Record<string, [string, SymbolStyle]> = {
  '𝔼': ['E', 'mathbb'], 'ℝ': ['R', 'mathbb'], 'ℕ': ['N', 'mathbb'], 'ℤ': ['Z', 'mathbb'], 'ℚ': ['Q', 'mathbb'], 'ℂ': ['C', 'mathbb'],
  'ℙ': ['P', 'mathbb'], 'ℒ': ['L', 'mathcal'], 'ℰ': ['E', 'mathcal'], 'ℱ': ['F', 'mathcal'], 'ℋ': ['H', 'mathcal'], 'ℐ': ['I', 'mathcal'],
  'ℛ': ['R', 'mathcal'], 'ℬ': ['B', 'mathcal'], 'ℳ': ['M', 'mathcal']
}

/** Adds one text run of the PDF (its characters and font name) to the paper's symbol counts. */
export function addPaperText(into: PaperSymbols, str: string, fontName: string): void {
  const style = fontStyle(fontName)
  for (const ch of str) {
    const u = UNICODE_STYLED[ch]
    if (u) { bump(into, u[0], u[1]); continue }
    const plain = ch.normalize('NFKC')
    const greek = GREEK_NAMES[plain]
    if (greek) {
      into.greek[greek] = (into.greek[greek] ?? 0) + 1
      if (style === 'boldsymbol') bump(into, `\\${greek}`, 'boldsymbol')
      continue
    }
    if (!style || !/^[A-Za-z]$/.test(plain)) continue
    // CMSY draws calligraphic capitals only; its other glyphs are operators.
    if (style === 'mathcal' && !/^[A-Z]$/.test(plain)) continue
    bump(into, plain, style)
  }
}
function bump(into: PaperSymbols, key: string, style: SymbolStyle): void {
  const s = (into.styled[key] ??= {})
  s[style] = (s[style] ?? 0) + 1
}

const styledTex = (style: SymbolStyle, base: string) => `\\${style}{${base}}`
const isGreekCmd = (t: string) => /^\\[A-Za-z]+$/.test(t) && Object.values(GREEK_NAMES).includes(t.slice(1))
const swapCase = (name: string) => (name[0] === name[0].toUpperCase() ? name[0].toLowerCase() : name[0].toUpperCase()) + name.slice(1)

/**
 * Alternatives the paper suggests for one token: styled versions of a plain letter the paper writes
 * styled, and the other case of a Greek letter the paper uses only (or mostly) in that other case.
 * `chosen` counts styled forms already in your other maths notes on this paper, which come first.
 */
export function paperAlternatives(token: string, paper: PaperSymbols, chosen: Record<string, number> = {}, minCount = 2): string[] {
  const out: [string, number][] = []
  if (/^[A-Za-z]$/.test(token) || isGreekCmd(token)) {
    for (const [style, n] of Object.entries(paper.styled[token] ?? {}) as [SymbolStyle, number][]) {
      // Bold is left out: papers set every vector in bold, and nobody marks bold by hand, so it would
      // put a suggestion on nearly every x (VAE paper: 23 of 29 unwanted suggestions were bold).
      if (style === 'mathbf' || style === 'boldsymbol') continue
      if (n >= minCount) out.push([styledTex(style, token), n])
    }
  }
  if (isGreekCmd(token)) {
    const name = token.slice(1), other = swapCase(name)
    if (other !== name && GREEK_IN_BOTH_CASES.has(name.toLowerCase())) {
      const mine = paper.greek[name] ?? 0, theirs = paper.greek[other] ?? 0
      if (theirs >= minCount && theirs > mine) out.push([`\\${other}`, theirs])
    }
  }
  return out
    .sort((x, y) => (chosen[y[0]] ?? 0) - (chosen[x[0]] ?? 0) || y[1] - x[1])
    .map(([t]) => t)
}
// Greek letters whose capital differs from a Latin letter (Θ, Φ, …), so a case swap is meaningful.
const GREEK_IN_BOTH_CASES = new Set(['gamma', 'delta', 'theta', 'lambda', 'xi', 'pi', 'sigma', 'upsilon', 'phi', 'psi', 'omega'])

/** Adds the paper's suggestions as alternatives to the matching tokens. Nothing is replaced. */
export function addPaperSuggestions(segs: MathSegment[], paper: PaperSymbols | null, chosen: Record<string, number> = {}): MathSegment[] {
  if (!paper) return segs
  return segs.map((s) => {
    const tok = s.tex.trim()
    if (!tok || tok.includes(' ')) return s
    const alts = paperAlternatives(tok, paper, chosen).filter((a) => a !== tok && !(s.alts ?? []).includes(a))
    if (!alts.length) return s
    return { ...s, alts: [...(s.alts ?? []), ...alts], why: s.why ?? 'paper' }
  })
}

/** Styled symbols (\mathbb{E}, \Theta …) in maths you already wrote, to rank the paper's suggestions. */
export function chosenSymbols(texts: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of texts) {
    for (const m of t.matchAll(/\\(?:mathbb|mathcal|mathbf|boldsymbol|mathfrak|mathscr)\s*\{\s*\\?[A-Za-z]+\s*\}|\\[A-Z][a-z]+/g)) {
      const k = m[0].replace(/\s+/g, '')
      out[k] = (out[k] ?? 0) + 1
    }
  }
  return out
}

// ---- Several written lines (a derivation) → one image per line, joined as aligned maths.

interface Box { i: number; x0: number; y0: number; x1: number; y1: number }

/**
 * Splits maths ink into written lines, top to bottom, as lists of stroke indices. A line break is an
 * empty horizontal band at least half a glyph tall. A band next to a long flat stroke (a fraction bar)
 * is not a line break, since numerator and denominator are not separate lines.
 */
export function splitMathLines(strokes: readonly (readonly Point[])[]): number[][] {
  const boxes: Box[] = []
  strokes.forEach((s, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
    if (Number.isFinite(x0)) boxes.push({ i, x0, y0, x1, y1 })
  })
  if (boxes.length < 2) return [boxes.map((b) => b.i)]
  const glyph = glyphSize(strokes)
  // Bands of strokes that overlap vertically.
  const sorted = [...boxes].sort((p, q) => p.y0 - q.y0)
  const bands: Box[][] = []
  let cur: Box[] = [sorted[0]], bottom = sorted[0].y1
  for (const b of sorted.slice(1)) {
    if (b.y0 - bottom >= glyph * 0.5) { bands.push(cur); cur = [b]; bottom = b.y1 }
    else { cur.push(b); bottom = Math.max(bottom, b.y1) }
  }
  bands.push(cur)
  if (bands.length === 1) return [boxes.map((b) => b.i)]
  const allX0 = Math.min(...boxes.map((b) => b.x0)), allX1 = Math.max(...boxes.map((b) => b.x1))
  const width = Math.max(allX1 - allX0, 1)
  const isBar = (b: Box) => b.x1 - b.x0 >= glyph * 1.2 && (b.y1 - b.y0) <= (b.x1 - b.x0) * 0.35
  const top = (band: Box[]) => Math.min(...band.map((b) => b.y0))
  const bot = (band: Box[]) => Math.max(...band.map((b) => b.y1))
  const spanX = (band: Box[]) => Math.max(...band.map((b) => b.x1)) - Math.min(...band.map((b) => b.x0))
  // A written line has full-size symbols and some width; limits and scripts are small, and a
  // numerator or denominator sits next to a fraction bar.
  const wide = (band: Box[]) => spanX(band) >= width * 0.08 && bot(band) - top(band) >= glyph * 0.9
  const x0of = (band: Box[]) => Math.min(...band.map((b) => b.x0))
  const x1of = (band: Box[]) => Math.max(...band.map((b) => b.x1))
  const lines: Box[][] = [bands[0]]
  for (const band of bands.slice(1)) {
    const prev = lines[lines.length - 1]
    const gap = top(band) - bot(prev)
    // A fraction bar is about as wide as what it divides; the "=" starting a derivation line is not.
    const barNear = prev.some((b) => isBar(b) && bot(prev) - b.y1 <= glyph * 0.6 && b.x1 - b.x0 >= spanX(band) * 0.6) ||
      band.some((b) => isBar(b) && b.y0 - top(band) <= glyph * 0.6 && b.x1 - b.x0 >= spanX(prev) * 0.6)
    // Limits under a tall ∑, ∏ or ∫: the band's middle sits below an operator, i.e. strokes over two
    // glyphs tall standing close together (a handwritten ∏ is a bar and two legs).
    const mid = (x0of(band) + x1of(band)) / 2
    const tall = prev.filter((b) => b.y1 - b.y0 >= glyph * 2).sort((p, q) => p.x0 - q.x0)
    const ops: [number, number][] = []
    for (const b of tall) {
      const last = ops[ops.length - 1]
      if (last && b.x0 - last[1] < glyph * 2.5) last[1] = Math.max(last[1], b.x1)
      else ops.push([b.x0, b.x1])
    }
    const underOperator = ops.some(([a, c]) => a - glyph * 0.5 <= mid && mid <= c + glyph * 0.5)
    if (gap < glyph * 0.6 || barNear || underOperator || !wide(prev) || !wide(band)) prev.push(...band)
    else lines.push(band)
  }
  // Within a line, strokes stay in the order written.
  return lines.map((l) => l.map((b) => b.i).sort((p, q) => p - q))
}

const RELATIONS = new Set(['=', '\\leq', '\\geq', '<', '>', '\\approx', '\\equiv', '\\triangleq', '\\le', '\\ge', '\\neq', '\\sim', '\\propto'])

/** Joins per-line LaTeX into one aligned block, aligned at each line's first relation. */
export function joinMathLines(lines: string[]): string {
  const kept = lines.map((l) => l.trim()).filter(Boolean)
  if (kept.length <= 1) return kept[0] ?? ''
  const withAmp = kept.map((line) => {
    const toks = tokens(line)
    let depth = 0
    for (let k = 0; k < toks.length; k++) {
      depth += (toks[k].match(/\{/g) ?? []).length - (toks[k].match(/\}/g) ?? []).length
      if (depth === 0 && RELATIONS.has(toks[k])) return [...toks.slice(0, k), '&', ...toks.slice(k)].join(' ')
    }
    return null
  })
  if (withAmp.every((l) => l !== null)) return `\\begin{aligned} ${withAmp.join(' \\\\ ')} \\end{aligned}`
  return `\\begin{gathered} ${kept.join(' \\\\ ')} \\end{gathered}`
}

/** Line-break segment used between lines of a multi-line maths reading. */
export const LINE_BREAK: MathSegment = { tex: '\\\\', line: true }

/** Segments of several lines → the LaTeX of the whole note (aligned when more than one line). */
export function segmentsToLatex(segs: MathSegment[]): string {
  const lines: string[][] = [[]]
  for (const s of segs) {
    if (s.line) lines.push([])
    else if (s.tex) lines[lines.length - 1].push(s.tex)
  }
  return joinMathLines(lines.map((l) => l.join(' ')))
}
