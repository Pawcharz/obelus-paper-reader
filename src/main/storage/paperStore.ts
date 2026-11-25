import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import {
  Annotations,
  InkFile,
  Layer,
  LayerOwner,
  PaperEntry,
  PaperMeta,
  SCHEMA_VERSION,
  SideNote
} from '../../shared/types'
import { folderNameFor, newId, safeSegment } from '../../shared/ids'
import { exists, moveFile, readJson, withRetry, writeAtomic } from './atomic'
import { parseFrontmatter, renderFrontmatter } from './frontmatter'

function str(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : []
}

export function metaFromData(data: Record<string, unknown>): PaperMeta | null {
  if (!data.id) return null
  const status = str(data.status)
  const year = Number(data.year)
  return {
    id: str(data.id),
    title: str(data.title) || 'Untitled',
    authors: strList(data.authors),
    year: Number.isFinite(year) && year > 0 ? year : null,
    venue: str(data.venue),
    arxiv: str(data.arxiv),
    doi: str(data.doi),
    url: str(data.url),
    tags: strList(data.tags),
    status: status === 'reading' || status === 'read' ? status : 'unread',
    read_on: str(data.read_on),
    added: str(data.added),
    has_pdf: data.has_pdf === true,
    short_name: str(data.short_name),
    ...(str(data.original) ? { original: str(data.original) } : {})
  }
}

export interface NewPaper {
  meta: Omit<PaperMeta, 'added' | 'tags' | 'status' | 'read_on' | 'has_pdf'> &
    Partial<Pick<PaperMeta, 'added' | 'tags' | 'status' | 'read_on'>>
  /** Where the PDF is now. Absent for a stub. */
  pdf?: { path: string; move: boolean }
}

/** All file access for one workspace folder. Knows nothing about Electron, so it can be tested alone. */
export class PaperStore {
  private index = new Map<string, PaperEntry>()
  private loaded = false

  constructor(readonly root: string) {}

  get papersDir(): string {
    return join(this.root, 'papers')
  }

  async ensure(name: string, id: string): Promise<void> {
    await fs.mkdir(this.papersDir, { recursive: true })
    await fs.mkdir(join(this.root, 'maps'), { recursive: true })
    const wsFile = join(this.root, 'workspace.json')
    if (!(await exists(wsFile))) {
      await writeAtomic(wsFile, JSON.stringify({ schema: SCHEMA_VERSION, id, name }, null, 2))
    }
  }

  /** Reads every paper.md. Unreadable folders are skipped so one bad folder cannot hide the library. */
  async refresh(): Promise<PaperEntry[]> {
    const next = new Map<string, PaperEntry>()
    let names: string[] = []
    try {
      names = await fs.readdir(this.papersDir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    await Promise.all(
      names.map(async (name) => {
        const folder = join(this.papersDir, name)
        try {
          const text = await withRetry(() => fs.readFile(join(folder, 'paper.md'), 'utf8'))
          const meta = metaFromData(parseFrontmatter(text).data)
          if (meta) next.set(meta.id, { meta, folder })
        } catch {
          /* not a paper folder */
        }
      })
    )
    this.index = next
    this.loaded = true
    return this.list()
  }

  list(): PaperEntry[] {
    return [...this.index.values()].sort((a, b) => b.meta.added.localeCompare(a.meta.added))
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.refresh()
  }

  async get(id: string): Promise<PaperEntry | null> {
    await this.ensureLoaded()
    return this.index.get(id) ?? null
  }

  private async require(id: string): Promise<PaperEntry> {
    const entry = await this.get(id)
    if (!entry) throw new Error(`Paper not found: ${id}`)
    return entry
  }

  pdfPath(entry: PaperEntry): string {
    return join(entry.folder, 'paper.pdf')
  }

  /** Adds a paper, or fills in the PDF of a paper that exists as a stub. */
  async add(input: NewPaper): Promise<PaperEntry> {
    await this.ensureLoaded()
    const existing = this.index.get(input.meta.id)
    if (existing) {
      if (input.pdf && !existing.meta.has_pdf) {
        await this.placePdf(existing.folder, input.pdf)
        return this.update(existing.meta.id, { has_pdf: true })
      }
      return existing
    }
    const has_pdf = !!input.pdf
    const meta: PaperMeta = {
      tags: [],
      status: 'unread',
      read_on: '',
      added: new Date().toISOString(),
      ...input.meta,
      has_pdf
    }
    const folder = await this.uniqueFolder(folderNameFor(meta.id, meta.title))
    await fs.mkdir(folder, { recursive: true })
    if (input.pdf) await this.placePdf(folder, input.pdf)
    await this.writeMeta(folder, meta, '')
    const entry = { meta, folder }
    this.index.set(meta.id, entry)
    return entry
  }

  private async uniqueFolder(name: string): Promise<string> {
    let candidate = join(this.papersDir, name)
    for (let i = 2; await exists(candidate); i++) candidate = join(this.papersDir, `${name}-${i}`)
    return candidate
  }

  private async placePdf(folder: string, pdf: { path: string; move: boolean }): Promise<void> {
    const dest = join(folder, 'paper.pdf')
    if (pdf.move) await moveFile(pdf.path, dest)
    else await withRetry(() => fs.copyFile(pdf.path, dest))
  }

  private async writeMeta(folder: string, meta: PaperMeta, body: string): Promise<void> {
    await writeAtomic(
      join(folder, 'paper.md'),
      renderFrontmatter(meta as unknown as Record<string, unknown>, body)
    )
  }

  async update(id: string, patch: Partial<PaperMeta>): Promise<PaperEntry> {
    const entry = await this.require(id)
    const file = join(entry.folder, 'paper.md')
    const { body } = parseFrontmatter(await withRetry(() => fs.readFile(file, 'utf8')))
    const meta: PaperMeta = { ...entry.meta, ...patch, id: entry.meta.id }
    await this.writeMeta(entry.folder, meta, body)
    const updated = { meta, folder: entry.folder }
    this.index.set(id, updated)
    return updated
  }

  private layerDir(entry: PaperEntry, authorId: string): string {
    return join(entry.folder, 'people', safeSegment(authorId))
  }

  async loadLayer(paperId: string, authorId: string): Promise<Layer> {
    const entry = await this.require(paperId)
    const dir = this.layerDir(entry, authorId)
    const annotations = (await readJson<Annotations>(join(dir, 'annotations.json'))) ?? {
      schema: SCHEMA_VERSION,
      paperId,
      authorId,
      targets: [],
      marginNotes: []
    }
    const ink = (await readJson<InkFile>(join(dir, 'ink.json'))) ?? {
      schema: SCHEMA_VERSION,
      paperId,
      authorId,
      strokes: []
    }
    return { annotations, ink }
  }

  async saveLayer(paperId: string, authorId: string, layer: Layer): Promise<void> {
    const entry = await this.require(paperId)
    const dir = this.layerDir(entry, authorId)
    const loadedAs = layer.annotations.authorId
    if (loadedAs && loadedAs !== authorId) {
      // Loaded under another identity, before a sign-in or sign-out: join it with what is saved
      // here rather than replace it, so notes merged in from other computers are kept.
      const saved = await this.loadLayer(paperId, authorId)
      layer = {
        annotations: {
          ...layer.annotations,
          authorId,
          targets: unionById(layer.annotations.targets, saved.annotations.targets),
          marginNotes: unionById(layer.annotations.marginNotes, saved.annotations.marginNotes)
        },
        ink: { ...layer.ink, authorId, strokes: unionById(layer.ink.strokes, saved.ink.strokes) }
      }
    }
    await writeAtomic(join(dir, 'annotations.json'), JSON.stringify(layer.annotations, null, 2))
    await writeAtomic(join(dir, 'ink.json'), JSON.stringify(layer.ink))
  }

  /** Saves the picture of a region target and returns its path relative to the layer folder. */
  async saveRegionImage(
    paperId: string,
    authorId: string,
    targetId: string,
    png: Uint8Array
  ): Promise<string> {
    const entry = await this.require(paperId)
    const relative = `regions/${safeSegment(targetId)}.png`
    await writeAtomic(join(this.layerDir(entry, authorId), relative), png)
    return relative
  }

  async listSideNotes(paperId: string): Promise<SideNote[]> {
    const entry = await this.require(paperId)
    const dirs: string[] = [join(entry.folder, 'group', 'notes')]
    try {
      for (const person of await fs.readdir(join(entry.folder, 'people'))) {
        dirs.push(join(entry.folder, 'people', person, 'notes'))
      }
    } catch {
      /* no layers yet */
    }
    const notes: SideNote[] = []
    for (const dir of dirs) {
      let files: string[] = []
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const path = join(dir, f)
        try {
          notes.push(sideNoteFromText(await withRetry(() => fs.readFile(path, 'utf8')), path))
        } catch {
          /* removed between readdir and read */
        }
      }
    }
    return notes.sort((a, b) => a.created.localeCompare(b.created))
  }

  async createSideNote(
    paperId: string,
    authorId: string,
    init: Partial<Pick<SideNote, 'title' | 'kind' | 'body' | 'generated_by' | 'targets'>>
  ): Promise<SideNote> {
    const entry = await this.require(paperId)
    const id = newId('n')
    const path = join(this.layerDir(entry, authorId), 'notes', `${id}.md`)
    const note: SideNote = {
      id,
      author: authorId,
      generated_by: init.generated_by ?? '',
      kind: init.kind ?? 'note',
      targets: init.targets ?? [],
      created: new Date().toISOString(),
      title: init.title ?? 'New note',
      pinned: false,
      body: init.body ?? '',
      path
    }
    await this.saveSideNote(note)
    return note
  }

  async saveSideNote(note: SideNote): Promise<void> {
    this.assertInside(note.path)
    const { path, body, ...front } = note
    await writeAtomic(path, renderFrontmatter(front as Record<string, unknown>, body))
  }

  /** Checks a side note path belongs to this workspace, before it is moved to the Recycle Bin. */
  sideNotePath(path: string): string {
    this.assertInside(path)
    return path
  }

  /** The folder of a paper, so all of it can go to the Recycle Bin, and forgets the paper. */
  async takePaperFolder(id: string): Promise<string> {
    const entry = await this.require(id)
    this.index.delete(id)
    return entry.folder
  }

  private assertInside(path: string): void {
    const root = join(this.root, 'papers', ' ').trimEnd().toLowerCase()
    if (!join(path).toLowerCase().startsWith(root)) throw new Error('Path is outside the workspace')
  }

  /** Every `people/` folder in the library: one per computer used signed out, one per account. */
  async layerOwners(current: string): Promise<LayerOwner[]> {
    await this.refresh()
    const owners = new Map<string, LayerOwner>()
    for (const entry of this.list()) {
      let people: string[] = []
      try {
        people = await fs.readdir(join(entry.folder, 'people'))
      } catch {
        continue
      }
      for (const id of people) {
        const dir = join(entry.folder, 'people', id)
        const changed = await newestChange(dir)
        if (changed === null) continue
        const o = owners.get(id) ?? { authorId: id, papers: 0, lastChanged: '', current: id === current }
        o.papers++
        const iso = new Date(changed).toISOString()
        if (iso > o.lastChanged) o.lastChanged = iso
        owners.set(id, o)
      }
    }
    return [...owners.values()].sort((a, b) => b.lastChanged.localeCompare(a.lastChanged))
  }

  /**
   * Moves every note of `from` into `to`, in every paper, so they show as one person's. Nothing is
   * lost: marks, notes and strokes are joined by id, keeping `to`'s copy of any both have, and a
   * file that exists in both is kept under a new name. Returns how many papers had notes to move.
   */
  async mergeLayers(from: string, to: string): Promise<number> {
    if (safeSegment(from) === safeSegment(to)) return 0
    await this.refresh()
    let moved = 0
    for (const entry of this.list()) {
      const src = this.layerDir(entry, from)
      if (!(await exists(src))) continue
      const dest = this.layerDir(entry, to)
      if (!(await exists(dest))) {
        await withRetry(() => fs.rename(src, dest)).catch(async () => {
          // A rename across a locked folder can fail on OneDrive: copy, then remove.
          await fs.cp(src, dest, { recursive: true })
          await fs.rm(src, { recursive: true, force: true })
        })
        await this.relabelNotes(join(dest, 'notes'), to)
        await this.relabelLayer(dest, entry.meta.id, to)
      } else {
        await this.joinLayer(src, dest, entry.meta.id, to)
        await fs.rm(src, { recursive: true, force: true })
      }
      moved++
    }
    return moved
  }

  private async relabelLayer(dir: string, paperId: string, authorId: string): Promise<void> {
    for (const name of ['annotations.json', 'ink.json']) {
      const file = join(dir, name)
      const data = await readJson<Record<string, unknown>>(file).catch(() => null)
      if (data) await writeAtomic(file, JSON.stringify({ ...data, paperId, authorId }, null, name === 'ink.json' ? 0 : 2))
    }
  }

  private async relabelNotes(dir: string, authorId: string): Promise<void> {
    let files: string[] = []
    try {
      files = await fs.readdir(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const path = join(dir, f)
      const text = await withRetry(() => fs.readFile(path, 'utf8'))
      const { data, body } = parseFrontmatter(text)
      if (!data.author || data.author === authorId) continue
      await writeAtomic(path, renderFrontmatter({ ...data, author: authorId }, body))
    }
  }

  private async joinLayer(src: string, dest: string, paperId: string, authorId: string): Promise<void> {
    const a = await readJson<Annotations>(join(src, 'annotations.json')).catch(() => null)
    if (a) {
      const b = await readJson<Annotations>(join(dest, 'annotations.json')).catch(() => null)
      const joined: Annotations = {
        schema: SCHEMA_VERSION,
        paperId,
        authorId,
        targets: unionById(b?.targets ?? [], a.targets ?? []),
        marginNotes: unionById(b?.marginNotes ?? [], a.marginNotes ?? [])
      }
      await writeAtomic(join(dest, 'annotations.json'), JSON.stringify(joined, null, 2))
    }
    const i = await readJson<InkFile>(join(src, 'ink.json')).catch(() => null)
    if (i) {
      const j = await readJson<InkFile>(join(dest, 'ink.json')).catch(() => null)
      const joined: InkFile = { schema: SCHEMA_VERSION, paperId, authorId, strokes: unionById(j?.strokes ?? [], i.strokes ?? []) }
      await writeAtomic(join(dest, 'ink.json'), JSON.stringify(joined))
    }
    // Side notes, region pictures and anything else: moved over, renamed if the name is taken.
    await moveTree(src, dest, new Set(['annotations.json', 'ink.json']))
    await this.relabelNotes(join(dest, 'notes'), authorId)
  }

  /** Matches titles, authors, tags, margin notes and side notes. All words must match. */
  async search(query: string, authorId: string): Promise<string[]> {
    await this.ensureLoaded()
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return this.list().map((e) => e.meta.id)
    const hits: string[] = []
    await Promise.all(
      this.list().map(async (entry) => {
        const text = await this.searchableText(entry, authorId)
        if (words.every((w) => text.includes(w))) hits.push(entry.meta.id)
      })
    )
    return hits
  }

  private async searchableText(entry: PaperEntry, authorId: string): Promise<string> {
    const { meta } = entry
    const parts = [meta.short_name ?? '', meta.title, meta.authors.join(' '), meta.tags.join(' '), meta.venue, meta.arxiv]
    const annotations = await readJson<Annotations>(
      join(this.layerDir(entry, authorId), 'annotations.json')
    ).catch(() => null)
    if (annotations) parts.push(...annotations.marginNotes.map((n) => n.text))
    const notes = await this.listSideNotes(meta.id).catch(() => [] as SideNote[])
    parts.push(...notes.flatMap((n) => [n.title, n.body]))
    return parts.join('\n').toLowerCase()
  }
}

/** Items of `first` and of `second`, by id; `first`'s copy wins when both have one. */
function unionById<T extends { id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map((x) => x.id))
  return [...first, ...second.filter((x) => !seen.has(x.id))]
}

/** Moves the files of `src` into `dest`, keeping both when a name exists in each. */
async function moveTree(src: string, dest: string, skip: Set<string>): Promise<void> {
  let items: import('node:fs').Dirent[] = []
  try {
    items = await fs.readdir(src, { withFileTypes: true })
  } catch {
    return
  }
  await fs.mkdir(dest, { recursive: true })
  for (const item of items) {
    if (skip.has(item.name)) continue
    const from = join(src, item.name)
    if (item.isDirectory()) {
      await moveTree(from, join(dest, item.name), new Set())
      continue
    }
    let to = join(dest, item.name)
    if (await exists(to)) {
      const dot = item.name.lastIndexOf('.')
      const stem = dot > 0 ? item.name.slice(0, dot) : item.name
      const ext = dot > 0 ? item.name.slice(dot) : ''
      for (let n = 2; await exists(to); n++) to = join(dest, `${stem}-${n}${ext}`)
    }
    await moveFile(from, to)
  }
}

/** The newest modified time of any file under `dir`, or null when it holds no files. */
async function newestChange(dir: string): Promise<number | null> {
  let newest: number | null = null
  let items: import('node:fs').Dirent[] = []
  try {
    items = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const item of items) {
    const path = join(dir, item.name)
    const t = item.isDirectory() ? await newestChange(path) : (await fs.stat(path).catch(() => null))?.mtimeMs ?? null
    if (t !== null && (newest === null || t > newest)) newest = t
  }
  return newest
}

export function sideNoteFromText(text: string, path: string): SideNote {
  const { data, body } = parseFrontmatter(text)
  return {
    id: str(data.id) || basename(path, '.md'),
    author: str(data.author),
    generated_by: str(data.generated_by),
    kind: str(data.kind) || 'note',
    targets: strList(data.targets),
    created: str(data.created),
    title: str(data.title) || basename(path, '.md'),
    pinned: data.pinned === true,
    body: body.replace(/^\r?\n/, ''),
    path
  }
}
