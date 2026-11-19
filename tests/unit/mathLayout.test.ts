import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import type { Element, Root, RootContent } from 'hast'
import { rehypeMathLayout } from '../../src/renderer/reader/mathLayout'
import type { MathLayout } from '../../src/shared/types'

const md = 'Before.\n\n$$\na + b = c \\ge \\sum_{t=1}^{T} x_t\n$$\n\nAfter $y_t$.\n'

function render(mode: MathLayout): Root {
  const p = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(rehypeMathLayout, { mode }).use(rehypeKatex)
  return p.runSync(p.parse(md)) as Root
}

function all(n: Root | RootContent, out: Element[] = []): Element[] {
  if (n.type === 'element') out.push(n)
  if ('children' in n) for (const c of n.children) all(c as RootContent, out)
  return out
}
const cls = (e: Element) => (Array.isArray(e.properties.className) ? e.properties.className.map(String) : [])

describe('side-note display equations', () => {
  it('wrap: each display equation sits in its own box, set in display style as breakable text', () => {
    const els = all(render('wrap'))
    const blocks = els.filter((e) => cls(e).includes('math-block'))
    expect(blocks).toHaveLength(1)
    expect(cls(blocks[0])).toContain('wrap')
    const inside = all(blocks[0])
    expect(inside.some((e) => cls(e).includes('katex-display'))).toBe(false)
    // One piece per stretch between relations and operators, which is where a line may break.
    expect(inside.filter((e) => cls(e).includes('katex-base')).length).toBeGreaterThan(2)
    // Limits stay above and below the sum, as in display style.
    expect(inside.some((e) => cls(e).includes('op-limits'))).toBe(true)
  })

  it('scroll: the equation stays one display line, in a box that scrolls on its own', () => {
    const els = all(render('scroll'))
    const blocks = els.filter((e) => cls(e).includes('math-block'))
    expect(blocks).toHaveLength(1)
    expect(cls(blocks[0])).toContain('scroll')
    expect(all(blocks[0]).some((e) => cls(e).includes('katex-display'))).toBe(true)
  })

  it('leaves inline maths alone', () => {
    for (const mode of ['wrap', 'scroll'] as const) {
      const els = all(render(mode))
      expect(els.filter((e) => cls(e).includes('katex')).length).toBe(2)
    }
  })
})
