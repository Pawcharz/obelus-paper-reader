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

/**
 * One piece of a maths note's reading. `alts` are other ways to read it: the second reading's version
 * (`why: 'readings'`, the reading is uncertain there) or the paper's styled symbols (`why: 'paper'`,
 * only a suggestion). `line` marks the break between written lines.
 */
export interface MathSegment {
  tex: string
  alts?: string[]
  why?: 'readings' | 'paper'
  /** Set once you picked between the alternatives. */
  picked?: boolean
  line?: boolean
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
  /**
   * How the note was made. "typed": typed on a keyboard, with no strokes; its text is exactly what
   * was typed. Missing means handwriting.
   */
  input?: 'ink' | 'typed'
  /** A typed note's text size, in page units. Its width is `box[2]`; its height follows the text. */
  fontSize?: number
  /**
   * A handwritten note turned into a typed one keeps its ink here, out of the page's strokes, so
   * nothing written is ever lost and "Back to ink" can restore it.
   */
  hiddenInk?: Stroke[]
  /** A maths note's reading in pieces, with the uncertain ones and their alternatives. */
  math?: MathSegment[]
  /** A text note with maths inside: its words and maths spans, in reading order. The text is built from them. */
  pieces?: NotePiece[]
  /** Strokes you said are text or maths ("this is maths"), which the automatic split must follow. */
  forcedKinds?: { strokeIds: string[]; kind: 'text' | 'math' }[]
}

/** Whether a note was typed rather than handwritten. */
export function isTyped(n: Pick<MarginNote, 'input'>): boolean {
  return n.input === 'typed'
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
  /** File name, in the paper's folder, of the HTML report its PDF was made from. */
  original?: string
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
  /**
   * This computer's own identity, made on first start. Used while signed out; each computer has a
   * different one, so their notes are kept apart.
   */
  authorId: string
  displayName: string
  /**
   * The account signed in on this computer. While set, notes are kept under the account's id
   * instead, so every computer signed in to the same account shares the same notes.
   */
  account?: Account
}

/** Where an account comes from. Only Google for now; an Obelus account of its own may follow. */
export type AccountProvider = 'google'

export interface Account {
  provider: AccountProvider
  /** The provider's stable id for the person, which never changes even if the email does. */
  subject: string
  email: string
  name: string
  picture?: string
  /** ISO time of the sign-in. */
  signedInAt: string
}

/** A folder of notes under `people/` in a library, and how much it holds. */
export interface LayerOwner {
  authorId: string
  papers: number
  /** ISO time of the newest change in it. */
  lastChanged: string
  /** Whether it is the identity notes are kept under right now. */
  current: boolean
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
  /**
   * How a display equation too wide for the notes pane is shown: "wrap" breaks it onto new lines
   * at relations and operators (the default), "scroll" keeps one line that scrolls sideways.
   */
  mathLayout?: MathLayout
  /**
   * "pen": a touchscreen with an active pen; margin notes are handwritten. "pc": a mouse or trackpad
   * and a keyboard; margin notes are typed and marks are made by selecting text. Missing: chosen
   * from the computer, PC when it has no touchscreen.
   */
  mode?: AppMode
  /** Text size for new typed notes on this computer. */
  typedNoteSize?: TypedNoteSize
  /**
   * A folder that already has llama.cpp (`llama/`) and the maths model (`models/`), used instead of
   * the downloaded copy. Missing: the downloaded copy in the app's data folder.
   */
  mathModelDir?: string
  /** Whether maths written among the words of a note is found and read as maths. Missing: on. */
  findMaths?: boolean
  /** Model downloads the user answered "Not now" to; the app does not offer them again. */
  declinedModels?: ModelPackId[]
}

/** A local model the app can download: "math" (Windows, maths in notes), "text" (Linux, handwriting). */
export type ModelPackId = 'math' | 'text'

export interface ModelStatus {
  id: ModelPackId
  title: string
  purpose: string
  credit: string
  state: 'missing' | 'downloading' | 'ready' | 'error' | 'unsupported'
  /** Bytes to download (missing, downloading) or on disk (ready). */
  bytes: number
  done: number
  error?: string
  /** "folder": files set up by hand or in a chosen folder, which the app does not delete. */
  source?: 'downloaded' | 'folder'
  folder?: string
}

export type AppMode = 'pen' | 'pc'
export type TypedNoteSize = 'S' | 'M' | 'L'

export type InputMode = 'pen' | 'touch'

export type MathLayout = 'wrap' | 'scroll'

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
  /** Not read because this local model is not downloaded (the app offers it instead of an error). */
  missing?: ModelPackId
  /** Each word read, in reading order, with where it is: used to find maths inside a text note. */
  words?: RecognizedWord[]
}

/** A word of a text reading. `box` is relative to the top left of the note's strokes. */
export interface RecognizedWord {
  /** Index of the written line (splitLines order). */
  line: number
  text: string
  box?: Rect
  /** A real word: in a spell checker of a ticked language, or in the paper. */
  real?: boolean
}

/**
 * One piece of a note read as text with maths inside: a text word, a line break (text "\n"), or a
 * maths span (`math` holds its reading, `text` its LaTeX). `strokeIds` are the strokes it was read from.
 */
export interface NotePiece {
  kind: 'text' | 'math'
  text: string
  strokeIds: string[]
  math?: MathSegment[]
  /** Set while the maths model is still reading the span. */
  pending?: boolean
  /** The text/maths split was not sure about this piece, so the menu asks about it. */
  unsure?: boolean
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
