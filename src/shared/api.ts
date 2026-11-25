import {
  Account,
  AppSettings,
  LayerOwner,
  Layer,
  PaperEntry,
  PaperMeta,
  PreviewItem,
  PreviewOutcome,
  ReadingMap,
  RecognitionResult,
  ModelPackId,
  ModelStatus,
  SideNote,
  UsageEvent,
  Workspace
} from './types'

export type AddToMapOutcome =
  | { ok: true; title: string; mapName: string; already: boolean }
  | { ok: false; reason: string }

export type AddOutcome =
  | { ok: true; entry: PaperEntry; existed?: boolean }
  | { ok: false; reason: string; needsTitle?: boolean; titleGuess?: string }

export interface PdfHints {
  firstPageText: string
  titleGuess: string
  /** From the PDF's own details and first page, for the reader to check when no lookup finds it. */
  authorsGuess?: string[]
  yearGuess?: number | null
}

/** Details typed or checked by the reader for a paper no lookup found. */
export interface ManualDetails {
  authors: string[]
  year: number | null
  url: string
}

export interface AccountStatus {
  account: Account | null
  /** Whose notes are shown: the account's while signed in, else this computer's own. */
  authorId: string
  computerAuthorId: string
  /** Whether this copy of the app has a Google client to sign in with. */
  googleConfigured: boolean
  /** Where a google-oauth.json file sets one up. */
  googleClientFile: string
}

export type SignInOutcome =
  | { ok: true; settings: AppSettings; merged: number }
  | { ok: false; reason: string }

export type ChangeEvent =
  | { kind: 'notes'; folder: string }
  | { kind: 'papers' }
  | { kind: 'maps' }

/** Everything the interface can ask of the main process. */
export interface Api {
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickFolder(): Promise<string | null>
  defaultLibraryPath(): Promise<string>
  addWorkspace(path: string, name: string): Promise<Workspace>
  setActiveWorkspace(id: string): Promise<void>

  accountStatus(): Promise<AccountStatus>
  /** Opens Google's sign-in in the browser and waits for it; this computer's notes join the account's. */
  signInWithGoogle(): Promise<SignInOutcome>
  cancelSignIn(): Promise<void>
  /** Back to this computer's own identity. The account's notes stay in the library, under its id. */
  signOut(): Promise<AppSettings>
  /** Every identity with notes in the library: one per computer used signed out, one per account. */
  listLayerOwners(): Promise<LayerOwner[]>
  /** Moves those identities' notes into the current one's; returns how many papers had some. */
  mergeLayers(authorIds: string[]): Promise<number>

  listPapers(): Promise<PaperEntry[]>
  searchPapers(query: string): Promise<string[]>
  updatePaper(id: string, patch: Partial<PaperMeta>): Promise<PaperEntry>
  readPdf(id: string): Promise<Uint8Array>
  pathForFile(file: File): string
  pickPdf(): Promise<string | null>
  /**
   * Adds a paper from a PDF file. For an HTML report, `path` is the PDF convertHtml made and
   * `originalHtml` the report, which is kept beside it; a title must then be given.
   */
  addPaperFromFile(path: string, hints: PdfHints, title?: string, details?: ManualDetails, originalHtml?: string): Promise<AddOutcome>
  /** Turns an HTML report into a PDF in the cache, ready for addPaperFromFile. */
  convertHtml(path: string): Promise<{ ok: true; pdfPath: string; titleGuess: string } | { ok: false; reason: string }>
  /** Opens the HTML report a paper was made from, in the default browser. */
  openOriginal(id: string): Promise<void>
  addPaperById(text: string, stubOnly?: boolean): Promise<AddOutcome>
  fetchPdfForStub(id: string): Promise<AddOutcome>
  readFileBytes(path: string): Promise<Uint8Array>

  loadLayer(paperId: string): Promise<Layer>
  saveLayer(paperId: string, layer: Layer): Promise<void>
  saveRegionImage(paperId: string, targetId: string, png: Uint8Array): Promise<string>

  listSideNotes(paperId: string): Promise<SideNote[]>
  createSideNote(paperId: string, init: { title?: string }): Promise<SideNote>
  saveSideNote(note: SideNote): Promise<void>
  deleteSideNote(path: string): Promise<void>
  deletePaper(id: string): Promise<void>

  listRecognizers(): Promise<string[]>
  recognize(lines: number[][][], hints?: { vocabulary: string[]; preferred: string }): Promise<RecognitionResult>
  /** Reads a PNG (data: URL) of handwritten maths with the local maths model; LaTeX after cleanup. */
  recognizeMath(image: string): Promise<{ ok: boolean; latex: string; raw: string; ms: number; error?: string; missing?: boolean }>
  /** Whether maths inside notes is found and read: switched on in Settings and the maths model is there. */
  mathReady(): Promise<boolean>
  /** The local models offered on this system (none on macOS), with their download state. */
  listModels(): Promise<ModelStatus[]>
  /** Downloads a model (only after the user said yes); resolves when it is ready or failed. */
  downloadModel(id: ModelPackId): Promise<{ ok: boolean; error?: string }>
  cancelModelDownload(id: ModelPackId): Promise<void>
  removeModel(id: ModelPackId): Promise<void>
  /** Download progress and every other change of a model's state. */
  onModels(listener: (status: ModelStatus) => void): () => void

  previewReference(text: string): Promise<PreviewOutcome>
  readPreview(previewId: string): Promise<Uint8Array>
  addPreview(preview: PreviewItem, citingPaperId: string, fromMapId: string): Promise<AddOutcome>
  searchWeb(text: string): Promise<void>
  /** Adds a cited paper to the map as a suggestion, without a preview. */
  addReferenceToMap(text: string, citingPaperId: string, fromMapId: string): Promise<AddToMapOutcome>
  openExternal(url: string): Promise<void>
  /** Appends to the usage log; ignored while logging is off in the settings. */
  logUsage(events: UsageEvent[]): Promise<void>
  usageLogFolder(): Promise<string>
  openUsageLogFolder(): Promise<void>

  listMaps(): Promise<ReadingMap[]>
  createMap(name: string): Promise<ReadingMap>
  saveMap(map: ReadingMap): Promise<void>
  removeMap(id: string): Promise<void>

  onChange(listener: (event: ChangeEvent) => void): () => void
}
