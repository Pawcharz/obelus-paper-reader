import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { UsageEvent } from '../shared/types'

/**
 * Writes usage events, one JSON object per line, to a file per local day. Only used while
 * logging is switched on, to find out which actions follow which when reading real papers.
 */
export class UsageLog {
  private chain: Promise<void> = Promise.resolve()

  constructor(readonly dir: string) {}

  fileFor(ms: number): string {
    const d = new Date(ms)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return join(this.dir, `usage-${day}.jsonl`)
  }

  append(events: UsageEvent[]): Promise<void> {
    if (events.length === 0) return this.chain
    // Writes happen one after another so lines from two batches never interleave.
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(this.dir, { recursive: true })
        const byFile = new Map<string, string[]>()
        for (const e of events) {
          const file = this.fileFor(e.ms)
          const list = byFile.get(file) ?? []
          list.push(JSON.stringify(e))
          byFile.set(file, list)
        }
        for (const [file, lines] of byFile) await fs.appendFile(file, lines.join('\n') + '\n', 'utf8')
      })
      .catch(() => undefined)
    return this.chain
  }
}
