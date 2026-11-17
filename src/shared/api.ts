import {
  AppSettings,
  Layer,
  PaperEntry,
  PaperMeta,
  PreviewItem,
  PreviewOutcome,
  ReadingMap,
  RecognitionResult,
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

  listPapers(): Promise<PaperEntry[]>
  searchPapers(query: string): Promise<string[]>
  updatePaper(id: string, patch: Partial<PaperMeta>): Promise<PaperEntry>
  readPdf(id: string): Promise<Uint8Array>
  pathForFile(file: File): string
  pickPdf(): Promise<string | null>
  addPaperFromFile(path: string, hints: PdfHints, title?: string, details?: ManualDetails): Promise<AddOutcome>
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
