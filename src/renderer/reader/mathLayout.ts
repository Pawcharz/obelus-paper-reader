import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { MathLayout } from '../../shared/types'

function classesOf(e: Element): string[] {
  const c = e.properties?.className
  return Array.isArray(c) ? c.map(String) : []
}

function textOf(n: ElementContent): string {
  if (n.type === 'text') return n.value
  if (n.type === 'element') return n.children.map(textOf).join('')
  return ''
}

/**
 * Puts each display equation in a box of its own, run before rehype-katex.
 *
 * KaTeX cannot break a display equation over lines, but it can break text-style maths after a
 * top-level relation (=, ≥) or operator (+, −). So "wrap" sets the equation in display style
 * inside running text, which wraps where it may; "scroll" keeps it as one line. Either way the
 * box scrolls sideways on its own when the equation still doesn't fit, so the note itself never
 * grows wider than the pane.
 */
export function rehypeMathLayout(options: { mode?: MathLayout } = {}) {
  const mode = options.mode ?? 'wrap'
  const visit = (parent: Root | Element): void => {
    parent.children.forEach((child: RootContent, i: number) => {
      if (child.type !== 'element') return
      const code = child.tagName === 'pre' ? child.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code') : undefined
      const display = code && classesOf(code).includes('math-display') ? code : classesOf(child).includes('math-display') ? child : undefined
      if (!display) { visit(child); return }
      const tex = textOf(display).trim()
      const inner: Element = mode === 'wrap'
        ? { type: 'element', tagName: 'code', properties: { className: ['math-inline'] }, children: [{ type: 'text', value: `\\displaystyle ${tex}` }] }
        : child
      parent.children[i] = {
        type: 'element',
        tagName: 'div',
        properties: { className: ['math-block', mode], 'data-testid': 'math-block' },
        children: [inner]
      }
    })
  }
  return (tree: Root) => visit(tree)
}
