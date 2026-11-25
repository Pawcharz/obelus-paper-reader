/**
 * Notes that mix text and maths ("the bound $\ln p(x) \geq \mathcal{L}$ is tight"). The note is read
 * as text first; Windows Ink reports each word with its box, so every word is matched to its strokes
 * and labelled text or maths. Adjacent maths words become one maths span, which the maths model reads.
 *
 * Word labels come from three signals, kept conservative so ordinary notes stay text:
 * - the reading: a real word (spell checker or the paper's words) is text; symbols, digits and
 *   brackets in a non-word point to maths ("(0+15=)", "Q1:T"); a single letter other than a
 *   one-letter word ("a", "I", Polish "w") is a variable; "sin", "log", "exp" are maths names;
 * - the ink: scripts above or below the line, a stroke far taller than the letters (brackets, ∫, ∏),
 *   a fraction bar with ink above and below it;
 * - neighbours: a doubtful word between two maths words is maths too; a relation sign takes in what
 *   it relates, a maths name what it applies to, unless those are real words.
 * Then a dash, "?" or "," read into a formula ("F=ma-Explain") goes back to the text.
 * Measured on synthetic mixed notes built from one writer's ink (tests/real/mixedSynthetic.test.ts).
 */
import { boxOf, clusterBox, splitLines } from './inkLogic'
import { glyphSize } from './mathInk'
import type { NotePiece, RecognizedWord, Stroke } from './types'

export type WordKind = 'text' | 'math'

export interface WordJudgement {
  word: RecognizedWord
  strokeIds: string[]
  score: number
  kind: WordKind
  /** Why, for logs and tests. */
  signals: string[]
  /**
   * The split is not sure about this word: its score is within 1 of the threshold (inclusive), or a context rule
   * (neighbours, a function name) overruled what the word itself looked like. Your choices are sure.
   */
  unsure?: boolean
}

/** Score at or above which a word counts as maths. */
export const MATH_THRESHOLD = 1.5
// Maths symbols. Digits are not: numbers and names like "A3C" or "V3" are common in plain notes.
const SYMBOLS = /[=+*^_|[\]{}<>~≤≥≠∑∫√∂∞∈∇·×]/g
/** Letters joined by hyphens, slashes or apostrophes: "model-based", "random/stochastic", "don't". */
const JOINED_LETTERS = /^\p{L}+(?:[-–/'’.]\p{L}+)*$/u
/** Text punctuation, bullets and arrows written on their own: "-", "/", "...", "->". */
const TEXT_PUNCTUATION = /^(?:[-–—/.,:;!?…'"()•*]+|->|=>|<-|→)$/
/** Names of maths functions, which spell checkers take for words ("sin", "log", "tan", "exp"). */
const MATH_NAMES = new Set(['sin', 'cos', 'tan', 'cot', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'argmax', 'argmin', 'sup', 'inf', 'tanh', 'softmax'])
/**
 * Common short words, English and Polish. A maths function's name before one of them is a word
 * misread ("So far it" read as "So tan it"); before a rarer short word it is applied: "tan Li" (α_i).
 */
const COMMON_SHORT = new Set(['it', 'is', 'in', 'on', 'of', 'to', 'be', 'as', 'at', 'by', 'we', 'an', 'or', 'so', 'no', 'do', 'if', 'up', 'my', 'me', 'he', 'us', 'am',
  'na', 'po', 'za', 'od', 'ze', 'co', 'bo', 'go', 'mu', 'mi', 'ja', 'ty', 'tu', 'je', 'nie', 'jak', 'ale', 'czy', 'the', 'and', 'are', 'for', 'not', 'but', 'can', 'has', 'was'])
/** Letters that are words on their own (English "a", "I"; Polish "i", "o", "u", "w", "z"). Any other single letter is a variable. */
const ONE_LETTER_WORDS = /^[aAIioOuUwWzZ]$/
/** A relation sign written on its own between words. */
const RELATION = /^(?:[=<>≤≥≠~≈]|==|<=|>=)$/
/** Signals of the context rules: a word made maths by them, against its own looks, is asked about. */
const CONTEXT_SIGNALS = ['next to maths', 'function name before brackets', 'in a bracketed group', 'relation sign', 'beside a relation sign', 'applied to the next word', 'after a maths function']

/** How much the reading of one word looks like maths (negative: like text). */
export function readingScore(w: RecognizedWord): { score: number; signals: string[] } {
  const t = w.text.trim()
  if (!t) return { score: 0, signals: [] }
  const letters = (t.match(/\p{L}/gu) ?? []).length
  // Brackets and sentence punctuation around a word belong to the sentence: "(Wand", "M)", "stochastic,".
  const core = t.replace(/^[("'[\-–—•.]+/, '').replace(/[)"'\].,:;!?/]+$/, '')
  // A maths function's name: maths when something it applies to follows (judged in context).
  if (MATH_NAMES.has(core)) return { score: 1, signals: ['maths function name'] }
  // Its name glued to what it applies to: "sin?0", "log,8", "exp(-x".
  if (!w.real && /^(?:sin|cos|tan|log|ln|exp)[^\p{L}\s]/u.test(core)) return { score: 2, signals: ['maths function applied'] }
  // Two-letter real words ("pa", "in", "is") are weak evidence: "pd" written with a subscript can
  // read as Polish "pa". Longer real words are firmly text.
  if (w.real && letters === 2 && t.length === 2) return { score: -1.5, signals: ['short real word'] }
  if (w.real && letters >= 2) return { score: -3, signals: ['real word'] }
  if (TEXT_PUNCTUATION.test(t)) return { score: -1, signals: ['punctuation'] }
  // A lone digit or symbol between words ("det. + stoch.", "page 2") is text unless maths is next to it.
  if (t.length === 1 && !letters) return { score: /[=<>≤≥]/.test(t) ? 1 : 0.5, signals: ['lone symbol'] }
  // Names with digits ("A3C", "D4PG", "V3") and plain numbers ("200", "12") are text.
  if (/^[\p{L}\d]+$/u.test(core) && /\d/.test(core)) return { score: -1, signals: ['name or number'] }
  // A non-word closing a bracket it never opened: the "(" was read as a letter ("ln(x)" → "lncx)").
  if (!w.real && /\)$/.test(t) && !t.includes('(') && letters >= 3 && letters <= 6) {
    return { score: 2, signals: ['bracket closed but not opened'] }
  }
  if (core && JOINED_LETTERS.test(core)) {
    const n = (core.match(/\p{L}/gu) ?? []).length
    if (n >= 2) return { score: -1.5, signals: ['letters'] }
    // A single letter that is a word ("I", "a", Polish "w") leans to text and ignores its ink. Any
    // other letter is a variable ("x", "n", "f"): undecided, the neighbours and the ink tip it.
    if (ONE_LETTER_WORDS.test(core)) return { score: -0.5, signals: ['one-letter word'] }
    return { score: 0.5, signals: ['single letter'] }
  }
  const symbols = (t.match(SYMBOLS) ?? []).length
  const brackets = (t.match(/[()]/g) ?? []).length
  const signals: string[] = []
  let score = 0
  if (symbols) { score += 3 * (symbols / t.length); signals.push(`${symbols} symbol(s)`) }
  if (/[=<>≤≥≠^_|∑∫]/.test(t)) { score += 0.5; signals.push('relation or operator') }
  // Brackets around something that is not a plain word: "p(x)", "(0+15=)", "(+-1)".
  if (brackets && letters + brackets < t.length) { score += 0.5 + brackets / t.length; signals.push('brackets') }
  else if (brackets && /\(\p{L}{1,2}\)/u.test(t)) { score += 1; signals.push('function call') }
  // A short name applied to letters: "P(ANB)", "p(AIB" (a word in brackets starts with the bracket).
  else if (/^\p{L}{1,2}\(\p{L}/u.test(core)) { score += 1; signals.push('function applied') }
  if (/[+\-*/]/.test(t) && /[\d\p{L}][+\-*/][\d\p{L}]/u.test(t) && !JOINED_LETTERS.test(core)) { score += 0.8; signals.push('arithmetic') }
  // A short term: "x-7", "t+1", "2^3" (a letter or number on each side of the operator).
  if (/^(?:\p{L}|\d+)[-+*/^](?:\p{L}|\d+)$/u.test(core)) { score += 1; signals.push('short term') }
  // Index ranges inside a word: "o1:T", "a_{1:T}", "t:t+H" (a colon after a word is punctuation, cut above).
  if (/[\d\p{L}]:[\d\p{L}]/u.test(core) && /\d/.test(core)) { score += 0.5; signals.push('index range') }
  return { score, signals }
}

interface Item { id: string; x0: number; y0: number; x1: number; y1: number }

/** How much the ink of one word looks like maths, judged against its written line. */
export function inkScore(word: Item[], line: Item[], glyph: number, singleLetter = false): { score: number; signals: string[] } {
  if (word.length === 0) return { score: 0, signals: [] }
  const h = (b: Item) => b.y1 - b.y0, w = (b: Item) => b.x1 - b.x0
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  // Letter height from stroke heights, not widths: in joined-up writing one stroke is a whole word.
  const tallEnough = line.filter((b) => h(b) >= glyph * 0.3)
  const letterH = Math.max(median((tallEnough.length ? tallEnough : line).map(h)), 1)
  // The line's core band: where its letter-height strokes sit.
  const normal = line.filter((b) => h(b) >= letterH * 0.6 && h(b) <= letterH * 1.6)
  const ref = normal.length >= 2 ? normal : line
  const bandTop = median(ref.map((b) => b.y0)), bandBot = median(ref.map((b) => b.y1))
  const bandH = Math.max(bandBot - bandTop, letterH * 0.5)
  const signals: string[] = []
  let score = 0
  // Dots, apostrophes and commas are thin or tiny: they are not scripts.
  const visible = word.filter((b) => Math.max(h(b), w(b)) >= letterH * 0.35 && Math.min(h(b), w(b)) >= letterH * 0.12)
  // On a single letter a script is written after it ("x²", "a_n"); a stroke over the letter is part
  // of it (the bar of a "T").
  const left = Math.min(...word.map((b) => b.x0)), right = Math.max(...word.map((b) => b.x1))
  const afterLetter = (b: Item) => !singleLetter || b.x0 >= left + (right - left) * 0.5
  if (visible.some((b) => h(b) < letterH * 0.7 && afterLetter(b) && (b.y1 <= bandTop + bandH * 0.25 || b.y0 >= bandBot - bandH * 0.05))) {
    score += 1; signals.push('script above or below the line')
  }
  if (visible.some((b) => h(b) >= Math.max(letterH * 2.2, bandH * 2.4))) { score += 1.5; signals.push('tall symbol') }
  const bar = word.find((b) => w(b) >= letterH * 1.2 && h(b) <= w(b) * 0.25) // bars are thin: look at all strokes
  if (bar) {
    const over = (o: Item) => o !== bar && o.x1 > bar.x0 && o.x0 < bar.x1
    if (word.some((o) => over(o) && o.y1 <= bar.y0 + 1) && word.some((o) => over(o) && o.y0 >= bar.y1 - 1)) {
      score += 2; signals.push('fraction bar')
    }
  }
  return { score, signals }
}

/**
 * Labels each word of a text reading as text or maths. `words` boxes are relative to the strokes'
 * top left, as the recognizer reported them; `forced` are your own choices, which always win.
 */
export function judgeWords(
  strokes: Stroke[],
  words: RecognizedWord[],
  forced: { strokeIds: string[]; kind: WordKind }[] = []
): WordJudgement[][] {
  if (strokes.length === 0) return []
  const origin = clusterBox(strokes)
  const lines = splitLines(strokes)
  const forcedKind = (ids: string[]): WordKind | undefined => {
    for (const f of forced) if (ids.some((id) => f.strokeIds.includes(id))) return f.kind
    return undefined
  }
  const stacked = stackedLines(lines)
  return lines.map((lineStrokes, li) => {
    const items: Item[] = lineStrokes.map((s) => ({ id: s.id, ...boxOf(s.points) }))
    const glyph = glyphSize(lineStrokes.map((s) => s.points))
    const ws = words.filter((w) => w.line === li)
    const boxes = ws.map((w) => (w.box ? { x0: origin.x0 + w.box[0], x1: origin.x0 + w.box[0] + w.box[2] } : null))
    // Each stroke goes to the word it overlaps most horizontally, or else the nearest one.
    const owned: Item[][] = ws.map(() => [])
    for (const it of items) {
      let best = -1, bestScore = -Infinity
      boxes.forEach((b, k) => {
        if (!b) return
        const overlap = Math.min(it.x1, b.x1) - Math.max(it.x0, b.x0)
        const s = overlap > 0 ? overlap : -Math.min(Math.abs(it.x0 - b.x1), Math.abs(b.x0 - it.x1))
        if (s > bestScore) { bestScore = s; best = k }
      })
      if (best >= 0) owned[best].push(it)
    }
    const judged: WordJudgement[] = ws.map((w, k) => {
      const r = readingScore(w), g = inkScore(owned[k], items, glyph, r.signals.includes('single letter'))
      const ids = owned[k].map((o) => o.id)
      // Part of a small line hugging another (a script, limit or numerator the text reader split off).
      const st = stacked[li] ?? 0
      if (st) g.signals.push(st > 1 ? 'small line stacked on another' : 'has a small line stacked on it')
      // A lone digit or symbol, or a one-letter word ("I", "a", "w"), is maths only through its
      // neighbours, never through its ink alone.
      const inkless = r.signals.includes('lone symbol') || r.signals.includes('one-letter word')
      // Stacking (a limit or script line split off by the text reader) is structure, not ink shape: it counts.
      // Real words ignore ink and stacking: in joined-up writing their loops and ascenders look like
      // scripts and tall symbols (a writer's "Therefore", "is", "dumb" all did), and a line split in two
      // made "am", "us" look stacked. Only context rules (a function name) can still make them maths.
      const realWord = w.real && r.score <= -1.5
      // A one-letter word still takes a fraction bar: "1 over 2" reads as "I".
      const bar = r.signals.includes('one-letter word') && g.signals.includes('fraction bar') ? 2 : 0
      const score = realWord ? r.score : inkless ? r.score + st + bar : r.score + g.score + st

      const f = forcedKind(ids)
      return { word: w, strokeIds: ids, score, kind: f ?? (score >= MATH_THRESHOLD ? 'math' : 'text'), signals: [...r.signals, ...g.signals, ...(f ? [`you said ${f}`] : [])] }
    })
    // A bracketed group of non-words is maths as a whole: Windows Ink splits "I(s_t; s_{t-d})" into
    // "1(sei" and "Serd)", or "(s_t; s_{t-1})" into "(sec" and "te)", whose letters look like text.
    for (let k = 0; k < judged.length; k++) {
      if (!/^[^\s(]{0,3}\(/.test(judged[k].word.text.trim()) || judged[k].word.text.includes(')')) continue
      for (let e = k + 1; e < Math.min(judged.length, k + 4); e++) {
        const t = judged[e].word.text.trim()
        if (!/\)[?.,;:!]*$/.test(t)) continue
        const group = judged.slice(k, e + 1)
        if (group.some((j) => j.word.real && j.score <= -3) || group.some((j) => forcedKind(j.strokeIds))) break
        for (const j of group) if (j.kind !== 'math') { j.kind = 'math'; j.signals.push('in a bracketed group') }
        break
      }
    }
    // Neighbours: a doubtful word between maths is maths; a lone letter or symbol next to maths joins it.
    for (let changed = true; changed;) {
      changed = false
      for (let k = 0; k < judged.length; k++) {
        const j = judged[k]
        if (j.kind === 'math' || forcedKind(j.strokeIds)) continue
        const left = judged[k - 1]?.kind === 'math', right = judged[k + 1]?.kind === 'math'
        const tiny = j.word.text.trim().length <= 2 && !(j.word.real && j.word.text.trim().length === 2)
        // A word whose reading leans to maths ("P(ANB)", a variable letter) joins maths next to it;
        // ink alone does not pull a word in (joined-up letters look like scripts).
        const leans = readingScore(j.word).score >= 0.5
        // A dash next to maths is a minus only between maths: "formula - remark" keeps it as text.
        const dash = /^[-–—]$/.test(j.word.text.trim())
        if ((left && right && j.score > -3) || ((left || right) && (tiny || leans) && j.score > -0.5 && !dash)) {
          j.kind = 'math'; j.signals.push('next to maths'); changed = true
          continue
        }
        const prevW = judged[k - 1], nextW = judged[k + 1]
        // A relation sign written on its own is maths, and so is what it relates, unless that is a
        // real word: "dx = 2", "Si = d_i", "2^= 1024".
        if (RELATION.test(j.word.text.trim())) {
          j.kind = 'math'; j.signals.push('relation sign'); changed = true
          continue
        }
        const punct = TEXT_PUNCTUATION.test(j.word.text.trim())
        if (!punct && j.score > -3 && ((prevW?.kind === 'math' && /[=<>≤≥≠]$/.test(prevW.word.text.trim())) ||
          (nextW?.kind === 'math' && /^[=<>≤≥≠]/.test(nextW.word.text.trim())))) {
          j.kind = 'math'; j.signals.push('beside a relation sign'); changed = true
          continue
        }
        // A maths function followed by what it applies to: "tan x", "exp (-x", "log 8", "tan Li" (α_i).
        const operand = (o: WordJudgement | undefined) => !!o && o.score > -3 && !forcedKind(o.strokeIds) &&
          !TEXT_PUNCTUATION.test(o.word.text.trim()) && !COMMON_SHORT.has(o.word.text.trim().toLowerCase())
        if (j.signals.includes('maths function name') && operand(nextW)) {
          j.kind = 'math'; j.signals.push('applied to the next word')
          if (nextW.kind !== 'math') { nextW.kind = 'math'; nextW.signals.push('after a maths function') }
          changed = true
          continue
        }
        // The same when the function's own ink already made it maths ("tan" with a script).
        if (prevW?.kind === 'math' && prevW.signals.includes('maths function name') && operand(j)) {
          j.kind = 'math'; j.signals.push('after a maths function'); changed = true
          continue
        }
        // A short name stuck onto bracketed maths is the function it applies: "p_d(o|a)", "ln(x)".
        const next = judged[k + 1]
        const letters = (j.word.text.match(/\p{L}/gu) ?? []).length
        if (next?.kind === 'math' && /^\(/.test(next.word.text.trim()) && letters >= 1 && letters <= 3 && j.score > -3) {
          const mine = owned[k], theirs = owned[k + 1]
          const letterH = Math.max(...items.map((b) => b.y1 - b.y0).sort((a, b) => a - b).slice(0, Math.ceil(items.length / 2)), 1)
          const gap = theirs.length && mine.length ? Math.min(...theirs.map((b) => b.x0)) - Math.max(...mine.map((b) => b.x1)) : Infinity
          // Closer to the bracket than your words are to each other on this line: "p_d (o|a)". A plain
          // short word at a normal word gap ("is (x+1)") stays text.
          const gaps: number[] = []
          for (let g = 0; g + 1 < owned.length; g++) {
            if (!owned[g].length || !owned[g + 1].length) continue
            gaps.push(Math.min(...owned[g + 1].map((b) => b.x0)) - Math.max(...owned[g].map((b) => b.x1)))
          }
          const usualGap = gaps.length >= 3 ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : letterH
          const ratio = gap / Math.max(usualGap, 1)
          j.signals.push(`gap to bracket ${ratio.toFixed(2)} of usual`)
          // Measured on real notes: p_d written at 0.37 and, rewritten, 0.67 of the word gap; "is"
          // before ln(x) at 1.04. Up to 0.8 joins; 0.8–1.0 stays text but is asked about.
          if (gap < letterH * 0.8 || ratio < 0.8) {
            j.kind = 'math'; j.signals.push('function name before brackets'); changed = true
          } else if (ratio < 1) {
            j.signals.push('maybe a function name')
          }
        }
      }
    }
    takeGluedSymbols(judged, items)
    splitGluedDash(judged, items)
    splitTrailingPunctuation(judged, items)
    for (const j of judged) {
      if (forcedKind(j.strokeIds)) { j.unsure = false; continue }
      const byContext = j.signals.some((s) => CONTEXT_SIGNALS.includes(s))
      // A formula ending the line with "!" may be a factorial or the end of a sentence.
      const lastOnLine = j === judged[judged.length - 1]
      const bang = j.kind === 'math' && lastOnLine && /!$/.test(j.word.text.trim())
      const maybeName = j.kind === 'text' && j.signals.includes('maybe a function name')
      // Within 1 inclusive, so a lone variable letter (0.5: "x" whose script was missed) is asked about.
      j.unsure = Math.abs(j.score - MATH_THRESHOLD) <= 1 || (byContext && j.score < MATH_THRESHOLD - 1) || bang || maybeName
      if (bang) j.signals.push('ends the line with !: factorial or exclamation?')
    }
    return judged
  })
}

/**
 * "formula - remark": Windows Ink often reads the dash, and the word after it, as part of the
 * formula ("F=ma-Explain", "e^{iπ}+1=0-", "-t_i=d_i"). A flat stroke at the start or end of a maths
 * word, or followed only by letters, with a gap on both sides, is a dash: it and what follows it
 * become text.
 */
function splitGluedDash(judged: WordJudgement[], items: Item[]): void {
  const byId = new Map(items.map((i) => [i.id, i]))
  for (let k = judged.length - 1; k >= 0; k--) {
    const j = judged[k]
    const t = j.word.text.trim()
    const m = /^(.*?)[-–—]([\p{L}]{3,}[.,:;!?]*)?$/u.exec(t)
    const lead = /^[-–—]./u.test(t)
    if (j.kind !== 'math' || (!m && !lead)) continue
    const own = j.strokeIds.map((id) => byId.get(id)).filter((b): b is Item => !!b)
    if (own.length < 3) continue
    const hs = own.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
    const letterH = Math.max(hs[Math.floor(hs.length / 2)], 1)
    const flat = (b: Item) => b.x1 - b.x0 >= letterH * 0.6 && b.y1 - b.y0 <= (b.x1 - b.x0) * 0.35
    // Nothing written over or under a dash (unlike a fraction bar).
    const alone = (d: Item) => !own.some((o) => o !== d && (o.x0 + o.x1) / 2 > d.x0 && (o.x0 + o.x1) / 2 < d.x1)
    const gap = letterH * 0.4
    let dash: Item | undefined, after: Item[] = []
    if (lead && !m) {
      const first = [...own].sort((a, b) => a.x0 - b.x0)[0]
      const rest = own.filter((o) => o !== first)
      if (flat(first) && alone(first) && Math.min(...rest.map((o) => o.x0)) >= first.x1 + gap) dash = first
      if (!dash) continue
      const ids = new Set([dash.id])
      j.strokeIds = j.strokeIds.filter((id) => !ids.has(id))
      j.word = { ...j.word, text: t.replace(/^[-–—]\s*/, '') }
      j.signals.push('gave a dash before it to the text')
      judged.splice(k, 0, { word: { line: j.word.line, text: '-', real: false }, strokeIds: [dash.id], score: -1, kind: 'text', signals: ['dash before maths'] })
      continue
    }
    // The rightmost flat stroke with a gap on both sides; what is right of it is the remark.
    const flats = own.filter((b) => flat(b) && alone(b)).sort((a, b) => b.x1 - a.x1)
    for (const d of flats) {
      const right = own.filter((o) => o !== d && o.x0 >= d.x1 - letterH * 0.1)
      const left = own.filter((o) => o !== d && !right.includes(o))
      if (!left.length || Math.max(...left.map((o) => o.x1)) > d.x0 - gap) continue
      if (right.length && Math.min(...right.map((o) => o.x0)) < d.x1 + gap) continue
      // A dash at the end has nothing after it; one before a remark has the remark's letters.
      if (!m![2] !== (right.length === 0)) continue
      dash = d; after = right
      break
    }
    if (!dash) continue
    const moved = new Set([dash.id, ...after.map((o) => o.id)])
    j.strokeIds = j.strokeIds.filter((id) => !moved.has(id))
    j.word = { ...j.word, text: m![1] }
    j.signals.push('gave a dash after it to the text')
    const out: WordJudgement[] = [{ word: { line: j.word.line, text: '-', real: false }, strokeIds: [dash.id], score: -1, kind: 'text', signals: ['dash after maths'] }]
    if (after.length) out.push({ word: { line: j.word.line, text: m![2], real: false }, strokeIds: after.map((o) => o.id), score: -1.5, kind: 'text', signals: ['words after a dash'] })
    judged.splice(k + 1, 0, ...out)
  }
}

/**
 * A "?", "!", "." or "," written right after a formula belongs to the sentence: Windows Ink reads it
 * as part of the last maths word ("(o1:T|a1:T)?"). Its strokes, at the right end, become a text word.
 */
function splitTrailingPunctuation(judged: WordJudgement[], items: Item[]): void {
  const byId = new Map(items.map((i) => [i.id, i]))
  for (let k = judged.length - 1; k >= 0; k--) {
    const j = judged[k]
    // "!" is not split off: after maths it is usually a factorial (n!, (n-1)!). A "!" ending the line
    // could be either, so that formula is asked about instead (below, in judgeWords).
    const m = /^(.*?)([?.,;:]+)$/.exec(j.word.text.trim())
    if (j.kind !== 'math' || !m || !m[1] || judged[k + 1]?.kind === 'math') continue
    const own = j.strokeIds.map((id) => byId.get(id)).filter((b): b is Item => !!b).sort((a, b) => a.x0 - b.x0)
    if (own.length < 2) continue
    const hs = own.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
    const letterH = Math.max(hs[Math.floor(hs.length / 2)], 1)
    // The rightmost cluster of strokes overlapping each other (a "?" is a hook with a dot under it),
    // standing clear of everything to its left.
    const byRight = [...own].sort((a, b) => b.x1 - a.x1)
    const taken: Item[] = [byRight[0]]
    let minX = byRight[0].x0
    for (const b of byRight.slice(1)) {
      if (b.x1 > minX + Math.min(letterH * 0.1, (b.x1 - b.x0) * 0.5) && b.x0 >= minX - letterH * 0.3) { taken.push(b); minX = Math.min(minX, b.x0) }
    }
    const rest = own.filter((b) => !taken.includes(b))
    const clear = rest.length > 0 && Math.max(...rest.map((b) => b.x1)) <= minX + letterH * 0.15
    // Punctuation is shorter than the formula it follows (whose brackets span it); subscripts make the
    // median stroke small, so the formula's full height is the yardstick.
    const spanH = Math.max(...own.map((b) => b.y1)) - Math.min(...own.map((b) => b.y0))
    if (!clear || taken.length > 2 || taken.some((b) => b.y1 - b.y0 > spanH * 0.9)) continue
    const ids = new Set(taken.map((b) => b.id))
    j.strokeIds = j.strokeIds.filter((id) => !ids.has(id))
    j.word = { ...j.word, text: m[1] }
    judged.splice(k + 1, 0, {
      word: { line: j.word.line, text: m[2], real: false }, strokeIds: [...ids], score: -1, kind: 'text', signals: ['punctuation after maths']
    })
  }
}

/**
 * Windows Ink sometimes glues the first symbol of a formula onto the word before it ("ELBO ∑…" read
 * as "ELBOE."). In a text word next to maths, a stroke much taller than the word's letters at the
 * edge facing the maths, with whatever is stacked over or under it, moves to the maths span.
 */
function takeGluedSymbols(judged: WordJudgement[], items: Item[]): void {
  const byId = new Map(items.map((i) => [i.id, i]))
  // How tall the line's words are, ascenders and tails included: a symbol like ∑ is taller still,
  // while the d of "and" is not.
  // Measured on the other text words of the line (the word itself may hold the glued symbol).
  const heightOf = (j: WordJudgement) => {
    const bs = j.strokeIds.map((id) => byId.get(id)).filter((b): b is Item => !!b)
    return bs.length ? Math.max(...bs.map((b) => b.y1)) - Math.min(...bs.map((b) => b.y0)) : 0
  }
  const wordHFor = (self: WordJudgement) => {
    const hs = judged.filter((o) => o !== self && o.kind === 'text').map(heightOf).filter((h) => h > 0).sort((a, b) => a - b)
    return hs.length ? hs[Math.floor(hs.length / 2)] : 0
  }
  judged.forEach((j, k) => {
    if (j.kind !== 'text') return
    for (const side of [1, -1] as const) {
      const other = judged[k + side]
      if (other?.kind !== 'math') continue
      const own = j.strokeIds.map((id) => byId.get(id)).filter((b): b is Item => !!b)
      if (own.length < 3) continue
      const hs = own.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
      const letterH = Math.max(hs[Math.floor(hs.length / 2)], 1)
      const ordered = [...own].sort((a, b) => (side === 1 ? b.x1 - a.x1 : a.x0 - b.x0)) // from the maths side inwards
      const wordH = wordHFor(j)
      // A ∑, ∫ or ∏ glued on: taller than the line's words, or carrying a limit stacked over or under it.
      // The ascender of a "d" or "l" is neither.
      const stackedOn = (t: Item) => own.some((b) => b !== t && b.x1 > t.x0 && b.x0 < t.x1 &&
        (b.y1 <= t.y0 + letterH * 0.1 || b.y0 >= t.y1 - letterH * 0.1) && b.x1 - b.x0 < (t.x1 - t.x0) * 1.5)
      const tall = ordered.slice(0, 3).find((b) => b.y1 - b.y0 >= letterH * 1.8 && (b.y1 - b.y0 >= wordH * 1.1 || stackedOn(b)))
      if (!tall) continue
      // The tall symbol and what is stacked on it, plus anything between it and the maths.
      const moved = own.filter((b) => (b.x1 > tall.x0 - letterH * 0.2 && b.x0 < tall.x1 + letterH * 0.2) ||
        (side === 1 ? b.x0 >= tall.x0 : b.x1 <= tall.x1))
      if (moved.length === 0 || moved.length >= own.length) continue
      const ids = new Set(moved.map((b) => b.id))
      j.strokeIds = j.strokeIds.filter((id) => !ids.has(id))
      other.strokeIds = side === 1 ? [...ids, ...other.strokeIds] : [...other.strokeIds, ...ids]
      j.signals.push('gave a glued symbol to the maths next to it')
      // The glued symbol was read as a letter at that end of the word ("ELBOE." → "ELBO").
      const t = j.word.text.replace(/[.,:;!?]+$/, '')
      if (t.length >= 3) j.word = { ...j.word, text: side === 1 ? t.slice(0, -1) : t.slice(1) }
    }
  })
}

/**
 * The text reader splits maths into "lines" where it is stacked: x² becomes a line "2" over a line
 * "x", a fraction a numerator line over a denominator line. Such a line is small (under 60% of the
 * usual line height), sits within the span of its neighbour and hugs it (gap under half a line).
 * Returns a bonus per line: 2 for the small line, 1 for the line it belongs to, 0 otherwise.
 */
export function stackedLines(lines: Stroke[][]): number[] {
  const boxes = lines.map((l) => {
    const b = boxOf(l.flatMap((s) => s.points))
    return { ...b, h: b.y1 - b.y0 }
  })
  const out = lines.map(() => 0)
  if (boxes.length < 2) return out
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b)
  const usual = heights[Math.floor(heights.length / 2)]
  boxes.forEach((b, i) => {
    if (b.h >= usual * 0.6) return
    for (const j of [i - 1, i + 1]) {
      const n = boxes[j]
      if (!n || n.h < usual * 0.6) continue
      const gap = Math.max(n.y0 - b.y1, b.y0 - n.y1)
      const inside = b.x0 >= n.x0 - usual * 0.5 && b.x1 <= n.x1 + usual * 0.5
      if (gap < usual * 0.5 && inside) { out[i] = 2; out[j] = Math.max(out[j], 1) }
    }
  })
  return out
}

/**
 * Maths split over text "lines" (limits above and below a ∑, a numerator over its denominator)
 * comes back together: a maths span on one line that overlaps another line's maths span
 * horizontally and sits close above or below it joins the larger one. Lines left empty go.
 */
function mergeStackedMath(perLine: NotePiece[][], strokes: Stroke[]): NotePiece[][] {
  if (strokes.length === 0) return perLine
  const byId = new Map(strokes.map((s) => [s.id, s]))
  const boxFor = (p: NotePiece) => {
    const pts = p.strokeIds.flatMap((id) => byId.get(id)?.points ?? [])
    return pts.length ? boxOf(pts) : null
  }
  const lineBoxes = perLine.map((l) => {
    const pts = l.flatMap((p) => p.strokeIds.flatMap((id) => byId.get(id)?.points ?? []))
    return pts.length ? boxOf(pts) : null
  })
  const heights = lineBoxes.filter((b): b is NonNullable<typeof b> => !!b).map((b) => b.y1 - b.y0).sort((a, b) => a - b)
  const usual = heights.length ? heights[Math.floor(heights.length / 2)] : 0
  for (let changed = true; changed;) {
    changed = false
    outer: for (let a = 0; a < perLine.length; a++) {
      for (const b of [a + 1]) {
        if (b >= perLine.length) continue
        for (const pa of perLine[a].filter((p) => p.kind === 'math')) {
          for (const pb of perLine[b].filter((p) => p.kind === 'math')) {
            const A = boxFor(pa), B = boxFor(pb)
            if (!A || !B) continue
            const overlap = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)
            const narrow = Math.min(A.x1 - A.x0, B.x1 - B.x0)
            const gap = B.y0 - A.y1
            if (overlap < narrow * 0.3 || gap > usual * 0.6) continue
            // Only when one of the two is a small "line" (limits, a numerator, a script): two full
            // written lines are separate even when a tall ∫ on one reaches up to the other.
            const lineH = (k: number) => (lineBoxes[k] ? lineBoxes[k]!.y1 - lineBoxes[k]!.y0 : 0)
            if (Math.min(lineH(a), lineH(b)) >= usual * 0.6) continue
            // The smaller span joins the larger, which keeps its place in the reading order.
            const [big, small, smallLine] = pa.strokeIds.length >= pb.strokeIds.length ? [pa, pb, b] : [pb, pa, a]
            big.strokeIds.push(...small.strokeIds)
            big.text += ' ' + small.text
            if (small.unsure) big.unsure = true
            perLine[smallLine] = perLine[smallLine].filter((p) => p !== small)
            changed = true
            break outer
          }
        }
      }
    }
  }
  return perLine.filter((l) => l.length > 0)
}

/**
 * The note as pieces: text words, line breaks and maths spans (pending until the maths model has read
 * them). Maths lines directly under each other become one span, read as aligned lines. Returns null
 * when nothing is maths, so plain notes are left exactly as they were.
 */
export function planPieces(lines: WordJudgement[][], strokes: Stroke[] = []): NotePiece[] | null {
  if (!lines.some((l) => l.some((j) => j.kind === 'math'))) return null
  let perLine: NotePiece[][] = lines.map((l) => {
    const out: NotePiece[] = []
    for (const j of l) {
      const last = out[out.length - 1]
      if (j.kind === 'math' && last?.kind === 'math') {
        last.strokeIds.push(...j.strokeIds); last.text += ' ' + j.word.text
        if (j.unsure) last.unsure = true
      } else {
        out.push({ kind: j.kind, text: j.word.text, strokeIds: [...j.strokeIds], ...(j.kind === 'math' ? { pending: true } : {}), ...(j.unsure ? { unsure: true } : {}) })
      }
    }
    return out
  })
  perLine = mergeStackedMath(perLine, strokes)
  const pieces: NotePiece[] = []
  for (let k = 0; k < perLine.length; k++) {
    const line = perLine[k]
    const prev = pieces[pieces.length - 1]
    const onlyMath = line.length === 1 && line[0].kind === 'math'
    const prevOnlyMath = k > 0 && perLine[k - 1].length === 1 && perLine[k - 1][0].kind === 'math' && prev?.kind === 'math'
    if (onlyMath && prevOnlyMath) {
      prev.strokeIds.push(...line[0].strokeIds); prev.text += '\n' + line[0].text
      continue
    }
    if (k > 0) pieces.push({ kind: 'text', text: '\n', strokeIds: [] })
    pieces.push(...line)
  }
  return pieces
}

/** The note's text from its pieces: maths as $…$, words separated by spaces, lines by newlines. */
export function piecesText(pieces: NotePiece[], mathText: (p: NotePiece) => string): string {
  let out = ''
  for (const p of pieces) {
    if (p.kind === 'text' && p.text === '\n') { out = out.trimEnd() + '\n'; continue }
    const t = p.kind === 'math' ? mathText(p) : p.text
    if (!t) continue
    // Sentence punctuation sits right after what it follows: "… $\ln(x)$?"
    const glued = p.kind === 'text' && /^[?!.,;:]+$/.test(t)
    out += (out && !out.endsWith('\n') && !glued ? ' ' : '') + t
  }
  return out.trim()
}

/** Your choice for these strokes (text or maths) replaces any earlier choice for them. */
export function forceKind(
  forced: { strokeIds: string[]; kind: WordKind }[] | undefined,
  strokeIds: string[],
  kind: WordKind
): { strokeIds: string[]; kind: WordKind }[] {
  const ids = new Set(strokeIds)
  const kept = (forced ?? [])
    .map((f) => ({ ...f, strokeIds: f.strokeIds.filter((id) => !ids.has(id)) }))
    .filter((f) => f.strokeIds.length > 0)
  return [...kept, { strokeIds: [...strokeIds], kind }]
}
