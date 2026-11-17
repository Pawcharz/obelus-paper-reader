import { parse, stringify } from 'yaml'

export interface Parsed {
  data: Record<string, unknown>
  body: string
}

export function parseFrontmatter(text: string): Parsed {
  const normalized = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized)
  if (!m) return { data: {}, body: normalized }
  let data: unknown
  try {
    data = parse(m[1])
  } catch {
    // A hand-edited file with broken YAML still shows its text.
    return { data: {}, body: normalized }
  }
  return {
    data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    body: normalized.slice(m[0].length)
  }
}

export function renderFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n${body.startsWith('\n') || body === '' ? body : '\n' + body}`
}
