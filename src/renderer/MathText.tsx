import { memo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** Splits text into plain parts and $…$ maths parts. */
function pieces(text: string): { math: boolean; text: string }[] {
  const out: { math: boolean; text: string }[] = []
  const re = /\$([^$]+)\$/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ math: false, text: text.slice(last, m.index) })
    out.push({ math: true, text: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ math: false, text: text.slice(last) })
  return out
}

/** Text with $…$ maths rendered as typeset maths, as side notes show it. */
export const MathText = memo(function MathText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {pieces(text).map((p, i) => {
        if (!p.math) return <span key={i}>{p.text}</span>
        let html = ''
        try {
          html = katex.renderToString(p.text, { throwOnError: true, displayMode: false })
        } catch {
          // Maths that could not be rebuilt cleanly is shown as its LaTeX source.
          return <code key={i}>{p.text}</code>
        }
        return <span key={i} className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </span>
  )
})

/** Shortens text without cutting through a $…$ part. */
export function shortenMath(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max
  const dollars = (text.slice(0, cut).match(/\$/g) ?? []).length
  if (dollars % 2 === 1) {
    const close = text.indexOf('$', cut)
    cut = close < 0 ? text.lastIndexOf('$', cut - 1) : close + 1
  }
  return `${text.slice(0, cut).trimEnd()}…`
}
