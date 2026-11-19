import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { InkPoint, MarginNote, NoteReading, PaperEntry, PreviewItem, Rect, SCHEMA_VERSION, Stroke, Target, isTyped, paperLabel, type AppMode, type InputMode, type MathLayout, type TypedNoteSize } from '../../shared/types'
import { estimateNoteHeight, fitWithNotes, placeNote, tidyMargin, typedFontSize, TYPED_MAX_WIDTH, TYPED_SIZE_FACTOR } from '../../shared/typedNotes'
import { wordsIn } from '../../shared/words'
import { findArxivId, findDoi, newId } from '../../shared/ids'
import {
  boxToRect, canExtendTarget, classifyPenTouch, classifyStroke, deleteInk, moveInk, scaleInk, strokesInLasso, clusterBox, clusterStrokes, extendTarget, fixTrailingMarks, noteToJoin, splitLines,
  isTap, isEquationCircle, readableQuote, looksLikeDrawing, makeEquationTarget, makeTextTarget, pointInRect, recentStrokesNear, strokeNear, targetAt, targetLabel, toRecognitionLines
} from '../../shared/inkLogic'
import { boundsOf, fitZoom, focusBox } from '../../shared/focus'
import { destBox } from '../../shared/linkTarget'
import { findQuote, linkPage, matchStarts, shownText } from '../../shared/textFind'
import { findCaption, floatBox, floatOf, linkLabel, markLinks } from '../../shared/floatTarget'
import { Word, buildQuote, inReferenceList, looksLikeReference, nearestWord, rectsForWords, referenceEntryAt, wordAt } from '../../shared/pageText'
import { cropRegion, loadPageData, openPdf, PageData, pageSizes, PageSize, PdfDoc, PdfLink, resolveDest } from './pdf'
import { useLayer } from './useLayer'
import { isTyping, mod, plain } from '../keys'
import { MathText, shortenMath } from '../MathText'
import { logEvent, pointerVia } from '../usageLog'
import { INK_COLOR, INK_WIDTH, LivePoint, PageController, PageView, Tool } from './PageView'
import { RightPane } from './RightPane'
import { PanelToggle, ResizeHandle, useSidebar } from '../Sidebar'
import { DetailsDialog, DetailsForm, detailsFor, patchFrom } from '../library/DetailsDialog'
import { PencilIcon } from '../icons'
import { flingStep, releaseVelocity, startFling, STOP_SPEED, TouchSample } from '../../shared/fling'

/** Pen idle time before writing is grouped and recognized. Writing added later still merges by closeness. */
/** How far a finger must move sideways during a vertical scroll before the page follows sideways. */
const RAIL_BREAK_PX = 90
const RECOGNIZE_DELAY_MS = 800
/** A tap this soon after writing right next to it is punctuation. Later taps select. */
const PUNCTUATION_MS = 1000
/** A stroke this soon after writing right next to it belongs to that writing, even over printed text. */
const CONTINUE_WRITING_MS = 4000
/** Rewriting a just-erased note this soon still links it to the mark the erased one had. */
const RELINK_AFTER_ERASE_MS = 60_000
const PAGE_GAP = 14
/** Lowest zoom: low enough that a page with 100% margins fits a narrow window. */
const MIN_ZOOM = 0.25
/** Far enough in to write small; the page on screen is redrawn sharp at any zoom. */
const MAX_ZOOM = 6
/** Following a link zooms to fit what it points at, but never further out or in than this. */
const LINK_MIN_ZOOM = 0.8
const LINK_MAX_ZOOM = 2
const PALM_WINDOW_MS = 800
/** A long touch this soon after the pen was used is a resting palm, not a request for the menu. */
const PALM_MENU_MS = 5000
/** A pen landing moves a little. These are screen pixels, so taps feel the same at any zoom. */
const TAP_MAX_PIXELS = 9
const TAP_MAX_MS = 400
const SETTLE_ZOOM_MS = 220
const SHOW_TEXT_KEY = 'paper-reader.show-text'
const PEN_SIZE_KEY = 'paper-reader.pen-size'
const SCROLL_LOCK_KEY = 'paper-reader.scrollbar-locked'
/** Pen sizes, small to large; the large one is the pen as it always was. */
const PEN_SIZES = [
  { name: 'Fine', width: INK_WIDTH * 0.5 },
  { name: 'Medium', width: INK_WIDTH * 0.75 },
  { name: 'Broad', width: INK_WIDTH }
]

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* the choice just won't be remembered */
  }
}

/** The next frame, or a short wait if the window isn't painting, as when it is covered or hidden. */
function nextFrame(run: () => void): number {
  let done = false
  const once = () => {
    if (done) return
    done = true
    run()
  }
  setTimeout(once, 50)
  return requestAnimationFrame(once)
}

const SHOW_LINKS_KEY = 'paper-reader.show-links'

/** Lines from notes to their targets are on unless turned off. */
function readShowLinks(): boolean {
  try {
    return localStorage.getItem(SHOW_LINKS_KEY) !== '0'
  } catch {
    return true
  }
}

function readShowText(): boolean {
  try {
    return localStorage.getItem(SHOW_TEXT_KEY) === '1'
  } catch {
    return false
  }
}

interface ZoomAnchor {
  page: number
  /** Units from the left and top of the page's wrapper. */
  x: number
  y: number
  clientX: number
  clientY: number
}
const MAX_VOCABULARY = 8000

export type ReaderSource =
  /** goTo opens the paper at a page (from 0); a new tick goes there again. */
  | { kind: 'paper'; entry: PaperEntry; fromMapId: string; goTo?: { page: number; tick: number } }
  | { kind: 'preview'; preview: PreviewItem; citingId: string; fromMapId: string; goTo?: { page: number; tick: number } }

interface Props {
  source: ReaderSource
  /** False while another tab is showing, so keyboard shortcuts only reach the visible paper. */
  active: boolean
  /** Writing space on each side, as a share of the page width (Settings; 1 by default). */
  marginShare: number
  inputMode: InputMode
  /** Pen mode, or PC mode: mouse and keyboard, typed margin notes (Settings). */
  mode: AppMode
  /** Text size for new typed notes on this computer. */
  typedNoteSize: TypedNoteSize
  onTypedNoteSize: (s: TypedNoteSize) => void
  onSwitchMode: (m: AppMode) => void
  /** How side notes show display equations too wide for the pane (Settings). */
  mathLayout: MathLayout
  /** Starts a reference lookup that reports back app-wide. */
  onLookUp: (text: string, citingId: string, fromMapId: string, page?: number) => void
  /** Adds a reference to the map as a suggestion, without a preview. */
  onAddToMap: (text: string, citingId: string, fromMapId: string) => void
  onPreviewAdded: (entry: PaperEntry, preview: PreviewItem) => void
  onEntryChanged: (entry: PaperEntry) => void
  notify: (message: string, action?: { label: string; run: () => void }) => void
}

/** One place Find can go to: a match in the printed text, a margin note, or a side note. */
type FindStop =
  | { kind: 'text'; page: number; rects: Rect[] }
  | { kind: 'margin'; page: number; noteId: string; y: number }
  /** The `occurrence`-th match (from 0) in a side note. */
  | { kind: 'side'; path: string; occurrence: number }

interface Menu {
  x: number
  y: number
  items: { label: string; run: () => void; testId?: string; keys?: string }[]
}

/** A typed note being written or edited: shown as an editor in its place until it is saved. */
interface Draft {
  page: number
  box: Rect
  fontSize: number
  targetIds: string[]
  text: string
  /** Editing an existing note; missing for a new one, made only when saved with text in it. */
  noteId?: string
  /** Placed automatically, so it is placed again on save if its text grew over another note. */
  auto: boolean
  /** A page mark made with the note, saved with it. */
  newTarget?: Target
  /** Where the view was, when it had to move to show the note; it goes back after saving. */
  returnTo?: { left: number; top: number }
  how: string
}

const PC_STRIP_KEY = 'paper-reader.pc-strip-seen'

export function Reader({ source, active, marginShare, inputMode, mode, typedNoteSize, onTypedNoteSize, onSwitchMode, mathLayout, onLookUp, onAddToMap, onPreviewAdded, onEntryChanged, notify }: Props) {
  const pc = mode === 'pc'
  const entry = source.kind === 'paper' ? source.entry : null
  const paperId = entry?.meta.id ?? null
  const readOnly = source.kind === 'preview'
  const { layer, layerRef, mutate, undo, redo, canUndo, canRedo, flush, undoDepth, collapseUndo, holdSaveRef } = useLayer(paperId)
  const burstDepth = useRef<number | null>(null)
  /** The note that last took the selected mark as its link. Erasing it gives the mark back, so a rewrite links too. */
  const lastLinked = useRef<{ noteId: string; targetId: string; at: number } | null>(null)
  const activeTab = useRef(active)
  activeTab.current = active

  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  /** The margin in PDF units, from the share chosen in Settings and the paper's page width. */
  const margin = Math.round(((sizes[0]?.width ?? 612) * Math.max(0, Math.min(1, marginShare))) / 2)
  const [loadError, setLoadError] = useState('')
  const [zoom, setZoom] = useState(1.3)
  const [renderZoom, setRenderZoom] = useState(1.3)
  const [pinchTick, setPinchTick] = useState(0)
  // Typed labels for handwriting are on by default in PC mode.
  const [showText, setShowText] = useState(() => (readStored(SHOW_TEXT_KEY) === null ? mode === 'pc' : readShowText()))
  const [showLinks, setShowLinks] = useState(readShowLinks)
  const [penSize, setPenSize] = useState(() => {
    const i = Number(readStored(PEN_SIZE_KEY) ?? PEN_SIZES.length - 1)
    return Number.isInteger(i) && i >= 0 && i < PEN_SIZES.length ? i : PEN_SIZES.length - 1
  })
  const penWidthRef = useRef(PEN_SIZES[penSize].width)
  penWidthRef.current = PEN_SIZES[penSize].width
  // With the scrollbar locked, a hand resting on its edge can't jump pages; fingers still scroll.
  const [scrollLocked, setScrollLocked] = useState(() => readStored(SCROLL_LOCK_KEY) === '1')
  /** The page opens fitted with its margins, so the Fit button first offers the page alone. */
  const [nextFit, setNextFit] = useState<'page' | 'margins' | 'notes'>('page')

  // ---- PC mode: selections waiting for an action, typed notes being written ----
  const [pendingSel, setPendingSelState] = useState<{ page: number; first: number; last: number } | null>(null)
  const pendingSelRef = useRef<{ page: number; first: number; last: number } | null>(null)
  const setPendingSel = useCallback((s: { page: number; first: number; last: number } | null) => { pendingSelRef.current = s; setPendingSelState(s) }, [])
  const [pendingRect, setPendingRectState] = useState<{ page: number; rect: Rect } | null>(null)
  const pendingRectRef = useRef<{ page: number; rect: Rect } | null>(null)
  const setPendingRect = useCallback((r: { page: number; rect: Rect } | null) => { pendingRectRef.current = r; setPendingRectState(r) }, [])
  /** Notes and marks chosen together with a rubber band, on one page. */
  const [chosen, setChosenState] = useState<{ page: number; ids: ReadonlySet<string> } | null>(null)
  const chosenRef = useRef<{ page: number; ids: ReadonlySet<string> } | null>(null)
  const setChosen = useCallback((c: { page: number; ids: ReadonlySet<string> } | null) => { chosenRef.current = c; setChosenState(c) }, [])
  const [draft, setDraftState] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const setDraft = useCallback((d: Draft | null) => { draftRef.current = d; setDraftState(d) }, [])
  /** The mark a click on empty space just let go of, so a double-click there still links to it. */
  const recentActive = useRef<{ id: string; at: number } | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [pcStrip, setPcStrip] = useState(() => readStored(PC_STRIP_KEY) !== '1')
  const [penOffer, setPenOffer] = useState(false)
  const penOffered = useRef(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const showTextRef = useRef(showText)
  showTextRef.current = showText
  const [tool, setToolState] = useState<Tool>('pen')
  const toolRef = useRef<Tool>('pen')
  const [activeTargetId, setActiveTargetIdState] = useState('')
  const activeRef = useRef('')
  const [selectedNoteId, setSelectedNoteIdState] = useState('')
  const selectedRef = useRef('')
  const [linkingNoteId, setLinkingState] = useState('')
  const linkingRef = useRef('')
  const [hoverNoteId, setHoverNoteId] = useState('')
  const [flashTargetId, setFlashTargetId] = useState('')
  const [linkFlash, setLinkFlash] = useState<{ key: number; byPage: Map<number, Rect[]> } | null>(null)
  /** Where the view was before following a link inside the paper, to go back to. */
  const [linkBack, setLinkBack] = useState<{ page: number; x: number; y: number } | null>(null)
  const [editingNoteId, setEditingNoteId] = useState('')
  /** A mark that was tapped. Its menu shows only while it is still the active mark. */
  const [targetMenuId, setTargetMenuId] = useState('')
  const targetMenuRef = useRef('')
  targetMenuRef.current = targetMenuId && targetMenuId === activeTargetId ? targetMenuId : ''
  const [range, setRange] = useState<[number, number]>([0, 1])
  const pane = useSidebar('notes', 400, 260, 1000)
  const [editingDetails, setEditingDetails] = useState<DetailsForm | null>(null)
  const paneOpen = pane.open
  const setPaneOpen = pane.setOpen
  const [menu, setMenu] = useState<Menu | null>(null)
  const [recognizerProblem, setRecognizerProblem] = useState('')
  const [, setDataTick] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pageData = useRef(new Map<number, PageData>())
  const loading = useRef(new Set<number>())
  const pending = useRef<Stroke[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processPendingRef = useRef<() => void>(() => undefined)
  const lastPen = useRef(0)
  const recognizeSeq = useRef(new Map<string, number>())
  const touches = useRef(new Map<number, { x: number; y: number }>())
  /** Where one finger has been during this swipe, for the speed it lifts at. */
  const swipe = useRef<{ samples: TouchSample[]; pinched: boolean; running: [number, number] | null }>({ samples: [], pinched: false, running: null })
  /** The page still moving after a swipe: its speed in px per ms, and the frame that moves it. */
  const fling = useRef<{ v: [number, number]; frame: number; last: number } | null>(null)
  const stopFling = () => {
    if (fling.current) cancelAnimationFrame(fling.current.frame)
    fling.current = null
  }
  const runFling = (v: [number, number]) => {
    const el = scrollRef.current
    if (!el) return
    stopFling()
    const tick = (now: number) => {
      const f = fling.current
      if (!f) return
      const dt = Math.min(50, now - f.last)
      f.last = now
      const s = flingStep(f.v, dt)
      const top = el.scrollTop
      const left = el.scrollLeft
      el.scrollTop = top + s.dy
      el.scrollLeft = left + s.dx
      f.v = s.v
      // Stops when slow, or at the end of the paper.
      const moved = Math.abs(el.scrollTop - top) + Math.abs(el.scrollLeft - left) > 0.01
      if (Math.hypot(...f.v) < STOP_SPEED || (!moved && Math.abs(s.dy) + Math.abs(s.dx) > 0.5)) { fling.current = null; return }
      f.frame = requestAnimationFrame(tick)
    }
    fling.current = { v, last: performance.now(), frame: requestAnimationFrame(tick) }
  }
  // The pen, the mouse wheel or a click stops a moving page too.
  useEffect(() => {
    const stop = (e: Event) => { if (!(e instanceof PointerEvent) || e.pointerType !== 'touch') stopFling() }
    window.addEventListener('pointerdown', stop, true)
    window.addEventListener('wheel', stop, true)
    return () => {
      window.removeEventListener('pointerdown', stop, true)
      window.removeEventListener('wheel', stop, true)
      stopFling()
    }
  }, [])
  const pinch = useRef<{ dist: number; zoom: number; anchor: ZoomAnchor | null } | null>(null)
  const pinchFrame = useRef<number | null>(null)
  const anchorRef = useRef<ZoomAnchor | null>(null)
  const liveRef = useRef<HTMLCanvasElement>(null)
  const liveBox = useRef({ left: 0, top: 0 })
  const penDown = useRef(false)
  const recognizeQueue = useRef(new Set<string>())
  const recognizing = useRef(false)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const docRef = useRef<PdfDoc | null>(null)
  /** Which way a one-finger scroll is locked: decided after the first few pixels. */
  const rail = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y' | 'free' }>({ x: 0, y: 0, axis: 'none' })
  const zoomLogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pageLogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loggedPage = useRef(-1)
  const pendingScroll = useRef<{ page: number; y: number } | null>(null)

  /** Ink chosen with Select ink: one page at a time. */
  const [inkSel, setInkSelState] = useState<{ page: number; ids: ReadonlySet<string> } | null>(null)
  const inkSelRef = useRef<{ page: number; ids: ReadonlySet<string> } | null>(null)
  const setInkSel = useCallback((sel: { page: number; ids: ReadonlySet<string> } | null) => { inkSelRef.current = sel; setInkSelState(sel) }, [])
  const setTool = useCallback((t: Tool) => {
    if (toolRef.current !== t) logEvent('tool', { tool: t })
    toolRef.current = t
    setToolState(t)
    if (t !== 'select') setInkSel(null)
    // Choosing another tool ends any linking in progress.
    linkingRef.current = ''
    setLinkingState('')
  }, [setInkSel])
  const setActive = useCallback((id: string) => { activeRef.current = id; setActiveTargetIdState(id) }, [])
  const setSelected = useCallback((id: string) => { selectedRef.current = id; setSelectedNoteIdState(id); if (!id) setEditingNoteId('') }, [])
  const setLinking = useCallback((id: string) => { linkingRef.current = id; setLinkingState(id) }, [])

  useEffect(() => {
    let cancelled = false
    let opened: PdfDoc | null = null
    setDoc(null)
    setSizes([])
    setLoadError('')
    pageData.current = new Map()
    loading.current = new Set()
    void (async () => {
      try {
        const bytes = source.kind === 'paper'
          ? await window.api.readPdf(source.entry.meta.id)
          : await window.api.readPreview(source.preview.previewId)
        const d = await openPdf(new Uint8Array(bytes))
        opened = d
        const s = await pageSizes(d)
        if (cancelled) { void d.loadingTask.destroy(); return }
        docRef.current = d
        setDoc(d)
        setSizes(s)
      } catch (e) {
        if (!cancelled) setLoadError(`This PDF could not be opened. ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      void opened?.loadingTask.destroy()
    }
    // Only the identity of the paper matters; metadata edits must not reload the PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === 'paper' ? source.entry.meta.id : source.preview.previewId])

  const ensurePageData = useCallback(async (index: number): Promise<PageData | null> => {
    const d = docRef.current
    if (!d) return null
    const have = pageData.current.get(index)
    if (have) return have
    if (loading.current.has(index)) return null
    loading.current.add(index)
    const data = await loadPageData(d, index)
    pageData.current.set(index, data)
    loading.current.delete(index)
    setDataTick((t) => t + 1)
    return data
  }, [])

  const offsets = useMemo(() => {
    const out: number[] = []
    let y = 0
    for (const s of sizes) { out.push(y); y += s.height * zoom + PAGE_GAP }
    return out
  }, [sizes, zoom])

  const updateRange = useCallback(() => {
    const el = scrollRef.current
    if (!el || sizes.length === 0) return
    const top = el.scrollTop
    const bottomY = top + el.clientHeight
    let first = 0
    while (first < offsets.length - 1 && offsets[first + 1] <= top) first++
    let last = first
    while (last < offsets.length - 1 && offsets[last + 1] < bottomY) last++
    // Pages off screen are only prepared ahead while they are cheap to hold.
    const buffer = zoomRef.current > 2 ? 0 : 1
    setRange((r) => {
      const next: [number, number] = [Math.max(0, first - buffer), Math.min(sizes.length - 1, last + buffer)]
      return r[0] === next[0] && r[1] === next[1] ? r : next
    })
  }, [offsets, sizes.length])

  useEffect(updateRange, [updateRange])

  useEffect(() => {
    window.addEventListener('resize', updateRange)
    return () => window.removeEventListener('resize', updateRange)
  }, [updateRange])

  // A paper opens fitted to the available width, within a readable range.
  const fitted = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (fitted.current || !el || sizes.length === 0 || !active) return
    fitted.current = true
    const shown = readOnly ? 0 : margin
    // PC mode opens at "Fit page + notes": the page and a column for typed notes.
    const z = pc && !readOnly
      ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitWithNotes(el.clientWidth - 30, sizes[0].width, margin, []).zoom))
      : Math.min(1.6, Math.max(0.7, (el.clientWidth - 40) / (sizes[0].width + shown * 2)))
    if (pc && !readOnly) { alignRef.current = 'notes'; alignLeft.current = 0 }
    setZoom(z)
    setRenderZoom(z)
    if (pc && !readOnly) requestAnimationFrame(() => requestAnimationFrame(() => alignNow()))
  }, [sizes, active, margin, readOnly])

  // Bitmaps are redrawn once a zoom settles. Until then the existing ones are stretched, as in a PDF viewer.
  useEffect(() => {
    if (zoom === renderZoom) return
    const t = setTimeout(() => setRenderZoom(zoom), SETTLE_ZOOM_MS)
    return () => clearTimeout(t)
  }, [zoom, renderZoom])

  /** After a Fit, lines the left edge of the page, or of its margin, up with the view. */
  const alignRef = useRef<'page' | 'wrap' | 'notes' | null>(null)
  /** For "Fit page + notes": the left edge in view, in page units. */
  const alignLeft = useRef(0)
  const alignNow = () => {
    const el = scrollRef.current
    const how = alignRef.current
    alignRef.current = null
    const wrap = el?.querySelector<HTMLElement>('[data-page]')
    if (!el || !how || !wrap) return
    el.scrollLeft = how === 'notes'
      ? wrap.offsetLeft + (margin + alignLeft.current) * zoomRef.current - 12
      : wrap.offsetLeft + (how === 'page' && !readOnly ? margin * zoomRef.current : 0) - 12
  }

  // Keeps the point being zoomed exactly where it was on screen.
  useLayoutEffect(() => {
    const a = anchorRef.current
    const el = scrollRef.current
    if (!a || !el) return
    anchorRef.current = null
    const wrap = el.querySelector<HTMLElement>(`[data-page="${a.page}"]`)
    if (!wrap) return
    const box = el.getBoundingClientRect()
    el.scrollLeft = wrap.offsetLeft + a.x * zoom - (a.clientX - box.left)
    el.scrollTop = wrap.offsetTop + a.y * zoom - (a.clientY - box.top)
    if (alignRef.current) alignNow()
  }, [zoom, pinchTick])

  // The stroke in progress is drawn on one screen-sized layer, whatever the zoom.
  useEffect(() => {
    const c = liveRef.current
    if (!c) return
    const sync = () => {
      const dpr = window.devicePixelRatio || 1
      c.width = Math.round(c.clientWidth * dpr)
      c.height = Math.round(c.clientHeight * dpr)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(c)
    return () => observer.disconnect()
  }, [])

  // Writing left unprocessed by a crash or a quick exit gets recognized on the next open.
  const recovered = useRef(false)
  useEffect(() => {
    if (recovered.current || !layer) return
    recovered.current = true
    const claimed = new Set([
      ...layer.annotations.marginNotes.flatMap((n) => n.strokeIds),
      ...layer.annotations.targets.flatMap((t) => t.strokeIds ?? [])
    ])
    const orphans = layer.ink.strokes.filter((s) => s.handwriting && !claimed.has(s.id))
    if (orphans.length) {
      pending.current.push(...orphans)
      timer.current = setTimeout(() => processPendingRef.current(), RECOGNIZE_DELAY_MS)
    }
  }, [layer])

  useEffect(() => {
    for (let i = range[0]; i <= range[1]; i++) void ensurePageData(i)
  }, [range, doc, ensurePageData])

  useEffect(() => {
    const p = pendingScroll.current
    const el = scrollRef.current
    if (p && el && offsets.length > p.page) {
      el.scrollTop = offsets[p.page] + p.y * zoom - 80
      pendingScroll.current = null
    }
  }, [offsets, zoom])

  const scrollTo = useCallback((page: number, y: number) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = offsets[page] + y * zoomRef.current - 80
  }, [offsets])

  const scrollToRef = useRef(scrollTo)
  scrollToRef.current = scrollTo
  // Opened at a page, as from a side-note link into another paper: go there once the pages are laid out.
  const goTo = source.goTo
  useEffect(() => {
    if (!goTo || !doc || sizes.length === 0) return
    const page = Math.min(Math.max(goTo.page, 0), sizes.length - 1)
    const t = setTimeout(() => { scrollToRef.current(page, 0); setPageInView(page) }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.tick, doc, sizes.length])

  /** Finds which point of which page is under a position on screen. */
  const anchorAt = useCallback((clientX: number, clientY: number): ZoomAnchor | null => {
    const el = scrollRef.current
    if (!el) return null
    let best: { page: number; rect: DOMRect; distance: number } | null = null
    for (const wrap of el.querySelectorAll<HTMLElement>('[data-page]')) {
      const rect = wrap.getBoundingClientRect()
      const distance = Math.max(rect.top - clientY, 0, clientY - rect.bottom)
      if (!best || distance < best.distance) best = { page: Number(wrap.dataset.page), rect, distance }
    }
    if (!best) return null
    return {
      page: best.page,
      x: (clientX - best.rect.left) / zoomRef.current,
      y: (clientY - best.rect.top) / zoomRef.current,
      clientX,
      clientY
    }
  }, [])

  /** Zooms around a screen position, or around the middle of the view if none is given. */
  const changeZoom = useCallback((next: number, focus?: { clientX: number; clientY: number }) => {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    const el = scrollRef.current
    // Wheel events can arrive faster than the screen updates. The first one sets the anchor.
    if (el && !anchorRef.current) {
      const box = el.getBoundingClientRect()
      const point = focus ?? { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }
      anchorRef.current = anchorAt(point.clientX, point.clientY)
    }
    zoomRef.current = z
    setZoom(z)
    if (zoomLogTimer.current) clearTimeout(zoomLogTimer.current)
    zoomLogTimer.current = setTimeout(() => logEvent('view.zoom', { zoom: Math.round(zoomRef.current * 100) }), 500)
  }, [anchorAt])

  /** Fits the page, or the page with its writing margins, to the width of the view. */
  const fit = useCallback((withMargins: boolean, again = true) => {
    const el = scrollRef.current
    if (!el || sizes.length === 0) return
    const shownMargin = readOnly ? 0 : margin
    const before = el.clientWidth
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (before - 30) / (sizes[0].width + (withMargins ? shownMargin * 2 : 0))))
    alignRef.current = withMargins ? 'wrap' : 'page'
    if (Math.abs(z - zoomRef.current) < 0.001) {
      alignNow()
      return
    }
    changeZoom(z)
    // Zooming in can bring up a scrollbar, which narrows the view: fit once more to that width.
    if (again) setTimeout(() => { if (scrollRef.current && scrollRef.current.clientWidth !== before) fitRef.current(withMargins, false) }, 120)
  }, [changeZoom, margin, readOnly, sizes])
  const fitRef = useRef(fit)
  fitRef.current = fit

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      changeZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { clientX: e.clientX, clientY: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [changeZoom])

  const recognizeOne = useCallback(async (noteId: string) => {
    const current = layerRef.current
    const note = current?.annotations.marginNotes.find((n) => n.id === noteId)
    if (!current || !note) return
    const strokes = current.ink.strokes.filter((s) => note.strokeIds.includes(s.id))
    if (strokes.length === 0) return
    const seq = (recognizeSeq.current.get(noteId) ?? 0) + 1
    recognizeSeq.current.set(noteId, seq)
    const vocabulary = new Set<string>()
    for (const data of pageData.current.values()) {
      for (const w of data.words) {
        if (vocabulary.size >= MAX_VOCABULARY) break
        for (const token of wordsIn(w.text)) vocabulary.add(token)
      }
    }
    const lastUsed = current.annotations.marginNotes
      .filter((n) => n.id !== noteId && n.engine?.recognizer)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .pop()?.engine?.recognizer ?? ''
    const started = Date.now()
    const result = await window.api.recognize(toRecognitionLines(strokes), { vocabulary: [...vocabulary], preferred: lastUsed })
    if (recognizeSeq.current.get(noteId) !== seq) return
    logEvent('note.recognized', {
      note: noteId, ok: result.ok, tookMs: Date.now() - started,
      chars: result.ok ? result.text.length : 0, words: result.ok ? result.text.split(/\s+/).filter(Boolean).length : 0,
      recognizer: result.ok ? result.engine?.recognizer : undefined
    })
    if (!result.ok) {
      setRecognizerProblem(result.error ?? 'Handwriting could not be recognized.')
      return
    }
    setRecognizerProblem('')
    // A "?" or "!" the recognizers missed, seen in the ink itself.
    const lines = splitLines(strokes)
    const marked = fixTrailingMarks(result.text, result.candidates, lines)
    const alternatives = result.alternatives?.map((a) => ({ ...a, text: fixTrailingMarks(a.text, [], lines).text }))
    if (marked.text !== result.text) logEvent('note.mark-fixed', { note: noteId })
    mutate((d) => {
      const n = d.annotations.marginNotes.find((x) => x.id === noteId)
      if (!n || n.corrected) return
      n.text = marked.text
      n.candidates = marked.candidates
      n.alternatives = alternatives
      // Only the first reading may decide a note is a drawing, so a choice made by hand sticks.
      const firstReading = !n.engine
      n.engine = result.engine
      if (firstReading && n.kind === 'note' && looksLikeDrawing(strokes, result.text)) n.kind = 'drawing'
      n.updatedAt = new Date().toISOString()
    }, false)
  }, [layerRef, mutate])

  /** One note at a time, with repeats merged, so recognition can never pile up behind the pen. */
  const recognizeNote = useCallback(async (noteId: string) => {
    recognizeQueue.current.add(noteId)
    if (recognizing.current) return
    recognizing.current = true
    try {
      for (;;) {
        const [next] = recognizeQueue.current
        if (next === undefined) break
        recognizeQueue.current.delete(next)
        await recognizeOne(next)
      }
    } finally {
      recognizing.current = false
    }
  }, [recognizeOne])

  const processPending = useCallback(() => {
    const strokes = pending.current
    pending.current = []
    const current = layerRef.current
    // Undo should take back a whole written note, not one pen stroke of it.
    if (burstDepth.current !== null) collapseUndo(burstDepth.current)
    burstDepth.current = null
    if (!current || strokes.length === 0) return
    const known = new Set(current.ink.strokes.map((s) => s.id))
    const live = strokes.filter((s) => known.has(s.id))
    const pages = [...new Set(live.map((s) => s.page))]
    const toRecognize: string[] = []
    const events: [string, Record<string, unknown>][] = []
    mutate((d) => {
      const now = Date.now()
      for (const page of pages) {
        for (const cluster of clusterStrokes(live.filter((s) => s.page === page), true)) {
          const ids = cluster.map((s) => s.id)
          const box = clusterBox(cluster)
          const strokeById = new Map(d.ink.strokes.map((s) => [s.id, s]))
          const fresh = new Set(ids)
          const start = Math.min(...cluster.map((s) => Date.parse(s.createdAt) || now))
          // A note's own strokes are left out of what it last wrote, so new strokes don't make it look fresh.
          const join = noteToJoin(cluster, d.annotations.marginNotes, (id) => (fresh.has(id) ? undefined : strokeById.get(id)), start)
          const nearby = join ? [join] : []
          const stamp = new Date(now).toISOString()
          if (nearby.length) {
            // New writing carries on one note; it never joins two notes into one.
            const [kept, ...absorbed] = nearby
            const boxes = [...nearby.map((n) => n.box), boxToRect(box)]
            const x0 = Math.min(...boxes.map((b) => b[0]))
            const y0 = Math.min(...boxes.map((b) => b[1]))
            const x1 = Math.max(...boxes.map((b) => b[0] + b[2]))
            const y1 = Math.max(...boxes.map((b) => b[1] + b[3]))
            kept.box = [x0, y0, x1 - x0, y1 - y0]
            kept.strokeIds = [...nearby.flatMap((n) => n.strokeIds), ...ids]
            kept.targetIds = [...new Set(nearby.flatMap((n) => n.targetIds))]
            if (activeRef.current && !kept.targetIds.includes(activeRef.current)) {
              kept.targetIds = [...kept.targetIds, activeRef.current]
              lastLinked.current = { noteId: kept.id, targetId: activeRef.current, at: now }
            }
            if (activeRef.current) {
              activeRef.current = ''
              setActiveTargetIdState('')
            }
            kept.updatedAt = stamp
            const gone = new Set(absorbed.map((n) => n.id))
            d.annotations.marginNotes = d.annotations.marginNotes.filter((n) => !gone.has(n.id))
            toRecognize.push(kept.id)
            events.push(['note.extend', { note: kept.id, page, strokes: ids.length, merged: absorbed.length, linked: kept.targetIds.length, box: kept.box.map(Math.round) }])
          } else if (Math.max(box.x1 - box.x0, box.y1 - box.y0) <= (TAP_MAX_PIXELS * 1.5) / zoomRef.current) {
            // A speck on its own, from a slip of the pen, is not a note: it goes.
            const gone = new Set(ids)
            d.ink.strokes = d.ink.strokes.filter((s) => !gone.has(s.id))
            events.push(['stroke.dropped', { page, strokes: ids.length, size: Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0)) }])
          } else {
            const targetIds: string[] = []
            const noteId = newId('m')
            if (activeRef.current) {
              targetIds.push(activeRef.current)
              lastLinked.current = { noteId, targetId: activeRef.current, at: now }
              activeRef.current = ''
              setActiveTargetIdState('')
            }
            const note: MarginNote = {
              id: noteId, page, box: boxToRect(box), strokeIds: ids, text: '', candidates: [],
              corrected: false, kind: 'note', targetIds, createdAt: stamp, updatedAt: stamp
            }
            d.annotations.marginNotes.push(note)
            toRecognize.push(note.id)
            events.push(['note.create', { note: note.id, page, strokes: ids.length, linked: targetIds.length, box: note.box.map(Math.round) }])
          }
        }
      }
    }, false)
    for (const [type, detail] of events) logEvent(type, detail)
    for (const id of toRecognize) void recognizeNote(id)
  }, [collapseUndo, layerRef, mutate, recognizeNote])

  processPendingRef.current = processPending

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(processPending, RECOGNIZE_DELAY_MS)
  }, [processPending])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    processPending()
    flush()
  }, [processPending, flush])

  const attachTarget = useCallback((d: { annotations: { marginNotes: MarginNote[] } }, noteId: string, targetId: string) => {
    const n = d.annotations.marginNotes.find((x) => x.id === noteId)
    if (n && !n.targetIds.includes(targetId)) n.targetIds = [...n.targetIds, targetId]
  }, [])

  /** The next mark links to the note being linked; otherwise it becomes the active target. */
  const addTarget = useCallback((target: Target, stroke?: Stroke, extend = true) => {
    // Writing done before this mark belongs to the previous one.
    if (pending.current.length) {
      if (timer.current) clearTimeout(timer.current)
      processPending()
    }
    let becameId = target.id
    mutate((d) => {
      if (stroke) d.ink.strokes.push(stroke)
      const active = d.annotations.targets.find((t) => t.id === activeRef.current)
      const activeIds = new Set(active?.strokeIds ?? [])
      const lastDrawn = Math.max(
        Date.parse(active?.createdAt ?? '') || 0,
        ...d.ink.strokes.filter((s) => activeIds.has(s.id)).map((s) => Date.parse(s.createdAt) || 0)
      )
      // A mark made with the mouse never joins another by timing.
      if (extend && active && canExtendTarget(active, target, Date.parse(target.createdAt) - lastDrawn)) {
        Object.assign(active, extendTarget(active, target))
        becameId = active.id
        return
      }
      d.annotations.targets.push(target)
      if (linkingRef.current) attachTarget(d, linkingRef.current, target.id)
    })
    logEvent('mark', {
      style: target.style ?? target.kind, page: target.page, via: pointerVia(), mark: becameId,
      ...(becameId !== target.id ? { extended: true } : {}),
      ...(linkingRef.current ? { linksNote: linkingRef.current } : {}),
      ...(target.equation ? { equation: target.equation } : {})
    })
    if (linkingRef.current) {
      setLinking('')
      setActive('')
    } else {
      setActive(becameId)
    }
  }, [attachTarget, mutate, processPending, setActive, setLinking])

  /** Saves a picture of a region or equation next to the notes, so Claude can read it. */
  const savePicture = useCallback((target: Target) => {
    const d = docRef.current
    const rect = target.rects?.[0]
    if (!d || !paperId || !rect || target.page === undefined) return
    void cropRegion(d, target.page, rect)
      .then((png) => window.api.saveRegionImage(paperId, target.id, png))
      .then((image) => mutate((draft) => {
        const t = draft.annotations.targets.find((x) => x.id === target.id)
        if (t) t.image = image
      }, false))
      .catch(() => undefined)
  }, [mutate, paperId])

  /**
   * A link inside the paper (an equation, a figure, a section) puts what it points at in the middle
   * of the view, at the same zoom, and flashes it. A Back button then returns to where you were.
   */
  const followLink = async (link: PdfLink) => {
    if (link.url) { void window.api.openExternal(link.url); return }
    const d = docRef.current
    if (!d || !link.dest) return
    const dest = await resolveDest(d, link.dest)
    if (!dest) { notify('This link could not be followed.'); return }
    const el = scrollRef.current
    if (el) {
      const v = el.getBoundingClientRect()
      const here = anchorAt(v.left + el.clientWidth / 2, v.top + el.clientHeight / 2)
      if (here) setLinkBack({ page: here.page, x: here.x, y: here.y })
    }
    // A figure, table or algorithm is shown whole, found by its caption, since the link itself
    // often points at the page's top or below the float. Anything else: the line it points at.
    let page = dest.page
    let box: Rect | null = null
    const named = floatOf(labelOf(link))
    if (named) {
      for (const p of [dest.page, dest.page - 1, dest.page + 1]) {
        if (p < 0 || p >= sizes.length) continue
        const pw = (await ensurePageData(p) ?? pageData.current.get(p))?.words ?? []
        const cap = findCaption(pw, named.kind, named.num, dest.y ?? 0)
        if (!cap) continue
        box = floatBox(pw, named.kind, cap, sizes[p].height, p === dest.page ? dest.y : null)
        page = p
        break
      }
    }
    if (!box) {
      const data = await ensurePageData(dest.page) ?? pageData.current.get(dest.page)
      box = destBox(data?.words ?? [], dest.x, dest.y ?? 0)
    }
    // A float taller than the view shows from its top.
    const viewH = (scrollRef.current?.clientHeight ?? 0) / zoomRef.current
    const cy = box[3] > viewH * 0.9 ? box[1] + viewH * 0.45 : box[1] + box[3] / 2
    centreOn(page, box[0] + box[2] / 2 + (readOnly ? 0 : margin), cy)
    flashBoxes(new Map([[page, [box]]]))
    logEvent('link.follow', { page, kind: named?.kind ?? 'line' })
  }

  /** The words a link covers, e.g. "Figure 2b" or "Equation 3", from the page it is on. */
  const labelOf = (link: PdfLink): string => {
    for (const data of pageData.current.values()) {
      if (data.links.includes(link)) return linkLabel(data.words, link.rect)
    }
    return ''
  }

  /** Scrolls so a point of a page (in page units, margin included) is in the middle of the view. */
  const centreOn = (page: number, x: number, y: number) => {
    const el = scrollRef.current
    const wrap = el?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!el || !wrap) return
    const z = zoomRef.current
    el.scrollLeft = wrap.offsetLeft + x * z - el.clientWidth / 2
    el.scrollTop = wrap.offsetTop + y * z - el.clientHeight / 2
  }

  /** The lookup runs app-wide, so it keeps going and reports back while other tabs are in use. */
  const lookUpReference = useCallback(async (text: string, page?: number) => {
    onLookUp(text, paperId ?? (source.kind === 'preview' ? source.citingId : ''), source.fromMapId, page)
  }, [onLookUp, paperId, source])

  const addReferenceToMap = useCallback((text: string) => {
    onAddToMap(text, paperId ?? (source.kind === 'preview' ? source.citingId : ''), source.fromMapId)
  }, [onAddToMap, paperId, source])

  /** The reference entry a citation link points to, in the bibliography. */
  const referenceFromLink = useCallback(async (link: PdfLink): Promise<string | null> => {
    const d = docRef.current
    if (!d || !link.dest) return null
    const dest = await resolveDest(d, link.dest)
    if (!dest) { notify('This link could not be followed.'); return null }
    const data = await ensurePageData(dest.page) ?? pageData.current.get(dest.page)
    if (!data) return null
    return referenceEntryAt(data.words, dest.x, dest.y)
  }, [ensurePageData, notify])

  const previewFromLink = useCallback(async (link: PdfLink) => {
    const text = await referenceFromLink(link)
    if (text !== null) await lookUpReference(text)
  }, [lookUpReference, referenceFromLink])

  /** When note areas overlap, the smallest one is the one that was meant. */
  const noteAt = useCallback((page: number, x: number, y: number): MarginNote | undefined => {
    let best: MarginNote | undefined
    for (const n of layerRef.current?.annotations.marginNotes ?? []) {
      if (n.page !== page || !pointInRect(n.box, x, y, 4)) continue
      if (!best || n.box[2] * n.box[3] < best.box[2] * best.box[3]) best = n
    }
    return best
  }, [layerRef])

  const clearLive = useCallback(() => {
    const c = liveRef.current
    c?.getContext('2d', { desynchronized: true })?.clearRect(0, 0, c.width, c.height)
  }, [])

  const endStroke = useCallback(() => {
    penDown.current = false
    holdSaveRef.current = false
    // Two frames, so the finished stroke is on the page layer before this copy disappears.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!penDown.current) clearLive()
    }))
  }, [clearLive, holdSaveRef])

  const ctl = useRef<PageController>(null as unknown as PageController)
  const words = (page: number): Word[] => pageData.current.get(page)?.words ?? []

  const handleTap = (page: number, x: number, y: number): boolean => {
    const annotations = layerRef.current?.annotations
    // A click anywhere ends a selection waiting for an action, and a rubber-band choice.
    if (pendingSelRef.current) setPendingSel(null)
    if (pendingRectRef.current) setPendingRect(null)
    if (chosenRef.current) setChosen(null)
    const target = annotations ? targetAt(annotations.targets, page, x, y) : undefined
    if (linkingRef.current) {
      // A tap on a mark links it. A tap anywhere else cancels, so no key is ever needed.
      if (target) {
        const noteId = linkingRef.current
        mutate((d) => attachTarget(d, noteId, target.id))
        logEvent('note.link', { note: noteId, mark: target.id, how: 'tap', via: pointerVia() })
      } else logEvent('tap', { hit: 'empty', ends: 'linking', page, via: pointerVia() })
      setLinking('')
      return true
    }
    const note = noteAt(page, x, y)
    if (note) { logEvent('tap', { hit: 'note', note: note.id, page, via: pointerVia() }); setSelected(note.id); setActive(''); return true }
    const link = pageData.current.get(page)?.links.find((l) => pointInRect(l.rect, x, y))
    // A mark with enough text that is not a link: a tap on one of its links is for the link, a tap
    // elsewhere for the mark. A mark that is nearly all links: any tap opens the mark's menu, which
    // then lists its links too.
    const forLink = !!(target && link && !markLinks(words(page), pageData.current.get(page)?.links ?? [], target.rects ?? []).mostlyLinks)
    if (target && !forLink) { logEvent('tap', { hit: 'mark', mark: target.id, page, via: pointerVia() }); setActive(target.id); setTargetMenuId(target.id); setSelected(''); return true }
    // A tap on a link asks what to do, so a citation can be previewed with a finger or the pen tip.
    if (link) {
      logEvent('tap', { hit: link.url ? 'web link' : 'citation', page, via: pointerVia() })
      const wrap = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`)
      const r = wrap?.getBoundingClientRect()
      if (r) ctl.current.contextMenu(page, x, y, r.left + (x + margin) * zoomRef.current, r.top + y * zoomRef.current)
      return true
    }
    if (activeRef.current || selectedRef.current) {
      logEvent('tap', { hit: 'empty', ends: 'selection', page, via: pointerVia() })
      if (activeRef.current) recentActive.current = { id: activeRef.current, at: Date.now() }
      setActive('')
      setSelected('')
      return true
    }
    logEvent('tap', { hit: 'empty', page, via: pointerVia() })
    return false
  }

  const eraseSnapshot = useRef(false)
  const removeNote = (d: Parameters<Parameters<typeof mutate>[0]>[0], noteId: string) => {
    const n = d.annotations.marginNotes.find((x) => x.id === noteId)
    if (!n) return
    d.annotations.marginNotes = d.annotations.marginNotes.filter((x) => x.id !== noteId)
    const ids = new Set(n.strokeIds)
    d.ink.strokes = d.ink.strokes.filter((s) => !ids.has(s.id))
  }
  const removeTarget = (d: Parameters<Parameters<typeof mutate>[0]>[0], targetId: string) => {
    const t = d.annotations.targets.find((x) => x.id === targetId)
    if (!t) return
    d.annotations.targets = d.annotations.targets.filter((x) => x.id !== targetId)
    d.annotations.marginNotes = d.annotations.marginNotes.map((n) => ({ ...n, targetIds: n.targetIds.filter((id) => id !== targetId) }))
    const ids = new Set(t.strokeIds ?? [])
    d.ink.strokes = d.ink.strokes.filter((s) => !ids.has(s.id))
  }

  /**
   * The eraser takes out only the line of a mark it touches. If that leaves a gap, the rest
   * becomes two marks, both still linked to the same notes.
   */
  const eraseTargetLine = (d: Parameters<Parameters<typeof mutate>[0]>[0], targetId: string, page: number, x: number, y: number) => {
    const t = d.annotations.targets.find((tt) => tt.id === targetId)
    const rects = [...(t?.rects ?? [])].sort((a, b) => a[1] - b[1])
    const hit = rects.findIndex((r) => pointInRect(r, x, y, 2))
    if (!t || t.kind !== 'text' || rects.length < 2 || hit < 0) {
      removeTarget(d, targetId)
      return
    }
    const runs: Rect[][] = []
    for (const r of rects.filter((_, i) => i !== hit)) {
      const run = runs[runs.length - 1]
      const last = run?.[run.length - 1]
      if (last && r[1] - last[1] < last[3] * 2.2) run.push(r)
      else runs.push([r])
    }
    const pageWords = words(page)
    // What is left of the mark quotes only the words still marked, both as plain text and as the
    // readable version with maths, which is what its label shows.
    const textFor = (run: Rect[]): Pick<Target, 'quote' | 'display'> => {
      const inside = pageWords.filter((w) => run.some((r) => pointInRect(r, w.rect[0] + w.rect[2] / 2, w.rect[1] + w.rect[3] / 2, 1)))
      if (inside.length === 0) return { quote: t.quote, display: undefined }
      const first = Math.min(...inside.map((w) => w.index))
      const last = Math.max(...inside.map((w) => w.index))
      return { quote: buildQuote(pageWords, first, last), display: readableQuote(pageWords, first, last) }
    }
    const original = { ...t }
    t.rects = runs[0]
    const kept = textFor(runs[0])
    t.quote = kept.quote
    if (kept.display) t.display = kept.display
    else delete t.display
    for (const run of runs.slice(1)) {
      const { quote, display } = textFor(run)
      const { display: _old, ...rest } = original
      const extra: Target = { ...rest, id: newId('t'), rects: run, quote, ...(display ? { display } : {}), strokeIds: [] }
      d.annotations.targets.push(extra)
      for (const n of d.annotations.marginNotes) {
        if (n.targetIds.includes(t.id)) n.targetIds = [...n.targetIds, extra.id]
      }
    }
  }

  // ---- PC mode: marks from selections and rectangles, typed margin notes ----

  /** This computer's default view, "Fit page + notes", which sets the size of new typed notes. */
  const defaultZoom = (): number => {
    const el = scrollRef.current
    if (!el || sizes.length === 0) return zoomRef.current
    return fitWithNotes(el.clientWidth - 30, sizes[0].width, margin, []).zoom
  }

  /** The part of a page and its margins in view, in page units, and the middle of the view. */
  const viewOf = (page: number): { x0: number; x1: number; cy: number } | null => {
    const el = scrollRef.current
    const wrap = el?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    if (!el || !wrap) return null
    const w = wrap.getBoundingClientRect()
    const v = el.getBoundingClientRect()
    const z = zoomRef.current
    return { x0: (v.left - w.left) / z - margin, x1: (v.left + el.clientWidth - w.left) / z - margin, cy: (v.top + el.clientHeight / 2 - w.top) / z }
  }

  /** A rectangle becomes a region, or an equation box when it is drawn round displayed maths. */
  const makeRegion = (page: number, rect: Rect): Target | null => {
    if (readOnly || rect[2] < 8 || rect[3] < 8) return null
    const stamp = new Date().toISOString()
    const pw = words(page)
    const inside = pw.filter((w) => pointInRect(rect, w.rect[0] + w.rect[2] / 2, w.rect[1] + w.rect[3] / 2))
    const target: Target = inside.length && isEquationCircle(inside, pw)
      ? makeEquationTarget(newId('t'), page, pw, { words: inside, rects: inside.map((w) => w.rect) }, [], stamp)
      : { id: newId('t'), kind: 'region', page, rects: [rect], style: 'region', createdAt: stamp }
    addTarget(target, undefined, false)
    setTool('pen')
    setPendingRect(null)
    savePicture(target)
    return target
  }

  /** Marks the selected words; returns the mark. */
  const markPending = (): Target | null => {
    const s = pendingSelRef.current
    if (!s || readOnly) return null
    const pw = words(s.page)
    const display = readableQuote(pw, s.first, s.last)
    const target: Target = {
      id: newId('t'), kind: 'text', page: s.page, quote: buildQuote(pw, s.first, s.last), ...(display ? { display } : {}),
      rects: rectsForWords(pw.slice(s.first, s.last + 1)), style: 'selection', createdAt: new Date().toISOString()
    }
    setPendingSel(null)
    addTarget(target, undefined, false)
    return target
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('Copied.')
    } catch {
      notify('Could not copy.')
    }
  }

  /** Opens the editor for a new typed note. Nothing is saved until it has text. */
  const startDraft = (page: number, box: Rect, targetIds: string[], how: string, auto: boolean, extra: Partial<Draft> = {}) => {
    if (readOnly) { notify('A preview cannot be annotated. Add it to the library first.'); return }
    commitDraft()
    setSelected('')
    setPendingSel(null)
    setPendingRect(null)
    setDraft({ page, box, fontSize: typedFontSize(defaultZoom(), typedNoteSize), targetIds, text: '', auto, how, ...extra })
  }

  const newNoteWidth = () => Math.min(TYPED_MAX_WIDTH, Math.max(60, margin - 12))

  /** A new typed note placed beside what it is about, in a margin in view when there is room. */
  const placeAndStart = (page: number, targetIds: string[], markRects: Rect[] | undefined, how: string, text = '') => {
    const size = sizes[page]
    if (!size) return
    const fs = typedFontSize(defaultZoom(), typedNoteSize)
    const width = newNoteWidth()
    const view = viewOf(page)
    const others = (layerRef.current?.annotations.marginNotes ?? []).filter((n) => n.page === page).map((n) => n.box)
    const placed = placeNote({
      pageWidth: size.width, pageHeight: size.height, margin, others, markRects, y: view?.cy, width,
      height: estimateNoteHeight(text, width, fs, 3), view: view ?? undefined
    })
    if (!placed.fits) notify('No room here. Drag the note, or right-click the page and choose Tidy margin.')
    const el = scrollRef.current
    const returnTo = placed.outOfView && el ? { left: el.scrollLeft, top: el.scrollTop } : undefined
    startDraft(page, placed.box, targetIds, how, true, { returnTo, text })
    if (placed.outOfView) centreOn(page, placed.box[0] + margin + placed.box[2] / 2, placed.box[1] + placed.box[3] / 2)
  }

  const noteForTarget = (t: Target) => {
    if (t.page === undefined) return
    setActive(t.id)
    placeAndStart(t.page, [t.id], t.rects, 'mark')
  }

  /** Marks the selection and opens a typed note about it. */
  const noteForPending = () => {
    const t = markPending()
    if (t) noteForTarget(t)
  }

  /** N: a note about the selection, or the active mark, or about nothing in particular. */
  const noteFromKeys = () => {
    if (pendingSelRef.current) { noteForPending(); return }
    if (pendingRectRef.current) {
      const r = pendingRectRef.current
      const t = makeRegion(r.page, r.rect)
      if (t) noteForTarget(t)
      return
    }
    const t = layerRef.current?.annotations.targets.find((x) => x.id === activeRef.current)
    if (t && t.rects?.length) { noteForTarget(t); return }
    placeAndStart(currentPage(), [], undefined, 'keys')
  }

  /** A typed note at a point: by double-click, or from the right-click menu. */
  const newNoteAt = (page: number, x: number, y: number, targetIds: string[], how: string, newTarget?: Target) => {
    const size = sizes[page]
    if (!size) return
    const width = newNoteWidth()
    const fs = typedFontSize(defaultZoom(), typedNoteSize)
    const h = estimateNoteHeight('', width, fs, 1)
    const x0 = x < 0 ? Math.max(-margin + 4, Math.min(x, -4 - width)) : Math.min(x, size.width + margin - 4 - width)
    const y0 = Math.min(Math.max(4, y - h / 2), size.height - h - 4)
    startDraft(page, [x0, y0, width, h], targetIds, how, false, newTarget ? { newTarget } : {})
  }

  const openEditor = (n: MarginNote) => {
    if (readOnly) return
    if (!isTyped(n)) { setSelected(n.id); setEditingNoteId(n.id); return }
    commitDraft()
    setSelected('')
    setDraft({ page: n.page, box: n.box, fontSize: n.fontSize ?? typedFontSize(defaultZoom(), typedNoteSize), targetIds: n.targetIds, text: n.text, noteId: n.id, auto: false, how: 'edit' })
  }

  /** Saves the note being typed: Enter, Esc, clicking away. An empty note is never kept. */
  const commitDraft = () => {
    const d = draftRef.current
    if (!d) return
    setDraft(null)
    const text = d.text.replace(/\s+$/, '')
    const stamp = new Date().toISOString()
    const kind: MarginNote['kind'] = /^\s*[?？]+\s*$/.test(text) ? 'question' : 'note'
    if (d.noteId) {
      const old = layerRef.current?.annotations.marginNotes.find((n) => n.id === d.noteId)
      if (!old) return
      if (!text.trim()) deleteNote(d.noteId)
      else if (text !== old.text || d.targetIds.join() !== old.targetIds.join()) {
        mutate((doc) => {
          const n = doc.annotations.marginNotes.find((m) => m.id === d.noteId)
          if (n) Object.assign(n, { text, kind, targetIds: d.targetIds, updatedAt: stamp })
        })
        logEvent('note.edit', { note: d.noteId, input: 'typed', chars: text.length, before: old.text.length })
      }
    } else if (text.trim()) {
      const size = sizes[d.page]
      let box: Rect = [d.box[0], d.box[1], d.box[2], estimateNoteHeight(text, d.box[2], d.fontSize)]
      // Placed with room for three lines; if the text grew over another note, it is placed again.
      if (d.auto && size) {
        const others = (layerRef.current?.annotations.marginNotes ?? []).filter((n) => n.page === d.page).map((n) => n.box)
        const hits = others.some((o) => o[0] < box[0] + box[2] && box[0] < o[0] + o[2] && o[1] < box[1] + box[3] && box[1] < o[1] + o[3])
        if (hits) {
          const marks = (layerRef.current?.annotations.targets ?? []).filter((t) => d.targetIds.includes(t.id)).flatMap((t) => (t.page === d.page ? t.rects ?? [] : []))
          const again = placeNote({ pageWidth: size.width, pageHeight: size.height, margin, others, markRects: marks, y: box[1], width: box[2], height: box[3] })
          if (again.fits) box = [again.box[0], again.box[1], box[2], box[3]]
        }
      }
      const id = newId('m')
      mutate((doc) => {
        if (d.newTarget) doc.annotations.targets.push(d.newTarget)
        doc.annotations.marginNotes.push({
          id, page: d.page, box, strokeIds: [], text, candidates: [], corrected: false, kind,
          targetIds: d.targetIds, createdAt: stamp, updatedAt: stamp, input: 'typed', fontSize: d.fontSize
        })
      })
      logEvent('note.create', { note: id, input: 'typed', placement: d.how, page: d.page, linked: d.targetIds.length, chars: text.length })
    }
    const el = scrollRef.current
    if (d.returnTo && el) { el.scrollLeft = d.returnTo.left; el.scrollTop = d.returnTo.top }
    // Nothing stays selected, so the arrow keys go back to turning pages.
    setSelected('')
    setActive('')
  }
  const commitDraftRef = useRef(commitDraft)
  commitDraftRef.current = commitDraft

  /** Re-stacks a page's notes in the order of what they are about; one Undo puts them back. */
  const tidyPage = (page: number) => {
    const size = sizes[page]
    const a = layerRef.current?.annotations
    if (!size || !a) return
    const moves = tidyMargin(a.marginNotes.filter((n) => n.page === page), a.targets, size.width, size.height)
    if (moves.size === 0) { notify('The margin is already tidy.'); return }
    mutate((d) => {
      for (const n of d.annotations.marginNotes) {
        const box = moves.get(n.id)
        if (!box) continue
        const dy = box[1] - n.box[1]
        n.box = box
        const ids = new Set(n.strokeIds)
        if (ids.size) d.ink.strokes = d.ink.strokes.map((s) => (ids.has(s.id) ? { ...s, points: s.points.map(([x, y, pr, t]) => [x, Math.round((y + dy) * 100) / 100, pr, t] as InkPoint) } : s))
      }
    })
    logEvent('margin.tidy', { page, moved: moves.size })
  }

  /** Handwriting becomes a typed note with the same text and links; its ink is kept inside the note. */
  const convertToTyped = (id: string) => {
    const fs = typedFontSize(defaultZoom(), typedNoteSize)
    mutate((d) => {
      const n = d.annotations.marginNotes.find((m) => m.id === id)
      if (!n || isTyped(n)) return
      const ids = new Set(n.strokeIds)
      n.hiddenInk = d.ink.strokes.filter((s) => ids.has(s.id))
      d.ink.strokes = d.ink.strokes.filter((s) => !ids.has(s.id))
      n.strokeIds = []
      n.input = 'typed'
      n.fontSize = fs
      const w = Math.max(n.box[2], 60)
      n.box = [n.box[0], n.box[1], w, estimateNoteHeight(n.text, w, fs)]
      n.updatedAt = new Date().toISOString()
    })
    setSelected('')
    logEvent('note.convert', { note: id, to: 'typed' })
  }

  const backToInk = (id: string) => {
    mutate((d) => {
      const n = d.annotations.marginNotes.find((m) => m.id === id)
      if (!n?.hiddenInk?.length) return
      d.ink.strokes.push(...n.hiddenInk)
      n.strokeIds = n.hiddenInk.map((s) => s.id)
      n.box = boxToRect(clusterBox(n.hiddenInk))
      delete n.hiddenInk
      delete n.input
      delete n.fontSize
      n.updatedAt = new Date().toISOString()
    })
    setSelected('')
    logEvent('note.convert', { note: id, to: 'ink' })
  }

  const resizeTyped = (id: string, factor: number) => mutate((d) => {
    const n = d.annotations.marginNotes.find((m) => m.id === id)
    if (!n || !isTyped(n)) return
    n.fontSize = Math.round((n.fontSize ?? 10) * factor * 10) / 10
    n.updatedAt = new Date().toISOString()
  })

  const noteMenuItems = (n: MarginNote): Menu['items'] => {
    const common: Menu['items'] = [
      { label: 'Link…', keys: 'Ctrl+K', testId: 'menu-note-link', run: () => setLinking(n.id) },
      { label: 'This page', run: () => linkWhole(n.id, 'page', n.page) },
      { label: 'Whole paper', run: () => linkWhole(n.id, 'paper', n.page) }
    ]
    if (isTyped(n)) {
      return [
        { label: 'Edit', keys: 'Enter', testId: 'menu-note-edit', run: () => openEditor(n) },
        ...common,
        { label: 'Smaller', run: () => resizeTyped(n.id, 1 / 1.15) },
        { label: 'Larger', run: () => resizeTyped(n.id, 1.15) },
        { label: 'Copy text', run: () => void copyText(n.text) },
        ...(n.hiddenInk?.length ? [{ label: 'Back to ink', testId: 'menu-back-to-ink', run: () => backToInk(n.id) }] : []),
        { label: 'Delete', keys: 'Del', testId: 'menu-note-delete', run: () => deleteNote(n.id) }
      ]
    }
    return [
      { label: 'Edit text', keys: 'Enter', testId: 'menu-note-edit', run: () => openEditor(n) },
      ...common,
      { label: 'Convert to typed note', testId: 'menu-convert-typed', run: () => convertToTyped(n.id) },
      { label: 'Delete', keys: 'Del', testId: 'menu-note-delete', run: () => deleteNote(n.id) }
    ]
  }

  /** A double-click with the mouse: a note to edit, a word to select, or a new typed note on blank space. */
  const onDoubleClick = (page: number, x: number, y: number) => {
    const note = noteAt(page, x, y)
    if (note) { openEditor(note); return }
    const pw = words(page)
    const size = sizes[page]
    const onPage = !!size && x >= 0 && x <= size.width
    const word = onPage ? wordAt(pw, x, y, 2) : null
    if (word) {
      setActive('')
      setPendingSel({ page, first: word.index, last: word.index })
      return
    }
    if (readOnly) { notify('A preview cannot be annotated. Add it to the library first.'); return }
    // The first click let go of the active mark; the double-click still links to it.
    const recent = recentActive.current
    const linkTo = activeRef.current || (recent && Date.now() - recent.at < 700 ? recent.id : '')
    recentActive.current = null
    newNoteAt(page, x, y, linkTo ? [linkTo] : [], 'dblclick')
  }

  /** Grows or shrinks the active text mark from the keyboard. */
  const extendActive = (how: 'word+' | 'word-' | 'line+' | 'line-' | 'sentence'): boolean => {
    const t = layerRef.current?.annotations.targets.find((x) => x.id === activeRef.current)
    if (!t || t.kind !== 'text' || t.page === undefined) return false
    const pw = words(t.page)
    const inside = pw.filter((w) => (t.rects ?? []).some((r) => pointInRect(r, w.rect[0] + w.rect[2] / 2, w.rect[1] + w.rect[3] / 2, 1)))
    if (!inside.length) return false
    const first = Math.min(...inside.map((w) => w.index))
    let last = Math.max(...inside.map((w) => w.index))
    const lineOf = (i: number) => pw[i].rect[1] + pw[i].rect[3] / 2
    const sameLine = (i: number, j: number) => Math.abs(lineOf(i) - lineOf(j)) < pw[i].rect[3] * 0.6
    if (how === 'word+') last = Math.min(pw.length - 1, last + 1)
    else if (how === 'word-') last = Math.max(first, last - 1)
    else if (how === 'line+') {
      let i = last + 1
      while (i < pw.length && sameLine(i, last)) i++
      if (i < pw.length) {
        const start = i
        while (i + 1 < pw.length && sameLine(i + 1, start)) i++
        last = i
      }
    } else if (how === 'line-') {
      let i = last
      while (i > first && sameLine(i - 1, last)) i--
      last = Math.max(first, i - 1)
    } else {
      let i = last
      while (i < pw.length - 1 && !/[.?!]["”)]?$/.test(pw[i].text)) i++
      last = i
    }
    const display = readableQuote(pw, first, last)
    mutate((d) => {
      const x = d.annotations.targets.find((q) => q.id === t.id)
      if (!x) return
      x.quote = buildQuote(pw, first, last)
      x.rects = rectsForWords(pw.slice(first, last + 1))
      if (display) x.display = display
      else delete x.display
    })
    logEvent('mark', { how: 'keys', extend: how, mark: t.id })
    return true
  }

  ctl.current = {
    toolRef,
    penSeen: () => {
      lastPen.current = Date.now()
      // A pen in PC mode still writes; the first one in a session offers Pen mode, once.
      if (pc && !penOffered.current) { penOffered.current = true; setPenOffer(true) }
    },
    // A finger that writes is never a palm to ignore.
    isPalm: () => inputMode !== 'touch' && Date.now() - lastPen.current < PALM_WINDOW_MS,
    writingRecently: () => inputMode !== 'touch' && Date.now() - lastPen.current < PALM_MENU_MS,
    // In PC mode a finger only scrolls, zooms and taps, whatever Pen mode's setting says.
    touchWrites: () => !pc && inputMode === 'touch',
    touchCount: () => touches.current.size,
    beforeStroke: () => {
      if (timer.current) clearTimeout(timer.current)
      touches.current.clear()
      penDown.current = true
      holdSaveRef.current = true
      const box = liveRef.current?.getBoundingClientRect()
      if (box) liveBox.current = { left: box.left, top: box.top }
    },
    liveDraw: (from: LivePoint, to: LivePoint[]) => {
      const ctx = liveRef.current?.getContext('2d', { desynchronized: true })
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const { left, top } = liveBox.current
      ctx.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr)
      ctx.strokeStyle = INK_COLOR
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const pressure = to.reduce((sum, p) => sum + p[2], 0) / to.length
      ctx.lineWidth = penWidthRef.current * zoomRef.current * (0.65 + 0.7 * pressure)
      ctx.beginPath()
      ctx.moveTo(from[0], from[1])
      for (const p of to) ctx.lineTo(p[0], p[1])
      ctx.stroke()
    },
    strokeCancelled: () => {
      endStroke()
      if (pending.current.length) schedule()
    },
    penStroke: (page, points: InkPoint[]) => {
      endStroke()
      const now = Date.now()
      // While linking, the pen is choosing what to link to, so nothing joins earlier writing.
      const linking = !!linkingRef.current
      const marked = new Set((layerRef.current?.annotations.targets ?? []).flatMap((t) => t.strokeIds ?? []))
      const strokesSoFar = layerRef.current?.ink.strokes ?? []
      const [tx, ty] = points[0]
      const touch = classifyPenTouch({
        points, page, now, linking,
        writing: strokesSoFar.filter((s) => s.page === page && !marked.has(s.id)),
        tapExtent: TAP_MAX_PIXELS / zoomRef.current, tapMs: TAP_MAX_MS, punctuationMs: PUNCTUATION_MS,
        hitsSomething: !!noteAt(page, tx, ty) ||
          !!targetAt(layerRef.current?.annotations.targets ?? [], page, tx, ty) ||
          !!pageData.current.get(page)?.links.some((l) => pointInRect(l.rect, tx, ty)),
        dismissing: !!selectedRef.current || !!targetMenuRef.current,
        writingMs: CONTINUE_WRITING_MS
      })
      const tapped = touch !== 'stroke'
      const punctuation = touch === 'dot'
      if (tapped && !punctuation) {
        handleTap(page, points[0][0], points[0][1])
        if (pending.current.length) schedule()
        return
      }
      // Strokes right next to something just written belong to it, even over printed text,
      // so the bar of an "A" or the top of a "?" never turns into an underline.
      const nearby = linking
        ? []
        : recentStrokesNear(points, page, strokesSoFar, now, CONTINUE_WRITING_MS).filter((s) => !marked.has(s.id))
      const pageWords = words(page)
      const classified: ReturnType<typeof classifyStroke> = nearby.length || punctuation
        ? { kind: 'handwriting' }
        : classifyStroke(points, pageWords)
      const stroke: Stroke = {
        id: newId('s'), page, points, color: INK_COLOR, width: penWidthRef.current, createdAt: new Date().toISOString()
      }
      if (classified.kind === 'circle' && classified.match && isEquationCircle(classified.match.words, pageWords)) {
        const target = makeEquationTarget(newId('t'), page, pageWords, classified.match, [stroke.id], stroke.createdAt)
        addTarget(target, stroke)
        savePicture(target)
        if (pending.current.length) schedule()
        return
      }
      if ((classified.kind === 'underline' || classified.kind === 'circle') && classified.match) {
        const target = makeTextTarget(newId('t'), page, pageWords, classified.match, classified.kind, [stroke.id], stroke.createdAt)
        addTarget(target, stroke)
        if (pending.current.length) schedule()
        return
      }
      const isWriting = classified.kind === 'handwriting'
      logEvent('stroke', {
        kind: punctuation ? 'punctuation' : classified.kind, page, points: points.length,
        durationMs: Math.round(points[points.length - 1][3]), continues: nearby.length > 0,
        x: Math.round(points[0][0]), y: Math.round(points[0][1])
      })
      if (isWriting) {
        stroke.handwriting = true
        if (burstDepth.current === null) burstDepth.current = undoDepth()
      }
      // Plain ink that started the writing, such as a first letter over printed text, joins it.
      const joined = isWriting ? nearby.filter((s) => !s.handwriting) : []
      const joinedIds = new Set(joined.map((s) => s.id))
      mutate((d) => {
        if (joinedIds.size) d.ink.strokes = d.ink.strokes.map((s) => (joinedIds.has(s.id) ? { ...s, handwriting: true } : s))
        d.ink.strokes.push(stroke)
      })
      if (isWriting) {
        pending.current.push(...joined, stroke)
        schedule()
      }
    },
    tap: (page, x, y) => { handleTap(page, x, y) },
    eraseStart: () => { eraseSnapshot.current = true },
    eraseAt: (page, x, y) => {
      const current = layerRef.current
      if (!current) return
      const radius = 5
      const hidden = hiddenStrokes.current
      const hitStrokes = current.ink.strokes.filter((s) => s.page === page && !hidden.has(s.id) && strokeNear(s, x, y, radius))
      // A typed note goes whole; a typed label for handwriting can only be rubbed out while it is on show.
      const note = hitStrokes.length === 0
        ? current.annotations.marginNotes.find((n) => n.page === page && pointInRect(n.box, x, y, 2) &&
          (isTyped(n) || (showTextRef.current && n.kind !== 'drawing' && n.text !== '')))
        : undefined
      const target = targetAt(current.annotations.targets, page, x, y)
      if (!note && !target && hitStrokes.length === 0) return
      const undoable = eraseSnapshot.current
      eraseSnapshot.current = false
      if (undoable) logEvent('erase', { what: note ? 'note text' : hitStrokes.length ? 'ink' : 'mark', page, via: pointerVia(), with: toolRef.current === 'eraser' ? 'eraser tool' : 'pen eraser end' })
      const reRecognize: string[] = []
      let giveBack = ''
      mutate((d) => {
        if (note) { removeNote(d, note.id); return }
        if (hitStrokes.length === 0 && target) { eraseTargetLine(d, target.id, page, x, y); return }
        const ids = new Set(hitStrokes.map((s) => s.id))
        d.ink.strokes = d.ink.strokes.filter((s) => !ids.has(s.id))
        for (const n of [...d.annotations.marginNotes]) {
          if (!n.strokeIds.some((id) => ids.has(id))) continue
          n.strokeIds = n.strokeIds.filter((id) => !ids.has(id))
          if (n.strokeIds.length === 0) {
            d.annotations.marginNotes = d.annotations.marginNotes.filter((x) => x.id !== n.id)
            const last = lastLinked.current
            if (last?.noteId === n.id && Date.now() - last.at < RELINK_AFTER_ERASE_MS &&
              d.annotations.targets.some((t) => t.id === last.targetId)) giveBack = last.targetId
            continue
          }
          // The note's area shrinks to what is left.
          const rest = d.ink.strokes.filter((s) => n.strokeIds.includes(s.id))
          if (rest.length) n.box = boxToRect(clusterBox(rest))
          reRecognize.push(n.id)
        }
      }, undoable)
      if (giveBack) { lastLinked.current = null; setActive(giveBack) }
      for (const id of reRecognize) void recognizeNote(id)
    },
    selectInk: (page, loop) => {
      const current = layerRef.current
      if (!current || loop.length === 0) { setInkSel(null); return }
      // Marks belong to the printed text they mark, so only writing and drawings are picked up.
      const marked = new Set(current.annotations.targets.flatMap((t) => t.strokeIds ?? []))
      const ids = strokesInLasso(current.ink.strokes.filter((s) => !hiddenStrokes.current.has(s.id)), page, loop, marked)
      logEvent('ink.select', { page, strokes: ids.length, via: pointerVia() })
      setSelected('')
      setActive('')
      setInkSel(ids.length ? { page, ids: new Set(ids) } : null)
    },
    moveInk: (page, ids, dx, dy) => {
      if (pending.current.length) {
        if (timer.current) clearTimeout(timer.current)
        processPending()
      }
      let toRead: string[] = []
      const now = new Date().toISOString()
      // One undo puts the ink and the notes back as they were.
      mutate((d) => { toRead = moveInk(d, page, ids, dx, dy, () => newId('m'), now) })
      logEvent('ink.move', { page, strokes: ids.size, dx: Math.round(dx), dy: Math.round(dy), notes: toRead.length, via: pointerVia() })
      for (const id of toRead) void recognizeNote(id)
    },
    scaleInk: (page, ids, factor, anchor) => {
      if (pending.current.length) {
        if (timer.current) clearTimeout(timer.current)
        processPending()
      }
      let toRead: string[] = []
      const now = new Date().toISOString()
      mutate((d) => { toRead = scaleInk(d, page, ids, factor, () => newId('m'), now, anchor) })
      logEvent('ink.scale', { page, strokes: ids.size, factor, notes: toRead.length, via: pointerVia() })
      for (const id of toRead) void recognizeNote(id)
    },
    deleteInk: (page, ids) => {
      let toRead: string[] = []
      mutate((d) => { toRead = deleteInk(d, ids) })
      logEvent('ink.delete', { page, strokes: ids.size })
      setInkSel(null)
      for (const id of toRead) void recognizeNote(id)
    },
    moveNote: (page, noteId, dx, dy) => {
      // Ink and box move together, so the note keeps its text and links; one undo puts it back.
      mutate((d) => {
        const n = d.annotations.marginNotes.find((x) => x.id === noteId)
        if (!n) return
        n.box = [n.box[0] + dx, n.box[1] + dy, n.box[2], n.box[3]]
        const ids = new Set(n.strokeIds)
        d.ink.strokes = d.ink.strokes.map((s) => (ids.has(s.id)
          ? { ...s, points: s.points.map(([x, y, pr, t]) => [Math.round((x + dx) * 100) / 100, Math.round((y + dy) * 100) / 100, pr, t] as InkPoint) }
          : s))
        n.updatedAt = new Date().toISOString()
      })
      logEvent('note.move', { note: noteId, page, dx: Math.round(dx), dy: Math.round(dy), via: pointerVia() })
    },
    finishRegion: (page, rect: Rect) => { makeRegion(page, rect) },
    setTargetRect: (page, targetId, rect) => {
      let moved: Target | undefined
      mutate((d) => {
        const t = d.annotations.targets.find((x) => x.id === targetId)
        if (!t) return
        t.rects = [rect]
        moved = { ...t, rects: [rect] }
      })
      // The saved picture shows the new area.
      if (moved) savePicture(moved)
      logEvent('region.adjust', { mark: targetId, page, rect: rect.map((v) => Math.round(v)) })
    },
    selectionPreview: (page, a, b) => {
      const pw = words(page)
      const s = nearestWord(pw, a[0], a[1])
      const e = nearestWord(pw, b[0], b[1])
      if (!s || !e) return []
      return rectsForWords(pw.slice(Math.min(s.index, e.index), Math.max(s.index, e.index) + 1))
    },
    finishSelection: (page, a, b) => {
      const pw = words(page)
      const s = wordAt(pw, a[0], a[1], 4) ?? nearestWord(pw, a[0], a[1], 12)
      const e = nearestWord(pw, b[0], b[1])
      if (!s || !e) return
      // Selected, not marked: the bar offers Mark, Note and Copy, so a bad drag costs nothing.
      setActive('')
      setSelected('')
      setPendingRect(null)
      setChosen(null)
      setPendingSel({ page, first: Math.min(s.index, e.index), last: Math.max(s.index, e.index) })
      logEvent('select.text', { page, words: Math.abs(e.index - s.index) + 1, via: pointerVia() })
    },
    noteAt: (page, x, y) => noteAt(page, x, y)?.id ?? '',
    onText: (page, x, y) => !!(wordAt(words(page), x, y, 3) ?? nearestWord(words(page), x, y, 12)),
    finishRect: (page, rect, now) => {
      if (rect[2] < 8 || rect[3] < 8) return
      if (now) { makeRegion(page, rect); return }
      setActive('')
      setSelected('')
      setPendingSel(null)
      setPendingRect({ page, rect })
    },
    band: (page, rect, add) => {
      const inside = (r: Rect) => r[0] >= rect[0] - 1 && r[1] >= rect[1] - 1 && r[0] + r[2] <= rect[0] + rect[2] + 1 && r[1] + r[3] <= rect[1] + rect[3] + 1
      const a = layerRef.current?.annotations
      const ids = new Set<string>(add && chosenRef.current?.page === page ? chosenRef.current.ids : [])
      for (const n of a?.marginNotes ?? []) if (n.page === page && inside(n.box)) ids.add(n.id)
      for (const t of a?.targets ?? []) if (t.page === page && t.rects?.length && t.rects.every(inside)) ids.add(t.id)
      setActive('')
      setSelected('')
      setPendingSel(null)
      setChosen(ids.size ? { page, ids } : null)
      logEvent('select.band', { page, items: ids.size })
    },
    doubleClick: (page, x, y) => onDoubleClick(page, x, y),
    setNoteWidth: (page, noteId, x, width) => {
      mutate((d) => {
        const n = d.annotations.marginNotes.find((m) => m.id === noteId)
        if (!n) return
        n.box = [Math.round(x * 10) / 10, n.box[1], Math.round(width * 10) / 10, n.box[3]]
        n.updatedAt = new Date().toISOString()
      })
      logEvent('note.width', { note: noteId, page, width: Math.round(width) })
    },
    noteHeight: (noteId, height) => {
      mutate((d) => {
        const n = d.annotations.marginNotes.find((m) => m.id === noteId)
        if (n && Math.abs(n.box[3] - height) > 1) n.box = [n.box[0], n.box[1], n.box[2], height]
      }, false)
    },
    hover: (page, x, y) => {
      const id = noteAt(page, x, y)?.id ?? ''
      setHoverNoteId((h) => (h === id ? h : id))
    },
    contextMenu: (page, x, y, clientX, clientY) => {
      logEvent('menu.open', { page, via: pointerVia() })
      const link = pageData.current.get(page)?.links.find((l) => pointInRect(l.rect, x, y, 1))
      const active = layerRef.current?.annotations.targets.find((t) => t.id === activeRef.current)
      const items: Menu['items'] = []
      // A figure, table, equation or section is not a reference to preview or put on a map.
      if (link?.dest && !isReferenceLink(labelOf(link))) {
        items.push({ label: 'Go to link', testId: 'menu-go-to-link', run: () => void followLink(link) })
      } else if (link?.dest) {
        items.push({ label: 'Preview this reference', testId: 'menu-preview', run: () => void previewFromLink(link) })
        if (!readOnly) {
          items.push({
            label: 'Add to map as a suggestion', testId: 'menu-add-to-map',
            run: () => void referenceFromLink(link).then((text) => { if (text !== null) addReferenceToMap(text) })
          })
        }
        items.push({ label: 'Go to link', run: () => void followLink(link) })
      } else if (link?.url) {
        items.push({ label: 'Open link in browser', run: () => void followLink(link) })
      }
      const a = layerRef.current?.annotations
      const pw = words(page)
      const sel = pendingSelRef.current
      const inSel = !!sel && sel.page === page && rectsForWords(pw.slice(sel.first, sel.last + 1)).some((r) => pointInRect(r, x, y, 3))
      const note = inSel ? undefined : noteAt(page, x, y)
      const target = inSel || note || !a ? undefined : targetAt(a.targets, page, x, y)
      const own: Menu['items'] = []
      // A pen held still opens this menu too; only the mouse, or PC mode, gets the new items, so writing is never interrupted.
      const desk = pc || pointerVia() === 'mouse'
      if (!desk) { /* only the link items below */ } else if (inSel && sel) {
        const quote = buildQuote(pw, sel.first, sel.last).exact
        if (!readOnly) {
          own.push({ label: 'Mark', keys: 'H', testId: 'menu-mark', run: () => { markPending() } })
          own.push({ label: 'Margin note', keys: 'N', testId: 'menu-note', run: () => noteForPending() })
        }
        own.push({ label: 'Copy', keys: 'Ctrl+C', testId: 'menu-copy', run: () => void copyText(quote) })
        if (looksLikeReference(quote)) {
          own.push({ label: 'Preview as a reference', testId: 'menu-preview-selection', run: () => void lookUpReference(quote) })
          if (!readOnly) own.push({ label: 'Add to map as a suggestion', testId: 'menu-add-selection-to-map', run: () => addReferenceToMap(quote) })
        }
      } else if (note && !readOnly) {
        setSelected(note.id)
        setActive('')
        own.push(...noteMenuItems(note))
      } else if (target && !readOnly && target.rects?.length) {
        setActive(target.id)
        own.push({ label: 'Margin note', keys: 'N', testId: 'menu-mark-note', run: () => noteForTarget(target) })
        if (target.kind === 'text' && (target.rects?.length ?? 0) > 1) {
          own.push({ label: 'Remove this line from the mark', testId: 'menu-remove-line', run: () => { mutate((d) => eraseTargetLine(d, target.id, page, x, y)); setActive('') } })
        }
        if (target.style === 'equation') {
          own.push({ label: 'Make it a plain region', testId: 'menu-plain-region', run: () => mutate((d) => { const t = d.annotations.targets.find((q) => q.id === target.id); if (t) { t.style = 'region'; delete t.latex; delete t.equation } }) })
        }
        own.push({ label: 'Delete mark', keys: 'Del', testId: 'menu-mark-delete', run: () => { mutate((d) => removeTarget(d, target.id)); setActive('') } })
      }
      if (!inSel && active?.kind === 'text' && active.quote && !note) {
        const quote = active.quote.exact
        items.push({ label: 'Preview reference from selected text', testId: 'menu-preview-selection', run: () => void lookUpReference(quote) })
        if (!readOnly) items.push({ label: 'Add selected reference to map', testId: 'menu-add-selection-to-map', run: () => addReferenceToMap(quote) })
      }
      if (desk && !inSel && !note && !target && !link && !readOnly) {
        const linkTo = activeRef.current
        own.push({ label: linkTo ? 'New note here, about the marked text' : 'New note here', testId: 'menu-new-note', run: () => newNoteAt(page, x, y, linkTo ? [linkTo] : [], 'menu') })
        own.push({ label: 'New note about this page', testId: 'menu-new-page-note', run: () => {
          const t: Target = { id: newId('t'), kind: 'page', page, createdAt: new Date().toISOString() }
          newNoteAt(page, x, y, [t.id], 'menu-page', t)
        } })
        own.push({ label: 'Tidy margin', testId: 'menu-tidy', run: () => tidyPage(page) })
      }
      const all = [...own, ...items]
      if (all.length) setMenu({ x: clientX, y: clientY, items: all })
    },
    touchStart: (e) => {
      if (ctl.current.isPalm()) return
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size === 1) {
        // A touch catches a moving page; a new swipe can then speed it up again.
        swipe.current = { samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }], pinched: false, running: fling.current?.v ?? null }
        stopFling()
        rail.current = { x: e.clientX, y: e.clientY, axis: 'none' }
      }
      if (touches.current.size === 2) {
        swipe.current.pinched = true
        const [a, b] = [...touches.current.values()]
        pinch.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: zoomRef.current,
          anchor: anchorAt((a.x + b.x) / 2, (a.y + b.y) / 2)
        }
      }
    },
    touchMove: (e) => {
      const prev = touches.current.get(e.pointerId)
      if (!prev || ctl.current.isPalm()) return
      const el = scrollRef.current
      // When a finger writes, one finger never scrolls; two fingers do, below.
      if (touches.current.size === 1 && el && (pc || inputMode !== 'touch')) {
        // Like a browser's PDF viewer: a mostly vertical swipe scrolls straight down, so the page
        // does not drift into the margins. Only a clearly sideways move, or a long one, moves sideways.
        const r = rail.current
        const tx = e.clientX - r.x
        const ty = e.clientY - r.y
        if (r.axis === 'none' && Math.hypot(tx, ty) > 10) {
          r.axis = Math.abs(tx) < Math.abs(ty) * 0.7 ? 'y' : Math.abs(ty) < Math.abs(tx) * 0.7 ? 'x' : 'free'
        }
        if (r.axis === 'y' && Math.abs(tx) > RAIL_BREAK_PX) r.axis = 'free'
        if (r.axis === 'x' && Math.abs(ty) > RAIL_BREAK_PX) r.axis = 'free'
        if (r.axis !== 'x') el.scrollTop -= e.clientY - prev.y
        if (r.axis === 'x' || r.axis === 'free') el.scrollLeft -= e.clientX - prev.x
        const samples = swipe.current.samples
        samples.push({ t: e.timeStamp, x: r.axis === 'y' ? r.x : e.clientX, y: r.axis === 'x' ? r.y : e.clientY })
        if (samples.length > 30) samples.splice(0, samples.length - 30)
      }
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size === 2 && pinch.current && pinchFrame.current === null) {
        // At most once per frame, using the newest finger positions.
        pinchFrame.current = nextFrame(() => {
          pinchFrame.current = null
          const p = pinch.current
          if (!p || touches.current.size !== 2) return
          const [a, b] = [...touches.current.values()]
          const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, p.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / p.dist)))
          // The same page point follows the fingers, so a pinch can also move the page.
          if (p.anchor) anchorRef.current = { ...p.anchor, clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }
          if (z === zoomRef.current) setPinchTick((t) => t + 1)
          else setZoom(z)
        })
      }
    },
    touchEnd: (e) => {
      const wasOne = touches.current.size === 1 && touches.current.has(e.pointerId)
      touches.current.delete(e.pointerId)
      if (touches.current.size < 2) pinch.current = null
      if (wasOne && !swipe.current.pinched && e.type === 'pointerup' && (pc || inputMode !== 'touch')) {
        const v = startFling(releaseVelocity(swipe.current.samples, e.timeStamp), swipe.current.running)
        if (v) {
          logEvent('touch.fling', { speed: Math.round(Math.hypot(...v) * 100) / 100 })
          runFling(v)
        }
      }
    }
  }
  // Pages get one stable object whose methods always see the latest state.
  const stableCtl = useRef<PageController>({
    toolRef,
    penSeen: () => ctl.current.penSeen(),
    isPalm: () => ctl.current.isPalm(),
    touchWrites: () => ctl.current.touchWrites(),
    touchCount: () => ctl.current.touchCount(),
    beforeStroke: () => ctl.current.beforeStroke(),
    liveDraw: (...a) => ctl.current.liveDraw(...a),
    strokeCancelled: () => ctl.current.strokeCancelled(),
    penStroke: (...a) => ctl.current.penStroke(...a),
    tap: (...a) => ctl.current.tap(...a),
    eraseStart: () => ctl.current.eraseStart(),
    eraseAt: (...a) => ctl.current.eraseAt(...a),
    finishRegion: (...a) => ctl.current.finishRegion(...a),
    moveNote: (...a) => ctl.current.moveNote(...a),
    setTargetRect: (...a) => ctl.current.setTargetRect(...a),
    selectInk: (...a) => ctl.current.selectInk(...a),
    moveInk: (...a) => ctl.current.moveInk(...a),
    deleteInk: (...a) => ctl.current.deleteInk(...a),
    scaleInk: (...a) => ctl.current.scaleInk(...a),
    selectionPreview: (...a) => ctl.current.selectionPreview(...a),
    finishSelection: (...a) => ctl.current.finishSelection(...a),
    noteAt: (...a) => ctl.current.noteAt(...a),
    onText: (...a) => ctl.current.onText(...a),
    finishRect: (...a) => ctl.current.finishRect(...a),
    band: (...a) => ctl.current.band(...a),
    doubleClick: (...a) => ctl.current.doubleClick(...a),
    setNoteWidth: (...a) => ctl.current.setNoteWidth(...a),
    noteHeight: (...a) => ctl.current.noteHeight(...a),
    hover: (...a) => ctl.current.hover(...a),
    contextMenu: (...a) => ctl.current.contextMenu(...a),
    writingRecently: () => ctl.current.writingRecently(),
    touchStart: (e) => ctl.current.touchStart(e),
    touchMove: (e) => ctl.current.touchMove(e),
    touchEnd: (e) => ctl.current.touchEnd(e)
  })

  // ---- Find, in the paper's text and in your own notes ----
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState<FindStop[]>([])
  const [marginHits, setMarginHits] = useState<FindStop[]>([])
  const [sideHits, setSideHits] = useState<FindStop[]>([])
  const [findIndex, setFindIndex] = useState(-1)
  const [findInText, setFindInText] = useState(true)
  const [findInMargin, setFindInMargin] = useState(true)
  const [findInSide, setFindInSide] = useState(true)
  /** The side note match Find went to; `tick` makes going to the same one again count. */
  const [sideFocus, setSideFocus] = useState<{ path: string; occurrence: number; tick: number } | null>(null)
  /** Counts Ctrl+N presses; the notes pane makes a side note on each. */
  const [newNoteTick, setNewNoteTick] = useState(0)
  /** The page at the top of the view, shown in the page box; what is typed there until Enter. */
  const [pageInView, setPageInView] = useState(0)
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const openFind = () => {
    setFindOpen(true)
    requestAnimationFrame(() => findInputRef.current?.select())
  }
  const closeFind = () => setFindOpen(false)

  useEffect(() => {
    // The query is used exactly as typed, spaces included; only letter case is ignored.
    const q = findQuery.toLowerCase()
    if (!findOpen || q.trim() === '' || !docRef.current) {
      setFindHits([])
      setMarginHits([])
      setSideHits([])
      setFindIndex(-1)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const d = docRef.current
      if (!d) return
      const hits: FindStop[] = []
      for (let i = 0; i < sizes.length && hits.length < 1000; i++) {
        let data = pageData.current.get(i)
        if (!data) {
          data = await loadPageData(d, i)
          pageData.current.set(i, data)
        }
        if (cancelled) return
        const ws = data.words
        let text = ''
        const starts: number[] = []
        for (const w of ws) {
          if (text) text += ' '
          starts.push(text.length)
          text += w.text.toLowerCase()
        }
        for (let at = text.indexOf(q); at >= 0 && hits.length < 1000; at = text.indexOf(q, at + Math.max(1, q.length))) {
          let first = 0
          while (first + 1 < starts.length && starts[first + 1] <= at) first++
          let last = first
          while (last + 1 < starts.length && starts[last + 1] < at + q.length) last++
          hits.push({ kind: 'text', page: i, rects: rectsForWords(ws.slice(first, last + 1)) })
        }
      }
      const margin: FindStop[] = []
      for (const n of layerRef.current?.annotations.marginNotes ?? []) {
        if (n.text.toLowerCase().includes(q)) margin.push({ kind: 'margin', page: n.page, noteId: n.id, y: n.box[1] })
      }
      // A side note: one stop for each match in it, in the order the note shows them.
      const side: FindStop[] = []
      if (paperId) {
        for (const sn of await window.api.listSideNotes(paperId)) {
          const n = matchStarts(shownText(sn.title, sn.body), q).length
          for (let k = 0; k < n; k++) side.push({ kind: 'side', path: sn.path, occurrence: k })
        }
      }
      if (cancelled) return
      setFindHits(hits)
      setMarginHits(margin)
      setSideHits(side)
      setSideFocus(null)
      setFindIndex(-1)
      logEvent('find.search', { chars: q.length, hits: hits.length, marginHits: margin.length, sideHits: side.length })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, findOpen, sizes.length, paperId])

  /** The places Previous and Next go through: the printed text, your notes, or both, in page order. */
  const findStops = useMemo(() => {
    const stops = [
      ...(findInText ? findHits : []),
      ...(findInMargin ? marginHits : [])
    ]
    const y = (h: FindStop) => (h.kind === 'text' ? h.rects[0]?.[1] ?? 0 : h.kind === 'margin' ? h.y : 0)
    const page = (h: FindStop) => (h.kind === 'side' ? Infinity : h.page)
    stops.sort((a, b) => page(a) - page(b) || y(a) - y(b))
    return [...stops, ...(findInSide ? sideHits : [])]
  }, [findHits, marginHits, sideHits, findInText, findInMargin, findInSide])

  const goToHit = (i: number) => {
    if (findStops.length === 0) return
    const next = ((i % findStops.length) + findStops.length) % findStops.length
    setFindIndex(next)
    const stop = findStops[next]
    logEvent('find.go', { index: next, of: findStops.length, kind: stop.kind })
    if (stop.kind === 'text') {
      setSelected('')
      scrollTo(stop.page, stop.rects[0]?.[1] ?? 0)
    } else if (stop.kind === 'margin') {
      scrollTo(stop.page, stop.y)
      setSelected(stop.noteId)
    } else {
      setPaneOpen(true)
      setSideFocus((f) => ({ path: stop.path, occurrence: stop.occurrence, tick: (f?.tick ?? 0) + 1 }))
    }
  }

  /** Ctrl+Enter in Find: the current match in the text becomes the active mark (or links, while linking). */
  const markFindMatch = () => {
    const stop = findStops[findIndex < 0 ? 0 : findIndex]
    if (!stop || stop.kind !== 'text' || readOnly) return
    const pw = words(stop.page)
    const inside = pw.filter((w) => stop.rects.some((r) => pointInRect(r, w.rect[0] + w.rect[2] / 2, w.rect[1] + w.rect[3] / 2, 1)))
    if (!inside.length) return
    setPendingSel({ page: stop.page, first: Math.min(...inside.map((w) => w.index)), last: Math.max(...inside.map((w) => w.index)) })
    markPending()
    closeFind()
    logEvent('mark', { how: 'find', page: stop.page })
  }

  /** Next or previous place; before the first step, Previous starts from the last match. */
  const findStep = (dir: 1 | -1) => goToHit(findIndex < 0 ? (dir > 0 ? 0 : -1) : findIndex + dir)

  const highlightsByPage = useMemo(() => {
    const out = new Map<number, { rects: Rect[]; current: boolean }[]>()
    if (!findOpen || !findInText) return out
    const current = findStops[findIndex]
    for (const h of findHits) {
      if (h.kind !== 'text') continue
      const list = out.get(h.page) ?? []
      list.push({ rects: h.rects, current: h === current })
      out.set(h.page, list)
    }
    return out
  }, [findHits, findStops, findIndex, findOpen, findInText])

  /** Deleting a margin note asks nothing: it takes a tap and a menu choice, and Undo brings it back. */
  const deleteNote = useCallback((id: string) => {
    logEvent('note.delete', { note: id })
    mutate((d) => removeNote(d, id))
    setSelected('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, setSelected])

  // The handler is replaced on every render (below), so it always sees the current state.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (activeTab.current) onKeyRef.current(e) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Clicking anywhere outside the note being typed saves it, as Enter does.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!draftRef.current) return
      if ((e.target as Element | null)?.closest?.('.typed-editor')) return
      commitDraftRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  // Ctrl+V with a mark active makes a typed note about it from the clipboard; otherwise nothing.
  const onPasteRef = useRef<(e: ClipboardEvent) => void>(() => undefined)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => { if (activeTab.current) onPasteRef.current(e) }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const allNotes = layer?.annotations.marginNotes
  const allTargets = layer?.annotations.targets
  const allStrokes = layer?.ink.strokes
  /** PC mode shows the eraser and Select ink only on papers with handwriting. */
  const hasInk = (allStrokes?.length ?? 0) > 0

  const hiddenStrokes = useRef(new Set<string>())
  const visibleByPage = useMemo(() => {
    const hidden = new Set<string>()
    // Only marks are redrawn cleanly. Handwriting always stays on the page as written.
    for (const t of allTargets ?? []) for (const id of t.strokeIds ?? []) hidden.add(id)
    hiddenStrokes.current = hidden
    const byPage = new Map<number, Stroke[]>()
    for (const s of allStrokes ?? []) {
      if (hidden.has(s.id)) continue
      const list = byPage.get(s.page)
      if (list) list.push(s)
      else byPage.set(s.page, [s])
    }
    return byPage
  }, [allStrokes, allTargets])

  const notesByPage = useMemo(() => groupBy(allNotes ?? [], (n) => n.page), [allNotes])
  const targetsByPage = useMemo(() => groupBy(allTargets ?? [], (t) => t.page ?? -1), [allTargets])
  const wholePaperIds = useMemo(() => new Set((allTargets ?? []).filter((t) => t.kind === 'paper').map((t) => t.id)), [allTargets])
  const selectedNote = allNotes?.find((n) => n.id === selectedNoteId)
  const menuTarget = targetMenuId && targetMenuId === activeTargetId
    ? allTargets?.find((t) => t.id === targetMenuId && t.rects?.length)
    : undefined
  const connectNote = selectedNote ?? allNotes?.find((n) => n.id === hoverNoteId) ?? null

  const updateNote = (id: string, patch: Partial<MarginNote>) => mutate((d) => {
    const n = d.annotations.marginNotes.find((x) => x.id === id)
    if (n) Object.assign(n, patch, { updatedAt: new Date().toISOString() })
  })

  const jumpToTarget = (id: string) => {
    const t = allTargets?.find((x) => x.id === id)
    if (!t || t.page === undefined) return
    scrollTo(t.page, t.rects?.[0]?.[1] ?? 0)
    setFlashTargetId(id)
    setTimeout(() => setFlashTargetId(''), 1500)
  }

  /** Zooms and scrolls so a box on a page fills the view, with some room around it, in the middle. The zoom stays between 80% and 200%; a box too big to fit is centred. */
  const showBox = (page: number, box: Rect) => {
    const el = scrollRef.current
    if (!el) return
    const z = fitZoom(box, el.clientWidth, el.clientHeight, 48, LINK_MIN_ZOOM, LINK_MAX_ZOOM)
    const view = el.getBoundingClientRect()
    const anchor: ZoomAnchor = {
      page,
      x: box[0] + box[2] / 2 + (readOnly ? 0 : margin),
      y: box[1] + box[3] / 2,
      clientX: view.left + el.clientWidth / 2,
      clientY: view.top + el.clientHeight / 2
    }
    if (Math.abs(z - zoomRef.current) < 0.001) {
      const wrap = el.querySelector<HTMLElement>(`[data-page="${page}"]`)
      if (!wrap) return
      el.scrollLeft = wrap.offsetLeft + anchor.x * z - el.clientWidth / 2
      el.scrollTop = wrap.offsetTop + anchor.y * z - el.clientHeight / 2
      return
    }
    // The zoom keeps this point in the middle of the view once the pages are laid out again.
    anchorRef.current = anchor
    changeZoom(z)
  }

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashBoxes = (byPage: Map<number, Rect[]>) => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setLinkFlash({ key: Date.now(), byPage })
    flashTimer.current = setTimeout(() => setLinkFlash(null), 1800)
  }

  /** From a side-note link: the note and its nearest mark fill the view, and the note and all its marks flash. */
  const showNote = (n: MarginNote) => {
    const linked = (allTargets ?? []).filter((t) => n.targetIds.includes(t.id))
    logEvent('sidenote.link', { to: 'note', note: n.id })
    setSelected('')
    setActive('')
    showBox(n.page, focusBox(n, linked))
    const byPage = new Map<number, Rect[]>([[n.page, [n.box]]])
    for (const t of linked) {
      if (t.page === undefined || !t.rects?.length) continue
      byPage.set(t.page, [...(byPage.get(t.page) ?? []), ...t.rects])
    }
    flashBoxes(byPage)
  }

  const showMark = (id: string) => {
    const t = allTargets?.find((x) => x.id === id)
    if (!t || t.page === undefined) return
    logEvent('sidenote.link', { to: 'mark', mark: id })
    if (!t.rects?.length) { scrollTo(t.page, 0); return }
    setSelected('')
    setActive('')
    showBox(t.page, boundsOf(t.rects))
    flashBoxes(new Map([[t.page, t.rects]]))
  }

  /** From a side-note link to words on a page: they fill the view and flash; if missing, the page top. */
  const showQuote = async (page: number, quote: string) => {
    if (page >= sizes.length) { notify(`This paper has no page ${page + 1}.`); return }
    const d = docRef.current
    let data = await ensurePageData(page) ?? pageData.current.get(page)
    if (!data && d) data = await loadPageData(d, page)
    const found = data ? findQuote(data.words, quote) : null
    logEvent('sidenote.link', { to: 'text', page, found: !!found })
    if (!found) {
      scrollTo(page, 0)
      notify(`“${quote.length > 50 ? quote.slice(0, 49) + '…' : quote}” is not on p. ${page + 1}; showing the top of the page.`)
      return
    }
    const rects = rectsForWords(found)
    setSelected('')
    setActive('')
    showBox(page, boundsOf(rects))
    flashBoxes(new Map([[page, rects]]))
  }

  const linkWhole = (noteId: string, kind: 'page' | 'paper', page: number) => {
    const stamp = new Date().toISOString()
    const t: Target = { id: newId('t'), kind, createdAt: stamp, ...(kind === 'page' ? { page } : {}) }
    mutate((d) => { d.annotations.targets.push(t); attachTarget(d, noteId, t.id) })
  }

  async function addPreviewToLibrary(): Promise<void> {
    if (source.kind !== 'preview') return
    const r = await window.api.addPreview(source.preview, source.citingId, source.fromMapId)
    if (r.ok) onPreviewAdded(r.entry, source.preview)
    else notify(r.reason)
  }

  async function setStatus(status: PaperEntry['meta']['status']): Promise<void> {
    if (!entry) return
    const read_on = status === 'read' ? new Date().toISOString().slice(0, 10) : ''
    onEntryChanged(await window.api.updatePaper(entry.meta.id, { status, read_on }))
  }

  const title = source.kind === 'paper' ? source.entry.meta.title : source.preview.paper.title

  const toggleText = () => {
    const next = !showText
    setShowText(next)
    try {
      localStorage.setItem(SHOW_TEXT_KEY, next ? '1' : '0')
    } catch {
      /* the choice just won't be remembered */
    }
  }
  const toggleLinks = () => {
    const next = !showLinks
    setShowLinks(next)
    try {
      localStorage.setItem(SHOW_LINKS_KEY, next ? '1' : '0')
    } catch {
      /* the choice just won't be remembered */
    }
  }
  /** Fits the page and the margins actually used by notes, with a column for new ones. */
  const fitNotes = () => {
    const el = scrollRef.current
    if (!el || sizes.length === 0) return
    const boxes = (allNotes ?? []).map((n) => n.box)
    const f = fitWithNotes(el.clientWidth - 30, sizes[0].width, margin, boxes)
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, f.zoom))
    alignLeft.current = f.left
    alignRef.current = 'notes'
    if (Math.abs(z - zoomRef.current) < 0.001) { alignNow(); return }
    changeZoom(z)
  }
  const fitNext = () => {
    if (pc && !readOnly) {
      if (nextFit === 'page') { fit(false); setNextFit('notes') } else { fitNotes(); setNextFit('page') }
      return
    }
    const withMargins = !readOnly && nextFit === 'margins'
    fit(withMargins)
    setNextFit(withMargins ? 'page' : 'margins')
  }
  /** The page at the top of the view. */
  /** Where a page starts in the scrolled content, from the page itself rather than a computed layout. */
  const pageTop = (el: HTMLElement, p: number): number | null => {
    const wrap = el.querySelector<HTMLElement>(`[data-page="${p}"]`)
    return wrap ? wrap.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : null
  }
  const currentPage = (): number => {
    const el = scrollRef.current
    if (!el) return 0
    let p = 0
    while (p + 1 < sizes.length && (pageTop(el, p + 1) ?? Infinity) <= el.scrollTop + 100) p++
    return p
  }
  const showPage = (p: number) => {
    const el = scrollRef.current
    if (!el || sizes.length === 0) return
    const top = pageTop(el, Math.min(Math.max(p, 0), sizes.length - 1))
    if (top !== null) el.scrollTop = top - 8
  }

  onPasteRef.current = (e: ClipboardEvent) => {
    const el = e.target as HTMLElement | null
    if (readOnly || draftRef.current || (el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable))) return
    const t = layerRef.current?.annotations.targets.find((x) => x.id === activeRef.current)
    const text = e.clipboardData?.getData('text/plain')?.trim()
    if (!t || t.page === undefined || !text) return
    e.preventDefault()
    placeAndStart(t.page, [t.id], t.rects, 'paste', text)
  }

  onKeyRef.current = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    const done = () => e.preventDefault()
    // The typed-note editor handles its own keys.
    if (draftRef.current) return
    if (mod(e) && key === 'f') { done(); openFind(); return }
    if (mod(e) && key === 'g') {
      done()
      if (findOpen) findStep(e.shiftKey ? -1 : 1)
      else document.querySelector<HTMLInputElement>('[data-testid="page-input"]')?.focus()
      return
    }
    if (!isTyping(e) && (e.key === '?' || e.key === 'F1')) { done(); setShowKeys(true); return }
    if (e.altKey && !mod(e) && e.key === 'ArrowLeft' && linkBack) { done(); centreOn(linkBack.page, linkBack.x, linkBack.y); setLinkBack(null); return }
    if (e.key === 'F3') {
      done()
      if (!findOpen) openFind()
      else findStep(e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'Escape') { setActive(''); setSelected(''); setLinking(''); setMenu(null); setInkSel(null); closeFind(); setPendingSel(null); setPendingRect(null); setChosen(null); setShowKeys(false); setMoreMenu(false) }
    if (mod(e) && (key === '=' || key === '+')) { done(); changeZoom(zoomRef.current * 1.15); return }
    if (mod(e) && (key === '-' || key === '_')) { done(); changeZoom(zoomRef.current / 1.15); return }
    if (mod(e) && key === '0') { done(); fitNext(); return }
    if (isTyping(e)) return
    if (mod(e) && key === 'z') { done(); if (e.shiftKey) redo(); else undo(); return }
    if (mod(e) && key === 'y') { done(); redo(); return }
    if (!readOnly && mod(e) && key === 'n') { done(); setNewNoteTick((t) => t + 1); return }
    if (!readOnly && mod(e) && key === 'e' && selectedRef.current) { done(); setEditingNoteId(selectedRef.current); return }
    if (!readOnly && mod(e) && key === 'k' && selectedRef.current) { done(); setLinking(selectedRef.current); return }
    if (mod(e) && key === 'c' && !e.shiftKey) {
      const s = pendingSelRef.current
      const n = layerRef.current?.annotations.marginNotes.find((x) => x.id === selectedRef.current)
      const t = layerRef.current?.annotations.targets.find((x) => x.id === activeRef.current)
      const text = s ? buildQuote(words(s.page), s.first, s.last).exact : n ? n.text : t?.quote?.exact ?? ''
      if (text) { done(); void copyText(text) }
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && chosenRef.current && !readOnly) {
      done()
      const ids = chosenRef.current.ids
      mutate((d) => {
        for (const id of ids) {
          if (d.annotations.marginNotes.some((n) => n.id === id)) removeNote(d, id)
          else removeTarget(d, id)
        }
      })
      logEvent('delete.chosen', { items: ids.size })
      setChosen(null)
      return
    }
    // Enter or F2 edits the selected note.
    if (!readOnly && (e.key === 'Enter' || e.key === 'F2') && !mod(e) && selectedRef.current) {
      const n = layerRef.current?.annotations.marginNotes.find((x) => x.id === selectedRef.current)
      if (n) { done(); openEditor(n); return }
    }
    // Alt+Down / Alt+Up: the next or previous note, in reading order.
    if (e.altKey && !mod(e) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      done()
      const list = [...(layerRef.current?.annotations.marginNotes ?? [])].sort((a, b) => a.page - b.page || a.box[1] - b.box[1] || a.box[0] - b.box[0])
      if (!list.length) return
      const at = list.findIndex((n) => n.id === selectedRef.current)
      const next = at < 0 ? (e.key === 'ArrowDown' ? list.find((n) => n.page >= currentPage()) ?? list[0] : list[list.length - 1]) : list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]
      setActive('')
      setSelected(next.id)
      scrollTo(next.page, next.box[1])
      return
    }
    // Arrows nudge a note you clicked; Esc lets go of it and they turn pages again.
    if (!readOnly && selectedRef.current && !e.altKey && !mod(e) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const n = layerRef.current?.annotations.marginNotes.find((x) => x.id === selectedRef.current)
      if (n) {
        done()
        const step = e.shiftKey ? 20 : 2
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        ctl.current.moveNote(n.page, n.id, dx, dy)
        return
      }
    }
    // Shift+arrows and Shift+End grow or shrink the active mark.
    if (!readOnly && e.shiftKey && !mod(e) && !e.altKey && activeRef.current) {
      const how = ({ ArrowRight: 'word+', ArrowLeft: 'word-', ArrowDown: 'line+', ArrowUp: 'line-', End: 'sentence' } as const)[e.key as 'ArrowRight']
      if (how && extendActive(how)) { done(); return }
    }
    if (plain(e) && (e.key === ' ' || e.key === 'Spacebar') || (e.shiftKey && !mod(e) && !e.altKey && e.key === ' ')) {
      const el = scrollRef.current
      if (el) { done(); el.scrollTop += (e.shiftKey ? -1 : 1) * el.clientHeight * 0.9; return }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && inkSelRef.current && !readOnly) {
      done()
      const sel = inkSelRef.current
      ctl.current.deleteInk(sel.page, sel.ids)
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current && !readOnly) {
      done()
      deleteNote(selectedRef.current)
      return
    }
    // A selected mark, region or equation goes the same way; Undo brings it back.
    if ((e.key === 'Delete' || e.key === 'Backspace') && activeRef.current && !readOnly) {
      done()
      const id = activeRef.current
      logEvent('mark.delete', { mark: id })
      mutate((d) => removeTarget(d, id))
      setActive('')
      setTargetMenuId('')
      return
    }
    const el = scrollRef.current
    if (plain(e) && el) {
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        done()
        el.scrollTop += (e.key === 'PageDown' ? 1 : -1) * el.clientHeight * 0.9
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { done(); showPage(currentPage() + (e.key === 'ArrowRight' ? 1 : -1)); return }
      if (e.key === 'Home') { done(); showPage(0); return }
      if (e.key === 'End') { done(); showPage(offsets.length - 1); return }
    }
    if (!plain(e) || e.shiftKey) return
    if (!readOnly && key === 'h' && pendingSelRef.current) { done(); markPending(); return }
    if (!readOnly && key === 'n') { done(); noteFromKeys(); return }
    if (!readOnly && key === 'v') setTool('pen')
    else if (!readOnly && key === 'p' && !pc) setTool('pen')
    else if (!readOnly && key === 'r') setTool('region')
    else if (!readOnly && key === 'e' && (!pc || hasInk)) setTool('eraser')
    else if (!readOnly && key === 's' && (!pc || hasInk)) setTool('select')
    else if (!readOnly && key === 't') toggleText()
    else if (!readOnly && key === 'l') toggleLinks()
  }

  return (
    <div className="reader" data-testid="reader">
      {entry && (
        <div className="paper-head" data-testid="paper-head">
          <div className="paper-head-names" title={entry.meta.title}>
            <span className="paper-head-name" data-testid="paper-head-name">{paperLabel(entry.meta)}</span>
            {entry.meta.short_name?.trim() && <span className="paper-head-title" data-testid="paper-head-title">{entry.meta.title}</span>}
          </div>
          <button className="paper-head-edit" data-testid="edit-paper-details" title="Edit this paper's name, title, authors, year and link"
            onClick={() => setEditingDetails(detailsFor(entry.meta))}>
            <PencilIcon /> Edit details
          </button>
          <label className="tool-group" title="Reading status, shown in the library and on maps">
            <span className="zoom-label">Status</span>
            <select value={entry.meta.status} data-testid="status-select" onChange={(e) => void setStatus(e.target.value as PaperEntry['meta']['status'])}>
              <option value="unread">Unread</option>
              <option value="reading">Reading</option>
              <option value="read">Read</option>
            </select>
          </label>
        </div>
      )}
      {editingDetails && entry && (
        <DetailsDialog initial={editingDetails} onCancel={() => setEditingDetails(null)}
          onSave={(f) => {
            setEditingDetails(null)
            logEvent('paper.details', {})
            void window.api.updatePaper(entry.meta.id, patchFrom(f)).then(onEntryChanged)
          }} />
      )}
      <div className="toolbar">
        {!readOnly && pc && (
          <>
            <div className="tool-group" data-testid="pc-tools">
              <button className={tool === 'pen' ? 'on' : ''} data-testid="tool-select-pc" onClick={() => setTool('pen')}
                title="Select (V): drag over text to select it, over a figure to draw a box, from the margin to choose notes">Select</button>
              <button className={tool === 'region' ? 'on' : ''} data-testid="tool-region" onClick={() => setTool('region')}
                title="Region (R): drag round a figure, table or equation">Region</button>
              {hasInk && (
                <>
                  <button className={tool === 'select' ? 'on' : ''} data-testid="tool-select" onClick={() => setTool('select')}
                    title="Select ink (S): draw a loop round handwriting, then drag it">Select ink</button>
                  <button className={tool === 'eraser' ? 'on' : ''} data-testid="tool-eraser" onClick={() => setTool('eraser')}
                    title="Eraser (E): rubs out handwriting and marks">Eraser</button>
                </>
              )}
            </div>
            <div className="tool-group">
              <button data-testid="mark-button" disabled={!pendingSel} title={pendingSel ? 'Mark the selected text (H)' : 'Select text first'}
                onClick={() => markPending()}>Mark</button>
              <button data-testid="note-button" title="Margin note (N): about the selection or the active mark, or about nothing in particular"
                onClick={() => noteFromKeys()}>Margin note</button>
            </div>
            <div className="tool-group" data-testid="note-sizes" title="Text size of typed notes: new ones, or the selected one">
              {(['S', 'M', 'L'] as const).map((s) => (
                <button key={s} className={typedNoteSize === s ? 'on size-btn' : 'size-btn'} data-testid={`note-size-${s}`}
                  title={{ S: 'Small text', M: 'Medium text', L: 'Large text' }[s]}
                  onClick={() => {
                    const n = allNotes?.find((x) => x.id === selectedNoteId)
                    if (n && isTyped(n)) {
                      const base = typedFontSize(defaultZoom(), 'M')
                      mutate((d) => { const m = d.annotations.marginNotes.find((x) => x.id === n.id); if (m) m.fontSize = Math.round(base * TYPED_SIZE_FACTOR[s] * 10) / 10 })
                    }
                    onTypedNoteSize(s)
                    logEvent('note.size', { size: s })
                  }}>{s}</button>
              ))}
            </div>
          </>
        )}
        {!readOnly && !pc && (
          <div className="tool-group">
            {(['pen', 'region', 'eraser', 'select'] as Tool[]).map((t) => (
              <button key={t} className={tool === t ? 'on' : ''} data-testid={`tool-${t}`} onClick={() => setTool(t)}
                title={{ pen: 'Pen (P)', region: 'Region: drag around a figure, table or equation (R)', eraser: 'Eraser (E)', select: 'Select ink: draw a loop round some ink, then drag it (S)' }[t]}>
                {{ pen: 'Pen', region: 'Region', eraser: 'Eraser', select: 'Select ink' }[t]}
              </button>
            ))}
          </div>
        )}
        {!readOnly && !pc && tool === 'pen' && (
          <div className="tool-group pen-sizes" data-testid="pen-sizes">
            {PEN_SIZES.map((p, i) => (
              <button key={p.name} className={penSize === i ? 'on' : ''} data-testid={`pen-size-${i}`} title={`${p.name} pen`}
                onClick={() => {
                  setPenSize(i)
                  store(PEN_SIZE_KEY, String(i))
                  logEvent('pen.size', { size: p.name.toLowerCase() })
                }}>
                <span className="pen-dot" style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
              </button>
            ))}
          </div>
        )}
        {!readOnly && (
          <div className="tool-group">
            <button disabled={!canUndo} onClick={undo} data-testid="undo">Undo</button>
            <button disabled={!canRedo} onClick={redo} data-testid="redo">Redo</button>
          </div>
        )}
        {!readOnly && (!pc || hasInk) && (
          <button
            className={showText ? 'on' : ''}
            data-testid="toggle-text"
            title="Show or hide the typed version of your notes (T)"
            onClick={toggleText}
          >
            Typed text
          </button>
        )}
        <button className={findOpen ? 'on' : ''} data-testid="find-open" title="Find in this paper and in your notes (Ctrl+F)"
          onClick={() => (findOpen ? closeFind() : openFind())}>
          Find
        </button>
        {!readOnly && (
          <button
            className={showLinks ? 'on' : ''}
            data-testid="toggle-links"
            title="Show or hide the lines from notes to what they refer to (L)"
            onClick={toggleLinks}
          >
            Links
          </button>
        )}
        <div className="tool-group page-box" title="Type a page number and press Enter to go there">
          <input
            data-testid="page-input"
            inputMode="numeric"
            value={pageDraft ?? String(pageInView + 1)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => setPageDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = Number(pageDraft ?? pageInView + 1)
                if (n >= 1) {
                  const target = Math.min(n, sizes.length) - 1
                  showPage(target)
                  setPageInView(target)
                }
                setPageDraft(null)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setPageDraft(null)
                e.currentTarget.blur()
              }
            }}
          />
          <span className="page-count-label" data-testid="page-count">/ {sizes.length}</span>
        </div>
        <div className="tool-group">
          <button onClick={() => changeZoom(zoom / 1.15)}>−</button>
          <span className="zoom-label" data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
          <button onClick={() => changeZoom(zoom * 1.15)}>+</button>
          <button
            data-testid="fit"
            title="Switches between fitting the page and fitting the page with its writing margins (Ctrl+0)"
            onClick={fitNext}
          >
            {readOnly || nextFit === 'page' ? 'Fit page' : nextFit === 'notes' ? 'Fit page + notes' : 'Fit with margins'}
          </button>
        </div>
        {pc && (
          <div className="tool-group more-group">
            <button data-testid="more-menu" title="More: Tidy margin, keyboard shortcuts" onClick={() => setMoreMenu((v) => !v)}>⋯</button>
            {moreMenu && (
              <div className="context-menu more-menu" data-testid="more-menu-list">
                {!readOnly && <button data-testid="more-tidy" onClick={() => { setMoreMenu(false); tidyPage(currentPage()) }}>Tidy margin on this page</button>}
                <button data-testid="more-keys" onClick={() => { setMoreMenu(false); setShowKeys(true) }}>Keyboard shortcuts<kbd>?</kbd></button>
              </div>
            )}
          </div>
        )}
        {!pc && <button
          className={scrollLocked ? 'on' : ''}
          data-testid="scroll-lock"
          title="Lock the scrollbar, so a hand resting on it can't jump pages. Fingers still scroll."
          onClick={() => {
            const next = !scrollLocked
            setScrollLocked(next)
            store(SCROLL_LOCK_KEY, next ? '1' : '0')
            logEvent('scroll.lock', { on: next })
          }}
        >
          {scrollLocked ? 'Scrollbar locked' : 'Lock scrollbar'}
        </button>}
        <div className="spacer" />
        {!readOnly && <PanelToggle side="right" open={paneOpen} label="notes" testId="notes-toggle" onClick={() => setPaneOpen((v) => !v)} />}
      </div>

      {readOnly && (
        <div className="preview-banner" data-testid="preview-banner">
          <span><b>Preview only.</b> {title}</span>
          <button className="primary" data-testid="add-preview" onClick={() => void addPreviewToLibrary()}>Add to library</button>
        </div>
      )}
      {linkingNoteId && (
        <div className="info-banner" data-testid="linking-banner">
          <span>Mark some text or a region, or tap an existing mark, to link this note. Tapping anywhere else cancels.</span>
          <button data-testid="linking-cancel" onClick={() => setLinking('')}>Cancel</button>
        </div>
      )}
      {pc && pcStrip && !readOnly && (
        <div className="pc-strip" data-testid="pc-strip">
          <span>{sizes.length && !pageData.current.get(0)?.words.length ? 'Drag to mark an area' : 'Select text to mark it'} · Double-click the margin for a note · Right-click anything · Press ? for all keys</span>
          <span className="spacer" />
          <button data-testid="pc-strip-close" onClick={() => { setPcStrip(false); store(PC_STRIP_KEY, '1') }}>Got it</button>
        </div>
      )}
      {penOffer && (
        <div className="info-banner" data-testid="pen-offer">
          <span>A pen was used. Switch to Pen mode, where you write your notes by hand?</span>
          <span>
            <button className="primary" data-testid="pen-offer-switch" onClick={() => { setPenOffer(false); onSwitchMode('pen') }}>Switch</button>{' '}
            <button data-testid="pen-offer-dismiss" onClick={() => setPenOffer(false)}>Not now</button>
          </span>
        </div>
      )}
      {recognizerProblem && <div className="warn-banner" data-testid="recognizer-problem">Your ink is saved, but it could not be turned into text: {recognizerProblem}</div>}

      <div className="reader-body">
        {findOpen && (
          <div className="find-bar" data-testid="find-bar">
            <input
              ref={findInputRef}
              value={findQuery}
              placeholder="Find"
              data-testid="find-input"
              title="Enter: next · Shift+Enter: previous · Esc: close"
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); markFindMatch() }
                else if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1) }
              }}
            />
            <label className="find-check" title="Go through matches in the printed text">
              <input type="checkbox" data-testid="find-in-text" checked={findInText}
                onChange={(e) => { setFindInText(e.target.checked); setFindIndex(-1) }} />
              In text ({findHits.length})
            </label>
            <label className="find-check" title="Go through your handwritten margin notes">
              <input type="checkbox" data-testid="find-in-margin" checked={findInMargin}
                onChange={(e) => { setFindInMargin(e.target.checked); setFindIndex(-1) }} />
              Margin notes ({marginHits.length})
            </label>
            <label className="find-check" title="Go through the side notes in the notes pane, yours and generated ones">
              <input type="checkbox" data-testid="find-in-side" checked={findInSide}
                onChange={(e) => { setFindInSide(e.target.checked); setFindIndex(-1) }} />
              Side notes ({sideHits.length})
            </label>
            <button disabled={!findStops.length} data-testid="find-prev" title="Previous (Shift+Enter or Shift+F3)" onMouseDown={(e) => e.preventDefault()} onClick={() => findStep(-1)}>‹</button>
            <button disabled={!findStops.length} data-testid="find-next" title="Next (Enter or F3)" onMouseDown={(e) => e.preventDefault()} onClick={() => findStep(1)}>›</button>
            <span className="hint" data-testid="find-count">
              {findQuery.trim() === '' ? '' : findStops.length ? `${findIndex < 0 ? '–' : findIndex + 1} of ${findStops.length}` : 'No matches'}
            </span>
            <button data-testid="find-close" title="Close (Esc)" onClick={closeFind}>×</button>
          </div>
        )}
        <div className="pages-host">
        {linkBack && (
          <div className="link-back" data-testid="link-back">
            <button data-testid="link-back-go" onClick={() => {
              logEvent('link.back', { page: linkBack.page })
              centreOn(linkBack.page, linkBack.x, linkBack.y)
              setLinkBack(null)
            }}>← Back to p. {linkBack.page + 1}</button>
            <button data-testid="link-back-close" title="Hide" onClick={() => setLinkBack(null)}>×</button>
          </div>
        )}
        <canvas ref={liveRef} className="live-overlay" data-testid="live-overlay" />
        <div
          className={scrollLocked ? "pages-scroll no-bar" : "pages-scroll"}
          ref={scrollRef}
          data-testid="pages-scroll"
          onClick={(e) => {
            // A tap on the grey around the pages, as when zoomed out, ends a selection like a tap on blank paper.
            if ((e.target as Element).closest('.page-wrap')) return
            if (linkingRef.current) {
              logEvent('tap', { hit: 'outside', ends: 'linking', via: pointerVia() })
              setLinking('')
            } else if (activeRef.current || selectedRef.current || inkSel) {
              logEvent('tap', { hit: 'outside', ends: 'selection', via: pointerVia() })
              setActive('')
              setSelected('')
              setInkSel(null)
            }
          }}
          onScroll={() => {
            updateRange()
            const now = currentPage()
            if (now !== pageInView) setPageInView(now)
            if (pageLogTimer.current) clearTimeout(pageLogTimer.current)
            pageLogTimer.current = setTimeout(() => {
              const p = currentPage()
              if (p !== loggedPage.current) {
                logEvent('view.page', { page: p, from: loggedPage.current, of: offsets.length })
                loggedPage.current = p
              }
            }, 600)
            // Moving around mid-sentence is not the end of the writing.
            if (pending.current.length) schedule()
            // In PC mode a mark stops being the one new notes link to once it is a screen or more away.
            if (pc && activeRef.current && scrollRef.current) {
              const el = scrollRef.current
              const t = layerRef.current?.annotations.targets.find((x) => x.id === activeRef.current)
              const wrap = t?.page !== undefined ? el.querySelector<HTMLElement>(`[data-page="${t.page}"]`) : null
              const r = t?.rects?.[0]
              if (wrap && r) {
                const top = wrap.getBoundingClientRect().top + r[1] * zoomRef.current - el.getBoundingClientRect().top
                if (top < -el.clientHeight || top > el.clientHeight * 2) setActive('')
              }
            }
          }}
        >
          {loadError && <div className="load-error">{loadError}</div>}
          <div className="pages">
            {doc && sizes.map((size, i) => (
              <PageView
                key={i}
                index={i}
                doc={doc}
                size={size}
                zoom={zoom}
                renderZoom={renderZoom}
                showText={showText}
                showLinks={showLinks}
                highlights={highlightsByPage.get(i) ?? EMPTY_HIGHLIGHTS}
                margin={readOnly ? 0 : margin}
                visible={i >= range[0] && i <= range[1]}
                strokes={visibleByPage.get(i) ?? EMPTY_STROKES}
                targets={targetsByPage.get(i) ?? EMPTY_TARGETS}
                pageCount={sizes.length}
                wholePaperIds={wholePaperIds}
                notes={notesByPage.get(i) ?? EMPTY_NOTES}
                activeTargetId={activeTargetId}
                selectedNoteId={selectedNoteId}
                inkSelection={inkSel && inkSel.page === i ? inkSel.ids : null}
                connectFrom={connectNote && connectNote.page === i ? connectNote : null}
                pendingRects={pendingSel && pendingSel.page === i ? rectsForWords(words(i).slice(pendingSel.first, pendingSel.last + 1)) : null}
                pendingRect={pendingRect && pendingRect.page === i ? pendingRect.rect : null}
                chosenIds={chosen && chosen.page === i ? chosen.ids : null}
                editingNoteId={draft?.page === i ? draft.noteId ?? '' : ''}
                flashTargetId={flashTargetId}
                flashRects={linkFlash?.byPage.get(i) ?? null}
                flashKey={linkFlash?.key ?? 0}
                readOnly={readOnly}
                ctl={stableCtl.current}
              >
                {pendingSel && pendingSel.page === i && !readOnly && (() => {
                  const rects = rectsForWords(words(i).slice(pendingSel.first, pendingSel.last + 1))
                  if (!rects.length) return null
                  const quote = buildQuote(words(i), pendingSel.first, pendingSel.last).exact
                  const bottom = Math.max(...rects.map((r) => r[1] + r[3]))
                  const left = Math.min(...rects.map((r) => r[0]))
                  return (
                    <ActionBar left={(left + margin) * zoom} top={bottom * zoom + 6} anchorHeight={(bottom - Math.min(...rects.map((r) => r[1]))) * zoom} testId="selection-bar">
                      <button data-testid="sel-mark" onClick={() => markPending()}>Mark<kbd>H</kbd></button>
                      <button data-testid="sel-note" onClick={() => noteForPending()}>Note<kbd>N</kbd></button>
                      <button data-testid="sel-copy" onClick={() => { setPendingSel(null); void copyText(quote) }}>Copy<kbd>Ctrl+C</kbd></button>
                      {looksLikeReference(quote) && <button data-testid="sel-preview" onClick={() => { setPendingSel(null); void lookUpReference(quote) }}>Preview as a reference</button>}
                      {looksLikeReference(quote) && <button data-testid="sel-add-to-map" onClick={() => { setPendingSel(null); addReferenceToMap(quote) }}>Add to map</button>}
                    </ActionBar>
                  )
                })()}
                {pendingRect && pendingRect.page === i && !readOnly && (
                  <ActionBar left={(pendingRect.rect[0] + margin) * zoom} top={(pendingRect.rect[1] + pendingRect.rect[3]) * zoom + 6} anchorHeight={pendingRect.rect[3] * zoom} testId="rect-bar">
                    <button data-testid="rect-region" onClick={() => makeRegion(i, pendingRect.rect)}>Region</button>
                    <button data-testid="rect-note" onClick={() => { const t = makeRegion(i, pendingRect.rect); if (t) noteForTarget(t) }}>Note<kbd>N</kbd></button>
                    <button data-testid="rect-cancel" onClick={() => setPendingRect(null)}>Cancel</button>
                  </ActionBar>
                )}
                {draft && draft.page === i && (
                  <TypedEditor draft={draft} zoom={zoom} margin={margin} targets={allTargets ?? []}
                    onChange={(text) => setDraft({ ...draft, text })}
                    onUnlink={(id) => setDraft({ ...draft, targetIds: draft.targetIds.filter((x) => x !== id) })}
                    onCommit={() => commitDraft()} />
                )}
                {menuTarget && menuTarget.page === i && (                  <TargetMenu
                    target={menuTarget}
                    margin={margin}
                    zoom={zoom}
                    links={(() => {
                      const pd = pageData.current.get(i)
                      if (!pd) return []
                      const ml = markLinks(pd.words, pd.links, menuTarget.rects ?? [])
                      if (!ml.mostlyLinks) return []
                      // One entry per place a link goes: a link broken over two lines is one link.
                      const seen = new Set<string>()
                      return ml.links.flatMap((l) => {
                        const key = l.url ?? JSON.stringify(l.dest)
                        if (seen.has(key)) return []
                        seen.add(key)
                        const label = linkLabel(pd.words, l.rect)
                        return [{ link: l, label, reference: isReferenceLink(label) }]
                      })
                    })()}
                    onLinkPreview={(l) => { setActive(''); void previewFromLink(l) }}
                    onLinkToMap={readOnly ? undefined : (l) => {
                      setActive('')
                      void referenceFromLink(l).then((text) => { if (text !== null) addReferenceToMap(text) })
                    }}
                    onLinkGo={(l) => { setActive(''); void followLink(l) }}
                    onDelete={() => {
                      mutate((d) => removeTarget(d, menuTarget.id))
                      setActive('')
                    }}
                    onPreview={() => {
                      const quote = menuTarget.quote?.exact ?? ''
                      setActive('')
                      void lookUpReference(quote)
                    }}
                    isReference={looksLikeReference(menuTarget.quote?.exact ?? '') || inReferenceList(
                      Array.from({ length: menuTarget.page ?? 0 }, (_, p) => pageData.current.get(p)?.words).concat([words(menuTarget.page ?? 0)]),
                      menuTarget.page ?? 0, menuTarget.rects?.[0]?.[1] ?? 0)}
                    onAddToMap={readOnly ? undefined : () => {
                      setActive('')
                      addReferenceToMap(menuTarget.quote?.exact ?? '')
                    }}
                  />
                )}
                {selectedNote && selectedNote.page === i && !draft && (
                  <NoteMenu
                    note={selectedNote}
                    margin={margin}
                    zoom={zoom}
                    editing={editingNoteId === selectedNote.id}
                    targets={allTargets ?? []}
                    onEdit={() => setEditingNoteId(selectedNote.id)}
                    onSaveText={(text) => { logEvent('note.edit', { note: selectedNote.id, chars: text.length, before: selectedNote.text.length }); updateNote(selectedNote.id, { text, corrected: true }); setEditingNoteId('') }}
                    onCancelEdit={() => setEditingNoteId('')}
                    onPickReading={(reading) => updateNote(selectedNote.id, {
                      text: reading.text,
                      candidates: [],
                      corrected: true,
                      engine: selectedNote.engine ? { ...selectedNote.engine, recognizer: reading.recognizer } : undefined,
                      alternatives: [
                        ...(selectedNote.alternatives ?? []).filter((a) => a !== reading),
                        { text: selectedNote.text, recognizer: selectedNote.engine?.recognizer ?? '' }
                      ]
                    })}
                    onKind={(kind) => updateNote(selectedNote.id, { kind })}
                    onLink={() => setLinking(selectedNote.id)}
                    onEditTyped={() => openEditor(selectedNote)}
                    onConvert={() => convertToTyped(selectedNote.id)}
                    onBackToInk={() => backToInk(selectedNote.id)}
                    onLinkPage={() => linkWhole(selectedNote.id, 'page', selectedNote.page)}
                    onLinkPaper={() => linkWhole(selectedNote.id, 'paper', selectedNote.page)}
                    onUnlink={(id) => updateNote(selectedNote.id, { targetIds: selectedNote.targetIds.filter((x) => x !== id) })}
                    onJump={jumpToTarget}
                    onDelete={() => deleteNote(selectedNote.id)}
                  />
                )}
              </PageView>
            ))}
          </div>
        </div>
        </div>
        {entry && paneOpen && (
          <div className="side-shell right" style={{ width: pane.width }} data-testid="notes-shell">
          <ResizeHandle side="right" width={pane.width} onWidth={pane.setWidth} testId="notes-resize" />
          <RightPane
            entry={entry}
            annotations={layer?.annotations ?? null}
            onJumpNote={(n) => { scrollTo(n.page, n.box[1]); setSelected(n.id) }}
            onJumpTarget={jumpToTarget}
            onShowNote={showNote}
            onShowMark={showMark}
            onJumpPage={(page) => { logEvent('sidenote.link', { to: 'page', page }); scrollTo(page, 0) }}
            onJumpText={(page, quote) => void showQuote(page, quote)}
            onWebLink={(text, url, x, y) => {
              logEvent('sidenote.link', { to: 'web', via: pointerVia() })
              // The arXiv id or DOI in the address finds the paper; otherwise the title in the text does.
              const ref = findArxivId(url) || findDoi(url) ? `${text} ${url}` : text || url
              const page = linkPage(text, url)
              const items: Menu['items'] = [{ label: page ? `Open at p. ${page}` : 'Preview this reference', testId: 'menu-preview', run: () => void lookUpReference(ref, page ? page - 1 : undefined) }]
              if (!readOnly) items.push({ label: 'Add to map as a suggestion', testId: 'menu-add-to-map', run: () => addReferenceToMap(ref) })
              items.push({ label: 'Go to link', testId: 'menu-go-to-link', run: () => void window.api.openExternal(url) })
              setMenu({ x, y, items })
            }}
            findQuery={findOpen && findInSide ? findQuery : ''}
            findFocus={findOpen && findInSide ? sideFocus : null}
            newNoteTick={newNoteTick}
            mathLayout={mathLayout}
          />
          </div>
        )}
      </div>

      {menu && (
        <>
          <div className="menu-backdrop" onPointerDown={() => setMenu(null)} />
          <div className="context-menu" data-testid="context-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 40 * menu.items.length - 20) }}>
            {menu.items.map((item) => (
              <button key={item.label} data-testid={item.testId} onClick={() => { setMenu(null); item.run() }}>{item.label}{item.keys && <kbd>{item.keys}</kbd>}</button>
            ))}
          </div>
        </>
      )}
      {showKeys && <KeySheet pc={pc} onClose={() => setShowKeys(false)} />}
      <span hidden data-schema={SCHEMA_VERSION} />
    </div>
  )
}

const EMPTY_STROKES: Stroke[] = []
const EMPTY_HIGHLIGHTS: { rects: Rect[]; current: boolean }[] = []
const EMPTY_TARGETS: Target[] = []
const EMPTY_NOTES: MarginNote[] = []

function groupBy<T>(items: T[], key: (t: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = out.get(k)
    if (list) list.push(it)
    else out.set(k, [it])
  }
  return out
}

interface NoteMenuProps {
  onEditTyped: () => void
  onConvert: () => void
  onBackToInk: () => void
  note: MarginNote
  margin: number
  zoom: number
  editing: boolean
  targets: Target[]
  onEdit: () => void
  onSaveText: (t: string) => void
  onCancelEdit: () => void
  onPickReading: (r: NoteReading) => void
  onKind: (k: MarginNote['kind']) => void
  onLink: () => void
  onLinkPage: () => void
  onLinkPaper: () => void
  onUnlink: (id: string) => void
  onJump: (id: string) => void
  onDelete: () => void
}

/**
 * Moves a menu so it stays inside the visible part of the pages, never under the window edge or
 * the notes pane. It goes above what it belongs to if there is no room below.
 */
function useKeptInView(anchorHeight: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState<[number, number]>([0, 0])
  const measure = useCallback(() => {
    const el = ref.current
    const host = el?.closest('.pages-scroll')
    if (!el || !host) return
    const saved = el.style.transform
    el.style.transform = 'none'
    const r = el.getBoundingClientRect()
    el.style.transform = saved
    const view = host.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (r.right > view.right - 18) dx = view.right - 18 - r.right
    if (r.left + dx < view.left + 6) dx = view.left + 6 - r.left
    if (r.bottom > view.bottom - 6 && r.top - anchorHeight - r.height - 14 > view.top) dy = -(r.height + anchorHeight + 14)
    setShift((s) => (s[0] === dx && s[1] === dy ? s : [dx, dy]))
  }, [anchorHeight])
  useLayoutEffect(() => {
    measure()
    const host = ref.current?.closest('.pages-scroll')
    host?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      host?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  })
  return { ref, style: { transform: `translate(${shift[0]}px, ${shift[1]}px)` } }
}

/**
 * Whether a link in the paper goes to a reference (a citation), rather than to one of its own
 * figures, tables, algorithms, equations or sections.
 */
function isReferenceLink(label: string): boolean {
  if (floatOf(label)) return false
  // A keyword straight before its number: "Eq. 3", "Section 4.2", "§2", "Lemma 1"; not "Cortes et al.".
  return !/^\(?\s*(eqs?|eqn|equations?|secs?|sections?|§|app|appendix|appendices|ch|chapters?|lines?|thm|theorems?|lemmas?|defs?|definitions?|props?|propositions?|cor|corollar(y|ies))\.?\s*~?\s*[A-Z]?\d/i.test(label.trim())
}

/** The menu of a tapped mark: an underline, circle, selection or region. */
function TargetMenu({ target, margin, zoom, isReference, onDelete, onPreview, onAddToMap, links, onLinkPreview, onLinkToMap, onLinkGo }: {
  target: Target
  /** A citation or a reference entry, which can be looked up or added to a map. */
  isReference: boolean
  margin: number
  zoom: number
  onDelete: () => void
  onPreview: () => void
  onAddToMap?: () => void
  /** When the mark is nearly all links, each of them, so they can still be followed. */
  links: { link: PdfLink; label: string; reference: boolean }[]
  onLinkPreview: (l: PdfLink) => void
  onLinkToMap?: (l: PdfLink) => void
  onLinkGo: (l: PdfLink) => void
}) {
  const rects = target.rects ?? []
  const bottom = Math.max(...rects.map((r) => r[1] + r[3]))
  const left = Math.min(...rects.map((r) => r[0]))
  const label = target.kind === 'region' ? targetLabel(target) : `“${shortenMath(target.display ?? target.quote?.exact ?? '', 80)}”`
  const top = Math.min(...rects.map((r) => r[1]))
  const kept = useKeptInView((bottom - top) * zoom)
  return (
    <div ref={kept.ref} className="note-menu" data-testid="target-menu" style={{ left: (left + margin) * zoom, top: bottom * zoom + (target.kind === 'region' ? 14 : 6), ...kept.style }}>
      <div className="menu-row">
        <div className="menu-text" data-testid="target-label"><MathText text={label} /></div>
        {/* Only a citation or a reference entry can be looked up or added to a map. */}
        {target.kind === 'text' && isReference && links.length === 0 && (
          <>
            <button data-testid="target-preview" onClick={onPreview}>Preview as a reference</button>
            {onAddToMap && <button data-testid="target-add-to-map" onClick={onAddToMap}>Add to map</button>}
          </>
        )}
        <button data-testid="target-delete" onClick={onDelete}>Delete mark</button>
      </div>
      {/* The mark is nearly all links: their own choices, which the mark would otherwise hide. */}
      {links.map(({ link, label, reference }, i) => (
        <div key={i} className="menu-row target-link-row" data-testid="target-link-actions">
          {links.length > 1 && <span className="menu-hint" data-testid="target-link-label">{label.length > 40 ? label.slice(0, 39) + '…' : label}</span>}
          {link.url ? (
            <button data-testid="target-link-go" onClick={() => onLinkGo(link)}>Open link in browser</button>
          ) : (
            <>
              {reference && <button data-testid="target-link-preview" onClick={() => onLinkPreview(link)}>Preview this reference</button>}
              {reference && onLinkToMap && <button data-testid="target-link-to-map" onClick={() => onLinkToMap(link)}>Add to map as a suggestion</button>}
              <button data-testid="target-link-go" onClick={() => onLinkGo(link)}>Go to link</button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

function NoteMenu(p: NoteMenuProps) {
  const [x, y, , h] = p.note.box
  const [text, setText] = useState(p.note.text)
  useEffect(() => setText(p.note.text), [p.note.text])
  const [showReadings, setShowReadings] = useState(false)
  const describe = (t: Target | undefined): string => {
    if (!t) return ''
    if (t.kind === 'text') return `“${shortenMath(t.display ?? t.quote?.exact ?? '', 60)}”`
    return targetLabel(t, true)
  }
  const kept = useKeptInView(h * p.zoom)
  return (
    <div ref={kept.ref} className="note-menu" data-testid="note-menu" style={{ left: (x + p.margin) * p.zoom, top: (y + h) * p.zoom + 4, ...kept.style }}>
      {p.editing ? (
        <div className="edit-row">
          <textarea value={text} data-testid="note-edit-text" autoFocus onChange={(e) => setText(e.target.value)}
            title="Enter saves, Shift+Enter starts a new line, Esc cancels"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); p.onSaveText(text) }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onCancelEdit() }
            }} />
          <button className="primary" data-testid="note-save-text" onClick={() => p.onSaveText(text)}>Save</button>
          <button onClick={p.onCancelEdit}>Cancel</button>
        </div>
      ) : isTyped(p.note) ? (
        <div className="menu-row">
          <span className="menu-hint">Drag to move it, a side to change its width · double-click or Enter to edit</span>
          <button data-testid="note-edit-open" onClick={p.onEditTyped}>Edit</button>
          <button data-testid="note-link" onClick={p.onLink}>Link…</button>
          <button onClick={p.onLinkPage}>This page</button>
          <button onClick={p.onLinkPaper}>Whole paper</button>
          {p.note.hiddenInk?.length ? <button data-testid="note-back-to-ink" onClick={p.onBackToInk}>Back to ink</button> : null}
          <button data-testid="note-delete" onClick={p.onDelete}>Delete note</button>
        </div>
      ) : (
        <div className="menu-row">
          <div className="menu-text" data-testid="note-transcription">{p.note.text || 'Not recognized yet'}</div>
          <span className="menu-hint" data-testid="note-move-hint">Drag ✥ to move it, a corner to resize</span>
          <button data-testid="note-edit-open" onClick={p.onEdit}>Edit text</button>
          <button data-testid="note-drawing" className={p.note.kind === 'drawing' ? 'on' : ''} onClick={() => p.onKind(p.note.kind === 'drawing' ? 'note' : 'drawing')}>Drawing</button>
          <button data-testid="note-link" onClick={p.onLink}>Link…</button>
          <button onClick={p.onLinkPage}>This page</button>
          <button onClick={p.onLinkPaper}>Whole paper</button>
          <button data-testid="note-convert" title="Make it a typed note with the same text and links; the ink is kept and can come back" onClick={p.onConvert}>Convert to typed</button>
          <button data-testid="note-delete" onClick={p.onDelete}>Delete note</button>
        </div>
      )}
      {p.note.targetIds.length > 0 && (
        <div className="menu-section" data-testid="note-links">
          <div className="menu-section-label">Linked to</div>
          <div className="menu-targets">
            {p.note.targetIds.map((id) => (
              <span key={id} className="link-chip">
                <button title="Go to it" onClick={() => p.onJump(id)}>↗ <MathText text={describe(p.targets.find((t) => t.id === id))} /></button>
                <button title="Remove this link" data-testid="note-unlink" onClick={() => p.onUnlink(id)}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      {!p.editing && (p.note.alternatives?.length ?? 0) > 0 && (
        <div className="menu-section" data-testid="note-alternatives">
          <button className="readings-toggle" data-testid="readings-toggle" onClick={() => setShowReadings((v) => !v)}>
            Other readings ({p.note.alternatives?.length}) {showReadings ? '▾' : '▸'}
          </button>
          {showReadings && (
            <ul className="readings-list">
              {p.note.alternatives?.map((a) => (
                <li key={`${a.recognizer}-${a.text}`}>
                  <span className="reading-text" title={a.recognizer}>{a.text}</span>
                  <button data-testid="note-alternative" title="Use this reading instead" onClick={() => p.onPickReading(a)}>Use</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** A small bar of actions under a selection or a dragged box, kept inside the view. */
function ActionBar({ left, top, anchorHeight, testId, children }: { left: number; top: number; anchorHeight: number; testId: string; children: React.ReactNode }) {
  const kept = useKeptInView(anchorHeight)
  return (
    <div ref={kept.ref} className="sel-bar" data-testid={testId} style={{ left, top, ...kept.style }}
      onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

/**
 * The editor for a typed note, in the note's place. Enter saves, Shift+Enter starts a new line,
 * Esc or a click elsewhere also saves; Ctrl+Z right after takes the whole edit back.
 */
function TypedEditor({ draft, zoom, margin, targets, onChange, onUnlink, onCommit }: {
  draft: { box: Rect; fontSize: number; text: string; targetIds: string[]; noteId?: string }
  zoom: number
  margin: number
  targets: Target[]
  onChange: (text: string) => void
  onUnlink: (id: string) => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Never drawn smaller than 13 px while typing, so it is readable at any zoom.
  const px = Math.max(13, draft.fontSize * zoom)
  const width = Math.max(draft.box[2] * zoom * (px / (draft.fontSize * zoom)), 170)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [draft.text, px, width])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const linked = draft.targetIds.map((id) => targets.find((t) => t.id === id)).filter((t): t is Target => !!t)
  const describe = (t: Target) => {
    const where = t.page !== undefined ? ` (p. ${t.page + 1})` : ''
    if (t.kind === 'text') return `“${shortenMath(t.display ?? t.quote?.exact ?? '', 40)}”${where}`
    return targetLabel(t, true)
  }
  return (
    <div className="typed-editor" data-testid="typed-editor" style={{ left: (draft.box[0] + margin) * zoom, top: draft.box[1] * zoom - 22 }}
      onPointerDown={(e) => e.stopPropagation()}>
      {linked.length ? linked.map((t) => (
        <span key={t.id} className="typed-chip" data-testid="typed-chip">
          Linked to <MathText text={describe(t)} />
          <button title="Unlink" data-testid="typed-chip-unlink" onClick={() => onUnlink(t.id)}>×</button>
        </span>
      )) : (
        <span className="typed-chip none" data-testid="typed-chip-none">No target{draft.noteId ? ' · Link… (Ctrl+K after saving)' : ''}</span>
      )}
      <textarea ref={ref} value={draft.text} data-testid="typed-input" spellCheck
        placeholder="Type your note…" style={{ fontSize: px, width }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit() }
          else if (e.key === 'Escape') { e.preventDefault(); onCommit() }
        }} />
      <span className="typed-hint">Enter saves · Shift+Enter new line · $x^2$ for maths</span>
    </div>
  )
}

/** Every key and mouse action, from ? or F1. */
function KeySheet({ pc, onClose }: { pc: boolean; onClose: () => void }) {
  const rows: [string, [string, string][]][] = [
    ['Mouse on a page', [
      ['Drag over text', 'Select it: then Mark, Note or Copy'],
      ['Double-click a word', 'Select the word'],
      ['Drag over a figure or blank paper; Alt+drag; R then drag', 'A box: Region, or an equation box round displayed maths'],
      ['Drag from the margin; Shift+drag', 'Choose the notes and marks inside'],
      ['Double-click the margin or blank paper', 'New typed note there, linked to the active mark'],
      ['Click a note / a mark / a citation', 'Select it / make it active / its menu'],
      ['Double-click a note', 'Edit it'],
      ['Drag a note; drag its side', 'Move it; change its width'],
      ['Right-click anything', 'Its menu, with keys'],
      ['Wheel, Shift+wheel, Ctrl+wheel', 'Scroll, sideways, zoom']
    ]],
    ['Notes and marks', [
      ['H', 'Mark the selection'],
      ['N', 'Margin note: about the selection or active mark, or about nothing'],
      ['Enter, F2', 'Edit the selected note'],
      ['In a note: Enter / Shift+Enter / Esc', 'Save / new line / save and close (Ctrl+Z takes it back)'],
      ['Ctrl+K', 'Link the selected note'],
      ['Delete', 'Delete what is selected'],
      ['Alt+↓ / Alt+↑', 'Next / previous note'],
      ['Arrows, Shift+arrows', 'Move a clicked note (Esc lets go)'],
      ['Shift+→ ← / Shift+↓ ↑ / Shift+End', 'Grow or shrink the active mark by a word / a line / to the end of the sentence'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste as a note about the active mark'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo']
    ]],
    ['Moving around', [
      ['Space / Shift+Space, PageDown/PageUp', 'Screen down / up'],
      ['→ ←, Home, End', 'Next / previous page, first, last'],
      ['Ctrl+= / Ctrl+− / Ctrl+0', pc ? 'Zoom in, out, Fit page + notes ↔ Fit page' : 'Zoom in, out, Fit'],
      ['Ctrl+G', 'Go to a page (next match while Find is open)'],
      ['Ctrl+F, Enter, Shift+Enter, Ctrl+Enter', 'Find, next, previous, mark the match'],
      ['Alt+←', 'Back after following a link'],
      ['T / L', 'Typed text for handwriting / links, on or off'],
      ['V / R / S / E', pc ? 'Select / Region / Select ink / Eraser (the last two on papers with handwriting)' : 'Select / Region / Select ink / Eraser; P: Pen'],
      ['Ctrl+N / Ctrl+W / Ctrl+Tab', 'Side note / close the tab / next tab'],
      ['? or F1', 'This list']
    ]]
  ]
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal key-sheet" data-testid="key-sheet" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Keys and mouse</h3>
        {rows.map(([title, list]) => (
          <div key={title}>
            <h4>{title}</h4>
            <table><tbody>{list.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
          </div>
        ))}
        <div className="modal-actions"><button className="primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
