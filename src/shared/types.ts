/** Data model shared by the main process, the interface and the tests. See the spec, section 8. */

export const SCHEMA_VERSION = 1

/** x, y, width, height in PDF page units with a top-left origin. Independent of zoom. */
export type Rect = [number, number, number, number]

/** x, y, pressure 0..1, milliseconds since the stroke started. */
export type InkPoint = [number, number, number, number]

export interface Stroke {
  id: string
  page: number
  points: InkPoint[]
  color: string
  width: number
  createdAt: string
  /** Set on writing, so strokes left unrecognized by a crash or quick exit can be picked up later. */
  handwriting?: boolean
}

export interface Quote {
  exact: string
  prefix: string
  suffix: string
}

export type TargetKind = 'text' | 'region' | 'page' | 'paper'
export type TargetStyle = 'underline' | 'circle' | 'selection' | 'region' | 'equation'

export interface Target {
  id: string
  kind: TargetKind
  page?: number
  quote?: Quote
  rects?: Rect[]
  style?: TargetStyle
  /** Original strokes that made this mark, kept so nothing the pen did is lost. */
  strokeIds?: string[]
  /** Path of a cropped picture of a region, relative to the author's layer folder. */
  image?: string
  /** For an equation region: its number as printed, such as "3" for "(3)". */
  equation?: string
  /** For an equation region: the circled maths as LaTeX, rebuilt from the symbol positions. */
  latex?: string
  /** For text: the quote with any maths in it written as $LaTeX$, for reading and showing. */
  display?: string
  createdAt: string
}

export type MarginNoteKind = 'note' | 'question' | 'drawing'

export interface EngineInfo {
  name: string
  recognizer: string
}

/** The same handwriting as read by one recognizer. */
export interface NoteReading {
  text: string
  recognizer: string
}

export interface MarginNote {
  id: string
  page: number
  box: Rect
  strokeIds: string[]
  text: string
  /** Alternatives for each recognized word, in reading order. */
  candidates: string[][]
  /** What other languages' recognizers read, for one-tap swapping. */
  alternatives?: NoteReading[]
  engine?: EngineInfo
  corrected: boolean
  kind: MarginNoteKind
  /** Empty means "no target": the note is about nothing specified, and nothing is guessed. */
  targetIds: string[]
  createdAt: string
  updatedAt: string
}

export interface Annotations {
  schema: number
  paperId: string
  authorId: string
  targets: Target[]
  marginNotes: MarginNote[]
}

export interface InkFile {
  schema: number
  paperId: string
  authorId: string
  strokes: Stroke[]
}

export interface Layer {
  annotations: Annotations
  ink: InkFile
}

export type ReadStatus = 'unread' | 'reading' | 'read'

export interface PaperMeta {
  id: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  arxiv: string
  doi: string
  url: string
  tags: string[]
  status: ReadStatus
  read_on: string
  added: string
  has_pdf: boolean
  /** What the paper is usually called, such as "DreamerV3"; shown instead of the title when set. */
  short_name?: string
}

/** How a paper is named on screen: its short name if it has one, else its title. */
export function paperLabel(meta: { title: string; short_name?: string }): string {
  return meta.short_name?.trim() || meta.title
}

export interface PaperEntry {
  meta: PaperMeta
  /** Absolute path of the paper's folder. */
  folder: string
}

export type SideNoteKind = 'note' | 'summary' | 'qa' | 'other'

export interface SideNote {
  id: string
  author: string
  generated_by: string
  kind: SideNoteKind | string
  targets: string[]
  created: string
  title: string
  pinned: boolean
  body: string
  /** Absolute path of the Markdown file. */
  path: string
}

export interface Workspace {
  id: string
  name: string
  path: string
}

export interface Profile {
  authorId: string
  displayName: string
}

export interface AppSettings {
  schema: number
  profile: Profile
  workspaces: Workspace[]
  activeWorkspaceId: string
  /** Name of the handwriting recognizer; empty means every installed one, keeping the best result. */
  recognizer: string
  /** The handwriting languages to choose from, such as Polish and English; empty means every installed one. Wins over `recognizer`. */
  recognizers?: string[]
  /** `{q}` is replaced by the URL-encoded search text. */
  searchUrlTemplate: string
  cacheMaxAgeDays: number
  cacheMaxBytes: number
  /** Old: blank space on each side of a page, in PDF units. Replaced by marginShare. */
  marginWidth: number
  /**
   * Writing space on each side of a page, as a share of the page width split over both sides:
   * 1 means each side is half a page wide. Only changes what is shown; notes are never cut.
   */
  marginShare: number
  /** Whether actions are written to the usage log, for studying how the app is really used. */
  usageLog: boolean
  /**
   * What writes on the page. "pen": an active pen writes and a finger scrolls, with the palm
   * ignored. "touch": a finger, the mouse or a simple stylus (seen as a finger) writes, and two
   * fingers scroll and zoom.
   */
  inputMode?: InputMode
}

export type InputMode = 'pen' | 'touch'

/** How an action was started. */
export type UsageVia = 'key' | 'pen' | 'touch' | 'mouse' | 'app'

/** One line of the usage log. */
export interface UsageEvent {
  /** Milliseconds since 1970, and the same moment as local time with its offset. */
  ms: number
  time: string
  /** Changes on every start of the app; seq orders events within it. */
  session: string
  seq: number
  /** What happened, such as "key", "click", "pen.mark", "view.page". */
  type: string
  via?: UsageVia
  [detail: string]: unknown
}

export type EdgeStatus = 'confirmed' | 'suggested'

export interface MapNode {
  paperId: string
  group?: string
  /** Shown for papers not yet in the library, so a generated map needs no lookups to display. */
  title?: string
  /**
   * What people call the paper (such as DreamerV3). Shown until the library entry has a short name
   * of its own, and copied into the library entry when the paper is added.
   */
  short_name?: string
}

export interface MapEdge {
  from: string
  to: string
  status: EdgeStatus
  reason?: string
}

export interface MapGroup {
  id: string
  title: string
  collapsed: boolean
  /** The group this one sits inside, if any. */
  parent?: string
}

export interface ReadingMap {
  schema: number
  id: string
  name: string
  nodes: MapNode[]
  edges: MapEdge[]
  groups: MapGroup[]
  /**
   * Where papers and folded groups were moved by hand, keyed by paper id or "group:<id>", in map
   * coordinates. Anything not listed is placed automatically.
   */
  positions?: Record<string, { x: number; y: number }>
}

export interface RecognitionLine {
  text: string
  candidates: string[][]
}

export interface RecognitionResult {
  ok: boolean
  text: string
  candidates: string[][]
  engine: EngineInfo
  alternatives?: NoteReading[]
  error?: string
}

/** Paper metadata found by a lookup, plus where its PDF can be fetched. */
export interface ResolvedPaper {
  title: string
  authors: string[]
  year: number | null
  venue: string
  arxiv: string
  doi: string
  url: string
  pdfUrl: string
  source: 'arxiv' | 'semantic-scholar'
}

export type ResolveOutcome =
  | { ok: true; paper: ResolvedPaper }
  | { ok: false; reason: string; searchText: string; libraryId?: string; paper?: ResolvedPaper }

export interface PreviewItem {
  previewId: string
  path: string
  paper: ResolvedPaper
}

export type PreviewOutcome =
  | { ok: true; preview: PreviewItem }
  | { ok: false; reason: string; searchText: string; libraryId?: string; paper?: ResolvedPaper }

export const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q={q}'
export const DEFAULT_CACHE_MAX_AGE_DAYS = 3
export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** Half of a standard page width on each side, the "50%" margin preset. */
export const DEFAULT_MARGIN_WIDTH = 153
