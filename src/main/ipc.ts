import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { resourcePath } from './resourcePath'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import chokidar, { FSWatcher } from 'chokidar'
import type { AddOutcome, AddToMapOutcome, ChangeEvent, ManualDetails, PdfHints, SignInOutcome } from '../shared/api'
import {
  AppSettings,
  Layer,
  PaperEntry,
  PaperMeta,
  PreviewItem,
  PreviewOutcome,
  ReadingMap,
  ResolvedPaper,
  SideNote,
  Workspace,
  UsageEvent,
  ModelPackId
} from '../shared/types'
import { findArxivId, findDoi, newId, paperIdFor } from '../shared/ids'
import { mapContains, mapShortName, suggestReferenceEdge } from '../shared/mapLogic'
import { SettingsStore } from './settings'
import { UsageLog } from './usageLog'
import { PaperStore } from './storage/paperStore'
import { MapStore } from './storage/mapStore'
import { exists, writeAtomic } from './storage/atomic'
import { NullEngine, RecognitionEngine, recognizerChoice } from './recognition/engine'
import { WindowsInkEngine } from './recognition/windowsInk'
import { MathEngine } from './recognition/mathEngine'
import { VlmEngine } from './recognition/vlmEngine'
import { labFiles, ModelMissingError, ModelStore } from './models/store'
import { MODEL_PACKS, packsFor } from './models/catalog'
import { Fetcher, defaultFetcher, Resolver } from './lookup/resolve'
import { titleSimilarity } from './lookup/refText'
import { purgeCache, touch } from './cache'
import { fakeFetcher } from './lookup/fakeFetcher'
import { writeAgentGuide } from './agentGuide'
import { htmlToPdf } from './htmlToPdf'
import { isHtmlFile } from '../shared/htmlReport'
import { googleClient, googleClientFile } from './auth/config'
import { SignInHandle, signInWithGoogle } from './auth/google'
import { currentAuthorId } from '../shared/account'

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000

function previewsDir(): string {
  const base = process.env.PAPER_READER_CACHE ?? join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'PaperReader')
  return join(base, 'previews')
}

function metaFromResolved(p: ResolvedPaper, localHash = ''): NewMeta {
  // A paper with neither identifier still needs an ID of its own.
  const hash = localHash || createHash('sha256').update(p.title).digest('hex').slice(0, 12)
  return {
    id: paperIdFor(p.arxiv, p.doi, hash),
    title: p.title,
    authors: p.authors,
    year: p.year,
    venue: p.venue,
    arxiv: p.arxiv,
    doi: p.doi,
    url: p.url
  }
}

type NewMeta = Pick<PaperMeta, 'id' | 'title' | 'authors' | 'year' | 'venue' | 'arxiv' | 'doi' | 'url'>

async function isPdf(bytes: Uint8Array): Promise<boolean> {
  return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF')
}

/** Deleting never destroys: files go to the Recycle Bin, where they can be restored. */
async function trash(path: string): Promise<void> {
  await shell.trashItem(path)
}

export async function registerIpc(getWindow: () => BrowserWindow | null): Promise<() => void> {
  const settings = new SettingsStore(app.getPath('userData'))
  const usageLog = new UsageLog(join(app.getPath('userData'), 'usage-logs'))
  // Local models (downloaded on request into <userData>/models): the maths reader on Windows, the
  // handwriting reader on Linux. Files the lab scripts set up on the author's PCs are used as they are.
  const models = new ModelStore(join(app.getPath('userData'), 'models'), {
    overrideDir: async (id) => (id === 'math' ? (await settings.get()).mathModelDir : undefined),
    legacy: labFiles,
    onStatus: (s) => getWindow()?.webContents.send('models', s)
  })
  const packFiles = (id: ModelPackId) => async () => {
    const found = await models.files(id)
    if (!found) throw new ModelMissingError(`The ${MODEL_PACKS[id].title.toLowerCase()} is not downloaded.`)
    return found.files
  }
  const engine: RecognitionEngine =
    process.platform === 'win32'
      ? new WindowsInkEngine(resourcePath('ink-sidecar.ps1'))
      : process.platform === 'linux'
        ? new VlmEngine({ files: packFiles('text') })
        : new NullEngine()
  const mathEngine = new MathEngine(packFiles('math'))
  const fetcher: Fetcher = process.env.PAPER_READER_FAKE_NET ? fakeFetcher : defaultFetcher
  const resolver = new Resolver(
    fetcher,
    process.env.PAPER_READER_FAKE_NET ? { arxivGapMs: 0, retryDelays: [] } : {}
  )
  const openPreviews = new Set<string>()
  const previewCache = new Map<string, PreviewItem>()

  async function workspaceOf(s: AppSettings): Promise<Workspace> {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) throw new Error('No workspace selected')
    return ws
  }
  let storeCache: { root: string; store: PaperStore } | null = null
  async function store(): Promise<PaperStore> {
    const ws = await workspaceOf(await settings.get())
    if (storeCache?.root !== ws.path) {
      storeCache = { root: ws.path, store: new PaperStore(ws.path) }
      // Tells Claude Code and other agents how to read the notes and link to them.
      void writeAgentGuide(ws.path).catch(() => undefined)
    }
    return storeCache.store
  }
  async function maps(): Promise<MapStore> {
    return new MapStore((await workspaceOf(await settings.get())).path)
  }
  async function author(): Promise<string> {
    return currentAuthorId(await settings.get())
  }
  let signIn: SignInHandle | null = null

  /** Moves the notes of `from` into `to` in every library this computer knows, and says so to the window. */
  async function mergeEverywhere(from: string[], to: string): Promise<number> {
    const s = await settings.get()
    let papers = 0
    for (const ws of s.workspaces) {
      if (!(await exists(ws.path))) continue
      const st = storeCache?.root === ws.path ? storeCache.store : new PaperStore(ws.path)
      for (const id of from) papers += await st.mergeLayers(id, to)
    }
    send({ kind: 'papers' })
    return papers
  }

  function send(event: ChangeEvent): void {
    getWindow()?.webContents.send('change', event)
  }

  let watcher: FSWatcher | null = null
  const timers = new Map<string, NodeJS.Timeout>()
  function debounced(key: string, event: ChangeEvent): void {
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => send(event), 150))
  }
  async function watchWorkspace(): Promise<void> {
    await watcher?.close()
    watcher = null
    const s = await settings.get()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) return
    const ignored = (p: string): boolean => /\.pdf$|\.tmp-\d+|[\\/]ink\.json$|\.png$/i.test(p)
    watcher = chokidar.watch(ws.path, { ignoreInitial: true, ignored })
    const handle = (p: string): void => {
      const norm = p.replace(/\\/g, '/')
      const noteMatch = /^(.*\/papers\/[^/]+)\/(?:people\/[^/]+|group)\/notes\/[^/]+\.md$/.exec(norm)
      if (noteMatch) debounced(`notes:${noteMatch[1]}`, { kind: 'notes', folder: noteMatch[1] })
      else if (norm.endsWith('/paper.md')) {
        debounced('papers', { kind: 'papers' })
      } else if (/\/maps\/[^/]+\.json$/.test(norm)) debounced('maps', { kind: 'maps' })
    }
    watcher.on('add', handle).on('change', handle).on('unlink', handle)
  }
  await watchWorkspace()

  async function purge(): Promise<void> {
    const s = await settings.get()
    await purgeCache(previewsDir(), {
      maxAgeMs: s.cacheMaxAgeDays * 24 * 60 * 60 * 1000,
      maxBytes: s.cacheMaxBytes,
      keep: openPreviews
    })
  }
  await purge().catch(() => undefined)
  const purgeTimer = setInterval(() => void purge().catch(() => undefined), PURGE_INTERVAL_MS)

  /**
   * Gives a paper that just entered the library the short name a map box gave it, unless it already
   * has one, so the box keeps its name after the download.
   */
  async function withMapName(entry: PaperEntry): Promise<PaperEntry> {
    if (entry.meta.short_name?.trim()) return entry
    const name = mapShortName(await (await maps()).list(), entry.meta.id)
    return name ? (await store()).update(entry.meta.id, { short_name: name }) : entry
  }

  /** Finds a library paper by arXiv ID, DOI or, failing those, a very similar title. */
  async function findInLibrary(paper: ResolvedPaper | undefined, title: string): Promise<string> {
    const entries = await (await store()).refresh()
    if (paper?.arxiv) {
      const hit = entries.find((e) => e.meta.arxiv === paper.arxiv)
      if (hit) return hit.meta.id
    }
    if (paper?.doi) {
      const hit = entries.find((e) => e.meta.doi.toLowerCase() === paper.doi.toLowerCase())
      if (hit) return hit.meta.id
    }
    if (title) {
      const hit = entries.find((e) => titleSimilarity(e.meta.title, title) >= 0.85)
      if (hit) return hit.meta.id
    }
    return ''
  }

  async function downloadPdf(url: string, dest: string): Promise<boolean> {
    try {
      const res = await fetcher(url)
      if (!res.ok) return false
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (!(await isPdf(bytes))) return false
      await writeAtomic(dest, bytes)
      return true
    } catch {
      return false
    }
  }

  const handlers: Record<string, (...args: never[]) => unknown> = {
    getSettings: () => settings.get(),
    updateSettings: async (patch: Partial<AppSettings>) => {
      if (patch.profile) {
        // Who is signed in, and this computer's identity, change only through sign-in and sign-out.
        const { profile } = await settings.get()
        const { account: _a, authorId: _id, ...rest } = patch.profile
        patch = { ...patch, profile: { ...rest, authorId: profile.authorId, ...(profile.account ? { account: profile.account } : {}) } }
      }
      return settings.update(patch)
    },
    pickFolder: async () => {
      const win = getWindow()
      const r = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        : { canceled: true, filePaths: [] }
      return r.canceled ? null : r.filePaths[0]
    },
    defaultLibraryPath: () =>
      join(process.env.OneDrive || join(homedir(), 'OneDrive'), 'Paper Library'),
    addWorkspace: async (path: string, name: string) => {
      const s = await settings.get()
      const existing = s.workspaces.find((w) => w.path.toLowerCase() === path.toLowerCase())
      const ws: Workspace = existing ?? { id: randomUUID(), name, path }
      await new PaperStore(path).ensure(ws.name, ws.id)
      await settings.update({
        workspaces: existing ? s.workspaces : [...s.workspaces, ws],
        activeWorkspaceId: ws.id
      })
      await watchWorkspace()
      return ws
    },
    setActiveWorkspace: async (id: string) => {
      await settings.update({ activeWorkspaceId: id })
      await watchWorkspace()
    },

    accountStatus: async () => {
      const s = await settings.get()
      return {
        account: s.profile.account ?? null,
        authorId: currentAuthorId(s),
        computerAuthorId: s.profile.authorId,
        googleConfigured: !!(await googleClient(app.getPath('userData'))),
        googleClientFile: googleClientFile(app.getPath('userData'))
      }
    },
    signInWithGoogle: async (): Promise<SignInOutcome> => {
      const client = await googleClient(app.getPath('userData'))
      if (!client) return { ok: false, reason: 'Google sign-in is not set up in this copy of Obelus.' }
      signIn?.cancel()
      const handle = signInWithGoogle(client, (url) => shell.openExternal(url))
      signIn = handle
      try {
        const account = await handle.result
        const before = await settings.get()
        const next = await settings.update({ profile: { ...before.profile, account } })
        // This computer's own notes join the account's, so they follow it to other computers.
        const merged = await mergeEverywhere([before.profile.authorId], currentAuthorId(next))
        getWindow()?.focus()
        return { ok: true, settings: next, merged }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      } finally {
        if (signIn === handle) signIn = null
      }
    },
    cancelSignIn: () => {
      signIn?.cancel()
      signIn = null
    },
    signOut: async () => {
      const s = await settings.get()
      const { account: _gone, ...profile } = s.profile
      return settings.update({ profile })
    },
    listLayerOwners: async () => (await store()).layerOwners(await author()),
    mergeLayers: async (ids: string[]) => {
      const to = await author()
      return mergeEverywhere(ids.filter((id) => id !== to), to)
    },

    listPapers: async () => (await store()).refresh(),
    searchPapers: async (q: string) => (await store()).search(q, await author()),
    updatePaper: async (id: string, patch: Partial<PaperMeta>) => (await store()).update(id, patch),
    readPdf: async (id: string) => {
      const st = await store()
      const entry = await st.get(id)
      if (!entry) throw new Error('Paper not found')
      return fs.readFile(st.pdfPath(entry))
    },
    readFileBytes: async (path: string) => {
      if (!path.toLowerCase().endsWith('.pdf')) throw new Error('Only PDF files can be read')
      return fs.readFile(path)
    },
    pickPdf: async () => {
      const win = getWindow()
      const r = win
        ? await dialog.showOpenDialog(win, {
            title: 'Add a PDF or an HTML report',
            properties: ['openFile'],
            filters: [
              { name: 'PDF or HTML report', extensions: ['pdf', 'html', 'htm'] },
              { name: 'PDF', extensions: ['pdf'] },
              { name: 'HTML report', extensions: ['html', 'htm'] }
            ]
          })
        : { canceled: true, filePaths: [] }
      return r.canceled ? null : r.filePaths[0]
    },

    convertHtml: async (path: string) => {
      if (!isHtmlFile(path)) return { ok: false as const, reason: 'Only .html files can be turned into a PDF' }
      await fs.mkdir(previewsDir(), { recursive: true })
      const pdfPath = join(previewsDir(), `${newId('html')}.pdf`)
      try {
        const { title } = await htmlToPdf(path, pdfPath)
        return { ok: true as const, pdfPath, titleGuess: title }
      } catch (e) {
        return { ok: false as const, reason: `This report could not be turned into a PDF. ${(e as Error).message}` }
      }
    },
    openOriginal: async (id: string) => {
      const st = await store()
      const entry = await st.get(id)
      if (!entry?.meta.original) return
      const err = await shell.openPath(join(entry.folder, entry.meta.original))
      if (err) throw new Error(err)
    },

    addPaperFromFile: async (path: string, hints: PdfHints, title?: string, details?: ManualDetails, originalHtml?: string): Promise<AddOutcome> => {
      const st = await store()
      // A report's PDF differs with every conversion, so the report itself decides which paper it is.
      const bytes = await fs.readFile(originalHtml ?? path)
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
      if (originalHtml) {
        // Reports are not looked up online: a title search could match an unrelated published paper.
        if (!title) return { ok: false, reason: 'A report needs a title.', needsTitle: true, titleGuess: hints.titleGuess }
        const meta = {
          id: paperIdFor('', '', hash), title, authors: details?.authors ?? [], year: details?.year ?? null,
          venue: '', arxiv: '', doi: '', url: details?.url ?? ''
        }
        const existed = !!(await st.get(meta.id))
        let entry = await st.add({ meta, pdf: { path, move: true } })
        if (!existed) {
          const name = /\.htm$/i.test(originalHtml) ? 'original.htm' : 'original.html'
          await fs.copyFile(originalHtml, join(entry.folder, name))
          entry = await st.update(entry.meta.id, { original: name })
        }
        return { ok: true, entry, existed }
      }
      if (title) {
        const entry = await st.add({
          meta: {
            id: paperIdFor('', '', hash), title, authors: details?.authors ?? [], year: details?.year ?? null,
            venue: '', arxiv: '', doi: '', url: details?.url ?? ''
          },
          pdf: { path, move: false }
        })
        return { ok: true, entry }
      }
      const text = hints.firstPageText
      let found: ResolvedPaper | null = null
      try {
        const arxiv = findArxivId(text) || findArxivId(path.replace(/.*[\\/]/, '').replace(/\.pdf$/i, ''))
        if (arxiv) found = await resolver.byArxivId(arxiv)
        const doi = findDoi(text)
        if (!found && doi) found = await resolver.byDoi(doi)
        if (!found && hints.titleGuess) found = await resolver.byTitle(hints.titleGuess)
      } catch {
        /* offline or a service is down: ask for the title */
      }
      if (!found) {
        return { ok: false, reason: 'No details found for this PDF.', needsTitle: true, titleGuess: hints.titleGuess }
      }
      const meta = metaFromResolved(found, hash)
      const existed = !!(await st.get(meta.id))?.meta.has_pdf
      const entry = await withMapName(await st.add({ meta, pdf: { path, move: false } }))
      return { ok: true, entry, existed }
    },

    addPaperById: async (text: string, stubOnly = false): Promise<AddOutcome> => {
      const st = await store()
      let found: ResolvedPaper | null = null
      try {
        const arxiv = findArxivId(text)
        const doi = findDoi(text)
        if (arxiv) found = await resolver.byArxivId(arxiv)
        else if (doi) found = await resolver.byDoi(doi)
        else if (text.trim().split(/\s+/).length >= 3) found = await resolver.byTitle(text.trim())
      } catch {
        return { ok: false, reason: 'The lookup failed. Check the connection and try again.' }
      }
      if (!found) return { ok: false, reason: 'No paper found for that ID.' }
      const meta = metaFromResolved(found)
      const prior = await st.get(meta.id)
      if (prior && (prior.meta.has_pdf || stubOnly)) return { ok: true, entry: prior, existed: true }
      if (stubOnly || !found.pdfUrl) {
        const entry = await withMapName(await st.add({ meta }))
        return { ok: true, entry }
      }
      const tmp = join(previewsDir(), `${newId('add')}.pdf`)
      if (!(await downloadPdf(found.pdfUrl, tmp))) {
        const entry = await withMapName(await st.add({ meta }))
        return { ok: true, entry }
      }
      const entry = await withMapName(await st.add({ meta, pdf: { path: tmp, move: true } }))
      return { ok: true, entry }
    },

    fetchPdfForStub: async (id: string): Promise<AddOutcome> => {
      const st = await store()
      const entry = await st.get(id)
      if (!entry) return { ok: false, reason: 'Paper not found.' }
      let found: ResolvedPaper | null = null
      try {
        if (entry.meta.arxiv) found = await resolver.byArxivId(entry.meta.arxiv)
        else if (entry.meta.doi) found = await resolver.byDoi(entry.meta.doi)
        else found = await resolver.byTitle(entry.meta.title)
      } catch {
        /* reported below */
      }
      if (!found?.pdfUrl) return { ok: false, reason: 'No open PDF found' }
      const tmp = join(previewsDir(), `${newId('add')}.pdf`)
      if (!(await downloadPdf(found.pdfUrl, tmp))) return { ok: false, reason: 'No open PDF found' }
      // Keeps the stub's own ID, so it is filled in and not duplicated.
      const updated = await withMapName(await st.add({ meta: { ...metaFromResolved(found), id }, pdf: { path: tmp, move: true } }))
      return { ok: true, entry: updated }
    },

    loadLayer: async (paperId: string) => (await store()).loadLayer(paperId, await author()),
    saveLayer: async (paperId: string, layer: Layer) =>
      (await store()).saveLayer(paperId, await author(), layer),
    saveRegionImage: async (paperId: string, targetId: string, png: Uint8Array) =>
      (await store()).saveRegionImage(paperId, await author(), targetId, png),

    listSideNotes: async (paperId: string) => (await store()).listSideNotes(paperId),
    createSideNote: async (paperId: string, init: { title?: string }) =>
      (await store()).createSideNote(paperId, await author(), init),
    saveSideNote: async (note: SideNote) => (await store()).saveSideNote(note),
    deleteSideNote: async (path: string) => trash((await store()).sideNotePath(path)),
    deletePaper: async (id: string) => {
      const st = await store()
      await trash(await st.takePaperFolder(id))
    },

    listRecognizers: () => engine.listRecognizers().catch(() => [] as string[]),
    recognize: async (lines: number[][][], hints?: { vocabulary: string[]; preferred: string }) =>
      engine.recognize({
        lines,
        ...recognizerChoice(await settings.get()),
        vocabulary: hints?.vocabulary,
        preferred: hints?.preferred
      }),
    recognizeMath: (image: string) => mathEngine.recognize(image),
    /** Whether maths inside notes is found and read: switched on (the default) and the model is there. */
    mathReady: async () => (await settings.get()).findMaths !== false && (await models.files('math')) !== null,
    listModels: async () => Promise.all(packsFor().map((p) => models.status(p.id))),
    downloadModel: async (id: ModelPackId) => {
      try {
        await models.download(id)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    cancelModelDownload: async (id: ModelPackId) => models.cancel(id),
    removeModel: async (id: ModelPackId) => models.remove(id),

    previewReference: async (text: string): Promise<PreviewOutcome> => {
      // The same reference, or the same PDF reached from another reference, opens instantly.
      const textKey = text.replace(/\s+/g, ' ').trim().toLowerCase()
      const cachedByText = previewCache.get(textKey)
      if (cachedByText && (await exists(cachedByText.path))) return { ok: true, preview: cachedByText }
      // An arXiv id or DOI you already have opens at once, without asking the web.
      const arxivId = findArxivId(text)
      const doiId = findDoi(text)
      if (arxivId || doiId) {
        const libraryId = await findInLibrary({ arxiv: arxivId, doi: doiId } as ResolvedPaper, '')
        if (libraryId) return { ok: false, reason: 'Already in your library', searchText: '', libraryId }
      }
      const outcome = await resolver.resolveReference(text)
      // A paper you already have opens from the library, with your notes, instead of as a preview.
      const known = outcome.ok ? outcome.paper : outcome.paper
      const libraryId = await findInLibrary(known, known?.title ?? (outcome.ok ? '' : outcome.searchText))
      if (libraryId) {
        return { ok: false, reason: 'Already in your library', searchText: known?.title ?? '', libraryId }
      }
      if (!outcome.ok) return outcome
      const cachedByPdf = previewCache.get(outcome.paper.pdfUrl)
      if (cachedByPdf && (await exists(cachedByPdf.path))) {
        previewCache.set(textKey, cachedByPdf)
        return { ok: true, preview: cachedByPdf }
      }
      const previewId = newId('p')
      const path = join(previewsDir(), `${previewId}.pdf`)
      if (!(await downloadPdf(outcome.paper.pdfUrl, path))) {
        return { ok: false, reason: 'No open PDF found', searchText: outcome.paper.title }
      }
      openPreviews.add(path)
      await purge().catch(() => undefined)
      const preview = { previewId, path, paper: outcome.paper }
      previewCache.set(textKey, preview)
      previewCache.set(outcome.paper.pdfUrl, preview)
      return { ok: true, preview }
    },
    readPreview: async (previewId: string) => {
      const path = join(previewsDir(), `${previewId.replace(/[^\w-]/g, '')}.pdf`)
      await touch(path)
      return fs.readFile(path)
    },
    addPreview: async (preview: PreviewItem, citingPaperId: string, fromMapId: string): Promise<AddOutcome> => {
      const st = await store()
      if (!(await exists(preview.path))) return { ok: false, reason: 'The preview has expired. Open it again.' }
      const meta = metaFromResolved(preview.paper, preview.previewId)
      const entry = await withMapName(await st.add({ meta, pdf: { path: preview.path, move: true } }))
      openPreviews.delete(preview.path)
      for (const [k, v] of previewCache) if (v.path === preview.path) previewCache.delete(k)
      await fs.rm(preview.path, { force: true }).catch(() => undefined)
      if (citingPaperId) {
        const ms = await maps()
        const all = await ms.list()
        const map =
          all.find((m) => m.id === fromMapId && mapContains(m, citingPaperId)) ??
          all.find((m) => mapContains(m, citingPaperId))
        const citing = (await st.get(citingPaperId))?.meta
        if (map) await ms.save(suggestReferenceEdge(map, entry.meta.id, entry.meta, citingPaperId, citing ?? {}))
      }
      return { ok: true, entry }
    },
    /**
     * Puts a cited paper on the map as a suggestion, without opening or downloading it: the paper
     * from the library if it is there, otherwise a box that downloads the PDF when opened. The map
     * is the one the citing paper was opened from, or else the first map that holds it.
     */
    addReferenceToMap: async (text: string, citingPaperId: string, fromMapId: string): Promise<AddToMapOutcome> => {
      if (!citingPaperId) return { ok: false, reason: 'Open the paper from your library first.' }
      const ms = await maps()
      const all = await ms.list()
      const map = all.find((m) => m.id === fromMapId && mapContains(m, citingPaperId)) ?? all.find((m) => mapContains(m, citingPaperId))
      if (!map) return { ok: false, reason: 'This paper is on no map yet. Add it to a map first (Maps → Add paper).' }
      const outcome = await resolver.resolveReference(text)
      const known = outcome.paper
      const title = known?.title || (outcome.ok ? '' : outcome.searchText) || text.slice(0, 120)
      const libraryId = await findInLibrary(known, title)
      const id = libraryId || (known && (known.arxiv || known.doi)
        ? paperIdFor(known.arxiv, known.doi)
        : `ref:${createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 12)}`)
      if (id === citingPaperId) return { ok: false, reason: 'That reference is this paper.' }
      if (mapContains(map, id)) return { ok: true, title, mapName: map.name, already: true }
      const st = await store()
      const citing = (await st.get(citingPaperId))?.meta
      const libMeta = libraryId ? (await st.get(libraryId))?.meta : undefined
      const when = { year: known?.year ?? libMeta?.year ?? null, arxiv: known?.arxiv || libMeta?.arxiv || '', text }
      let next = suggestReferenceEdge(map, id, when, citingPaperId, citing ?? {})
      if (!libraryId) next = { ...next, nodes: next.nodes.map((n) => (n.paperId === id ? { ...n, title } : n)) }
      await ms.save(next)
      return { ok: true, title, mapName: map.name, already: false }
    },
    searchWeb: async (text: string) => {
      const template = (await settings.get()).searchUrlTemplate
      const url = template.replace('{q}', encodeURIComponent(text))
      if (process.env.PAPER_READER_FAKE_NET) {
        await writeAtomic(join(app.getPath('userData'), 'last-search.txt'), url)
        return
      }
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
    },
    openExternal: async (url: string) => {
      if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
    },

    logUsage: async (events: UsageEvent[]) => {
      // The setting is checked here too, so nothing is written once logging is off.
      if (!(await settings.get()).usageLog || !Array.isArray(events)) return
      await usageLog.append(events.filter((e) => e && typeof e.ms === 'number' && typeof e.type === 'string'))
    },
    usageLogFolder: () => usageLog.dir,
    openUsageLogFolder: async () => {
      await fs.mkdir(usageLog.dir, { recursive: true })
      await shell.openPath(usageLog.dir)
    },

    listMaps: async () => (await maps()).list(),
    createMap: async (name: string) => (await maps()).create(name),
    saveMap: async (map: ReadingMap) => (await maps()).save(map),
    removeMap: async (id: string) => {
      const file = (await maps()).fileOf(id)
      if (await exists(file)) await trash(file)
    }
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  return () => {
    clearInterval(purgeTimer)
    void watcher?.close()
    engine.dispose()
    mathEngine.dispose()
    for (const p of packsFor()) models.cancel(p.id)
  }
}

export type { PaperEntry }
