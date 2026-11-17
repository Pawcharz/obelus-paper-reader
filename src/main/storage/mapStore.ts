import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ReadingMap } from '../../shared/types'
import { emptyMap } from '../../shared/mapLogic'
import { safeSegment, slugifyTitle } from '../../shared/ids'
import { exists, readJson, writeAtomic } from './atomic'

export class MapStore {
  constructor(readonly root: string) {}

  private get dir(): string {
    return join(this.root, 'maps')
  }

  private file(id: string): string {
    return join(this.dir, `${safeSegment(id)}.json`)
  }

  async list(): Promise<ReadingMap[]> {
    let names: string[] = []
    try {
      names = await fs.readdir(this.dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const maps: ReadingMap[] = []
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      try {
        const m = await readJson<ReadingMap>(join(this.dir, n))
        if (m) maps.push(normalize(m, n.replace(/\.json$/, '')))
      } catch {
        /* a half-written or broken file should not hide the other maps */
      }
    }
    return maps.sort((a, b) => a.name.localeCompare(b.name))
  }

  async create(name: string): Promise<ReadingMap> {
    const base = slugifyTitle(name)
    let id = base
    for (let i = 2; await exists(this.file(id)); i++) id = `${base}-${i}`
    const map = emptyMap(id, name)
    await this.save(map)
    return map
  }

  async save(map: ReadingMap): Promise<void> {
    await writeAtomic(this.file(map.id), JSON.stringify(map, null, 2))
  }

  /** Where a map is stored, so it can go to the Recycle Bin. */
  fileOf(id: string): string {
    return this.file(id)
  }
}

/** Maps can be written by hand or by Claude Code, so missing parts are filled in. */
function normalize(m: ReadingMap, fallbackId: string): ReadingMap {
  return {
    schema: m.schema ?? 1,
    id: m.id ?? fallbackId,
    name: m.name ?? fallbackId,
    nodes: Array.isArray(m.nodes) ? m.nodes : [],
    edges: Array.isArray(m.edges)
      ? m.edges.map((e) => ({ ...e, status: e.status ?? 'confirmed' }))
      : [],
    groups: Array.isArray(m.groups) ? m.groups : [],
    // Where papers were moved by hand; kept only if it is a plain id → {x, y} table.
    ...(m.positions && typeof m.positions === 'object'
      ? {
          positions: Object.fromEntries(
            Object.entries(m.positions).filter(([, p]) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
          )
        }
      : {})
  }
}
