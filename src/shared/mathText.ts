import type { Word } from './pageText'

/**
 * Rebuilds maths notation from where a PDF puts each symbol. A PDF holds no LaTeX, only symbols
 * with their positions and sizes, so the structure is read back from the layout:
 * - a smaller symbol just after another, lower or higher, is a subscript or superscript;
 * - rows stacked above and below the maths axis, side by side with nothing on the main line, are a fraction;
 * - small rows above and below a ∑, ∏ or ∫ are its limits;
 * - "¯" over a letter is a bar; the control characters of TeX's big-delimiter font are big brackets.
 * Anything it cannot place is kept in reading order, so the result degrades rather than fails.
 */

interface Glyph {
  text: string
  x0: number
  x1: number
  base: number
  size: number
  bar?: boolean
}

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'vartheta',
  ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ϖ: 'varpi', ρ: 'rho', ϱ: 'varrho', σ: 'sigma',
  ς: 'varsigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
  Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma', Υ: 'Upsilon', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega'
}

const SYMBOLS: Record<string, string> = {
  '−': '-', '∗': '*', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '÷': '\\div', '±': '\\pm', '∓': '\\mp',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '≃': '\\simeq', '∝': '\\propto',
  '≪': '\\ll', '≫': '\\gg', '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊆': '\\subseteq', '⊃': '\\supset',
  '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla',
  '∀': '\\forall', '∃': '\\exists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee', '→': '\\to', '←': '\\leftarrow',
  '↦': '\\mapsto', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↔': '\\leftrightarrow',
  '∘': '\\circ', '⊙': '\\odot', '⊗': '\\otimes', '⊕': '\\oplus', '†': '\\dagger', '′': "'", '″': "''", '…': '\\ldots',
  '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '‖': '\\|', '∥': '\\|', '⟨': '\\langle', '⟩': '\\rangle', '√': '\\sqrt{}',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '{': '\\{', '}': '\\}',
  '%': '\\%', '#': '\\#', '&': '\\&', '$': '\\$', '_': '\\_', '^': '\\hat{}', '~': '\\sim', 'ℓ': '\\ell', 'ℝ': '\\mathbb{R}',
  'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', '𝔼': '\\mathbb{E}', '⊤': '\\top', '⊥': '\\bot'
}

/** TeX's big-delimiter font (cmex) puts its brackets on control characters. */
const CMEX: Record<number, [string, 'open' | 'close' | 'mid']> = {
  0x00: ['(', 'open'], 0x01: [')', 'close'], 0x02: ['[', 'open'], 0x03: [']', 'close'], 0x04: ['\\lfloor', 'open'],
  0x05: ['\\rfloor', 'close'], 0x06: ['\\lceil', 'open'], 0x07: ['\\rceil', 'close'], 0x08: ['\\{', 'open'],
  0x09: ['\\}', 'close'], 0x0a: ['\\langle', 'open'], 0x0b: ['\\rangle', 'close'], 0x0c: ['|', 'mid'], 0x0d: ['\\|', 'mid'],
  0x10: ['(', 'open'], 0x11: [')', 'close'], 0x12: ['(', 'open'], 0x13: [')', 'close'], 0x14: ['[', 'open'],
  0x15: [']', 'close'], 0x16: ['\\lfloor', 'open'], 0x17: ['\\rfloor', 'close'], 0x18: ['\\lceil', 'open'],
  0x19: ['\\rceil', 'close'], 0x1a: ['\\{', 'open'], 0x1b: ['\\}', 'close'], 0x1c: ['\\langle', 'open'], 0x1d: ['\\rangle', 'close'],
  0x20: ['(', 'open'], 0x21: [')', 'close'], 0x22: ['[', 'open'], 0x23: [']', 'close']
}

const BIG_OPERATOR = /^[∑∏∫∮⋃⋂]$/
const BAR = /^[¯‾ˉ̄̅]$/

/** Drops variation selectors and the like, which some PDFs attach to symbols. */
function clean(text: string): string {
  return text.replace(/[︀-️​-‍]/g, '')
}

function delimiter(text: string): [string, 'open' | 'close' | 'mid'] | undefined {
  const t = clean(text)
  if (t.length !== 1) return undefined
  const code = t.codePointAt(0) ?? 0
  return code < 0x24 && code !== 0x20 ? CMEX[code] : undefined
}

/** One character as LaTeX: math letters become plain letters, Greek and symbols become commands. */
function texChar(ch: string): string {
  if (SYMBOLS[ch]) return SYMBOLS[ch]
  // Math italic and bold letters (𝑥, 𝐸, 𝛼…) fold to the plain letter or Greek letter they stand for.
  const plain = ch.normalize('NFKC')
  if (GREEK[plain]) return `\\${GREEK[plain]}`
  if (SYMBOLS[plain]) return SYMBOLS[plain]
  if (/^[\x21-\x7e]$/.test(plain)) return plain
  if (/^\p{L}$/u.test(plain)) return plain
  if (/[\u0000-\u001f-]/.test(ch)) return ''
  return plain
}

function texText(text: string): string {
  const parts = [...clean(text)].map(texChar)
  // A command followed by a letter needs a space between them.
  return parts.reduce((out, p) => (out && /\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(p) ? `${out} ${p}` : out + p), '')
}

function glyphsOf(words: Word[]): Glyph[] {
  return words
    .map((w) => ({ text: clean(w.text), x0: w.rect[0], x1: w.rect[0] + w.rect[2], base: w.rect[1] + w.rect[3] * 0.8, size: w.rect[3] }))
    .filter((g) => g.text.trim() !== '')
}

const overlap = (a: Glyph, b: Glyph): number => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)

/** The size and baseline of the main line: the most common baseline among the largest symbols. */
function mainLine(gs: Glyph[]): { size: number; base: number } {
  const plain = gs.filter((g) => !delimiter(g.text) && !BIG_OPERATOR.test(g.text) && !BAR.test(g.text))
  const pool = plain.length ? plain : gs
  const size = Math.max(...pool.map((g) => g.size))
  const votes = new Map<number, number>()
  for (const g of pool.filter((x) => x.size >= size * 0.85)) {
    const key = Math.round(g.base * 2) / 2
    votes.set(key, (votes.get(key) ?? 0) + Math.max(1, g.x1 - g.x0))
  }
  let base = pool[0].base
  let best = -1
  for (const [k, v] of votes) if (v > best) { best = v; base = k }
  return { size, base }
}

/** Groups symbols into rows by baseline. */
function rows(gs: Glyph[], tolerance: number): Glyph[][] {
  const out: Glyph[][] = []
  for (const g of [...gs].sort((a, b) => a.base - b.base)) {
    const row = out.find((r) => Math.abs(r[0].base - g.base) <= tolerance)
    if (row) row.push(g)
    else out.push([g])
  }
  return out
}

/** A selection that is just a numerator over a denominator, like (n − k)/(N − k) circled on its own. */
function bareFraction(gs: Glyph[]): [Glyph[], Glyph[]] | null {
  const size = Math.max(...gs.map((g) => g.size))
  const rs = rows(gs.filter((g) => !BAR.test(g.text)), size * 0.3)
  if (rs.length !== 2) return null
  const [top, bottom] = rs
  const span = (r: Glyph[]) => [Math.min(...r.map((g) => g.x0)), Math.max(...r.map((g) => g.x1))]
  const [a0, a1] = span(top)
  const [b0, b1] = span(bottom)
  const shared = Math.min(a1, b1) - Math.max(a0, b0)
  const gap = bottom[0].base - top[0].base
  if (shared < 0.5 * Math.min(a1 - a0, b1 - b0) || gap < size * 0.9 || gap > size * 2.6) return null
  const bars = gs.filter((g) => BAR.test(g.text))
  const inRow = (r: Glyph[]) => bars.filter((b) => r.some((g) => overlap(b, g) > 0 && Math.abs(b.base - g.base) < size))
  return [[...top, ...inRow(top)], [...bottom, ...inRow(bottom)]]
}

function parse(input: Glyph[]): string {
  if (input.length === 0) return ''
  const pair = bareFraction(input)
  if (pair) return `\\frac{${parse(pair[0])}}{${parse(pair[1])}}`

  // A bar belongs to the letter under it.
  const barred = new Set<Glyph>()
  const gs = input.filter((g) => !BAR.test(g.text))
  for (const b of input.filter((g) => BAR.test(g.text))) {
    const under = gs.filter((g) => overlap(b, g) > 0).sort((p, q) => overlap(b, q) - overlap(b, p))[0]
    if (under) barred.add(under)
  }
  if (gs.length === 0) return ''

  const { size: m, base: main } = mainLine(gs)
  const axis = main - 0.25 * m
  const isDelim = (g: Glyph) => !!delimiter(g.text)
  const isOp = (g: Glyph) => BIG_OPERATOR.test(g.text)
  const onMain = (g: Glyph) => g.size >= 0.85 * m && Math.abs(g.base - main) <= 0.15 * m
  const centre = (g: Glyph) => g.base - 0.3 * g.size
  const sameRow = (a: Glyph, b: Glyph) => Math.abs(a.base - b.base) <= 0.2 * Math.max(a.size, b.size)
  const gapBetween = (a: Glyph, b: Glyph) => Math.max(a.x0 - b.x1, b.x0 - a.x1)

  // Stacks: a big operator with its limits, or a fraction. They grow over symbols off the main
  // line that overlap them, or sit on the same row right next to one of their symbols.
  const used = new Set<Glyph>()
  const units: { x0: number; tex: string }[] = []
  const seeds = gs.filter((g) => isOp(g) || (!onMain(g) && !isDelim(g) && g.size >= 0.85 * m))
  for (const seed of [...seeds].sort((a, b) => Number(isOp(b)) - Number(isOp(a)) || a.x0 - b.x0)) {
    if (used.has(seed)) continue
    const stack = [seed]
    for (let grew = true; grew;) {
      grew = false
      for (const g of gs) {
        if (stack.includes(g) || used.has(g) || onMain(g) || isDelim(g) || (isOp(g) && !isOp(seed))) continue
        if (stack.some((s) => overlap(g, s) > 0.5 || (sameRow(g, s) && gapBetween(g, s) <= 0.8 * m))) {
          stack.push(g)
          grew = true
        }
      }
    }
    const op = stack.find(isOp)
    if (op) {
      const above = stack.filter((g) => g !== op && g.base < main - 0.5 * m)
      const below = stack.filter((g) => g !== op && g.base > main + 0.5 * m)
      const lower = below.length ? `_{${parse(below)}}` : ''
      const upper = above.length ? `^{${parse(above)}}` : ''
      for (const g of [op, ...above, ...below]) used.add(g)
      units.push({ x0: Math.min(...[op, ...above, ...below].map((g) => g.x0)), tex: `${texText(op.text)}${lower}${upper}` })
      continue
    }
    const top = stack.filter((g) => centre(g) < axis)
    const bottom = stack.filter((g) => centre(g) >= axis)
    if (top.length && bottom.length) {
      for (const g of stack) used.add(g)
      const withBars = (r: Glyph[]) => [...r, ...input.filter((b) => BAR.test(b.text) && r.some((g) => barred.has(g) && overlap(b, g) > 0))]
      units.push({ x0: Math.min(...stack.map((g) => g.x0)), tex: `\\frac{${parse(withBars(top))}}{${parse(withBars(bottom))}}` })
    }
  }

  // Everything else reads left to right, each symbol taking the smaller symbols right after it
  // as its subscript or superscript.
  const rest = gs.filter((g) => !used.has(g)).sort((a, b) => a.x0 - b.x0)
  const atom = (g: Glyph): string => {
    const d = delimiter(g.text)
    if (d) return d[1] === 'open' ? `\\left${d[0]}` : d[1] === 'close' ? `\\right${d[0]}` : d[0]
    const t = texText(g.text)
    return barred.has(g) ? `\\bar{${t}}` : t
  }
  const isScript = (g: Glyph) => !onMain(g) && g.size < 0.85 * m && !isDelim(g)
  for (let i = 0; i < rest.length; i++) {
    const g = rest[i]
    let tex = atom(g)
    const subs: Glyph[] = []
    const sups: Glyph[] = []
    let end = g.x1
    while (i + 1 < rest.length && isScript(rest[i + 1]) && !isScript(g) && rest[i + 1].x0 <= end + 0.6 * m) {
      const s = rest[++i]
      ;(s.base > main + 0.05 * m ? subs : sups).push(s)
      end = Math.max(end, s.x1)
    }
    if (subs.length) tex += `_{${parse(subs)}}`
    if (sups.length) tex += `^{${parse(sups)}}`
    units.push({ x0: g.x0, tex })
  }
  const ordered = units.sort((a, b) => a.x0 - b.x0).map((u) => u.tex).filter(Boolean)
  // A root sign takes what follows it. Its overline is not text, so only the next symbol is sure.
  const out: string[] = []
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].startsWith('\\sqrt{}') && i + 1 < ordered.length) {
      out.push(`\\sqrt{${ordered[i + 1]}}${ordered[i].slice('\\sqrt{}'.length)}`)
      i++
    } else out.push(ordered[i])
  }
  return out.join(' ')
}

/** Keeps \left and \right only when they pair up, since KaTeX rejects an unpaired one. */
function balance(tex: string): string {
  let depth = 0
  for (const m of tex.matchAll(/\\(left|right)/g)) {
    depth += m[1] === 'left' ? 1 : -1
    if (depth < 0) break
  }
  return depth === 0 ? tex : tex.replace(/\\(left|right)(?=[(\[|.]|\\[a-zA-Z{}|]|\))/g, '')
}

/** LaTeX for circled maths. */
export function wordsToLatex(words: Word[]): string {
  return balance(parse(glyphsOf(words)).replace(/\s+/g, ' ').trim())
}

const STRONG = /[=+−×·÷∑∏∫∂∇√∞≤≥≈≠≡∝∈∉⊂⊆⊃∪∩∀∃→←↦⇒⇔^_|‖⟨⟩{}[\]Ͱ-Ͽ∀-⋿⟀-⟯⦀-⫿\u0000-\u001f]|[\u{1d400}-\u{1d7ff}]/u
const NEUTRAL = /^[\d.,;:()=+\-−'’/]+$/

/**
 * Quoted text with its maths written as $LaTeX$, so "[xᵢ] of the motion" reads as
 * "$[x_{i}]_{i \geq N - k}$ of the motion" instead of loose symbols.
 */
export function readableText(words: Word[]): string {
  if (words.length === 0) return ''
  const sizes = words.map((w) => w.rect[3]).sort((a, b) => a - b)
  const usual = sizes[Math.floor(sizes.length / 2)]
  const kind = (w: Word): 'math' | 'neutral' | 'prose' => {
    const t = clean(w.text)
    if (STRONG.test(t)) return 'math'
    if (w.rect[3] < usual * 0.85) return 'math'
    if (/^[A-Za-z]$/.test(t) && !/^[aAI]$/.test(t)) return 'math'
    return NEUTRAL.test(t) ? 'neutral' : 'prose'
  }
  const kinds = words.map(kind)
  const out: string[] = []
  for (let i = 0; i < words.length;) {
    if (kinds[i] === 'prose') {
      out.push(clean(words[i].text))
      i++
      continue
    }
    let j = i
    while (j < words.length && kinds[j] !== 'prose') j++
    // Sentence punctuation after the maths stays outside it.
    let run = words.slice(i, j)
    let tail = ''
    const last = run[run.length - 1]
    if (last && /[.,;:]$/.test(last.text) && kinds[j - 1] !== 'math') {
      tail = last.text
      run = run.slice(0, -1)
    }
    if (run.some((w) => kind(w) === 'math')) out.push(`$${wordsToLatex(run)}$${tail}`)
    else out.push(...run.map((w) => clean(w.text)), ...(tail ? [tail] : []))
    i = j
  }
  return out.join(' ').replace(/\s+([.,;:])/g, '$1')
}

/** Whether a string holds $…$ maths. */
export function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}
