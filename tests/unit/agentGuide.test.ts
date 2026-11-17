import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_GUIDE, CLAUDE_POINTER, GUIDE_MARKER, writeAgentGuide } from '../../src/main/agentGuide'

let root = ''
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'guide-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('agent guide in the library', () => {
  it('writes AGENTS.md and a CLAUDE.md that imports it', async () => {
    await writeAgentGuide(root)
    expect(await fs.readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENT_GUIDE)
    expect(await fs.readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_POINTER)
    expect(CLAUDE_POINTER).toContain('@AGENTS.md')
  })

  it('explains every link the side notes understand', () => {
    for (const form of ['(note:<', '(mark:<', '(page:<', '(https://']) expect(AGENT_GUIDE).toContain(form)
  })

  it('updates its own older version', async () => {
    await fs.writeFile(join(root, 'AGENTS.md'), `${GUIDE_MARKER}\nold text\n`)
    await writeAgentGuide(root)
    expect(await fs.readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENT_GUIDE)
  })

  it("never touches the reader's own files", async () => {
    await fs.writeFile(join(root, 'AGENTS.md'), 'my own rules\n')
    await fs.writeFile(join(root, 'CLAUDE.md'), 'mine too\n')
    await writeAgentGuide(root)
    expect(await fs.readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('my own rules\n')
    expect(await fs.readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('mine too\n')
  })
})
