import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { InkPoint, MarginNote, NoteReading, PaperEntry, PreviewItem, Rect, SCHEMA_VERSION, Stroke, Target, paperLabel, type InputMode } from '../../shared/types'
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
  items: { label: string; run: () => void; testId?: string }[]
}

export function Reader({ source, active, marginShare, inputMode, onLookUp, onAddToMap, onPreviewAdded, onEntryChanged, notify }: Props) {
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
  const [showText, setShowText] = useState(readShowText)
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
  const [nextFit, setNextFit] = useState<'page' | 'margins'>('page')
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
    const z = Math.min(1.6, Math.max(0.7, (el.clientWidth - 40) / (sizes[0].width + shown * 2)))
    setZoom(z)
    setRenderZoom(z)
  }, [sizes, active, margin, readOnly])

  // Bitmaps are redrawn once a zoom settles. Until then the existing ones are stretched, as in a PDF viewer.
  useEffect(() => {
    if (zoom === renderZoom) return
    const t = setTimeout(() => setRenderZoom(zoom), SETTLE_ZOOM_MS)
    return () => clearTimeout(t)
  }, [zoom, renderZoom])

  /** After a Fit, lines the left edge of the page, or of its margin, up with the view. */
  const alignRef = useRef<'page' | 'wrap' | null>(null)
  const alignNow = () => {
    const el = scrollRef.current
    const how = alignRef.current
    alignRef.current = null
    const wrap = el?.querySelector<HTMLElement>('[data-page]')
    if (!el || !how || !wrap) return
    el.scrollLeft = wrap.offsetLeft + (how === 'page' && !readOnly ? margin * zoomRef.current : 0) - 12
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
  const addTarget = useCallback((target: Target, stroke?: Stroke) => {
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
      if (active && canExtendTarget(active, target, Date.parse(target.createdAt) - lastDrawn)) {
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
    if (activeRef.current || selectedRef.current) { logEvent('tap', { hit: 'empty', ends: 'selection', page, via: pointerVia() }); setActive(''); setSelected(''); return true }
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

  ctl.current = {
    toolRef,
    penSeen: () => { lastPen.current = Date.now() },
    // A finger that writes is never a palm to ignore.
    isPalm: () => inputMode !== 'touch' && Date.now() - lastPen.current < PALM_WINDOW_MS,
    writingRecently: () => inputMode !== 'touch' && Date.now() - lastPen.current < PALM_MENU_MS,
    touchWrites: () => inputMode === 'touch',
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
      // A typed label can only be rubbed out while it is on show.
      const note = showTextRef.current && hitStrokes.length === 0
        ? current.annotations.marginNotes.find((n) => n.page === page && n.kind !== 'drawing' && n.text !== '' && pointInRect(n.box, x, y, 2))
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
    finishRegion: (page, rect: Rect) => {
      if (rect[2] < 8 || rect[3] < 8) return
      const stamp = new Date().toISOString()
      const target: Target = { id: newId('t'), kind: 'region', page, rects: [rect], style: 'region', createdAt: stamp }
      addTarget(target)
      setTool('pen')
      savePicture(target)
    },
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
      if (readOnly) return
      const pw = words(page)
      const s = wordAt(pw, a[0], a[1], 4) ?? nearestWord(pw, a[0], a[1], 12)
      const e = nearestWord(pw, b[0], b[1])
      if (!s || !e) return
      const first = Math.min(s.index, e.index)
      const last = Math.max(s.index, e.index)
      addTarget({
        id: newId('t'), kind: 'text', page, quote: buildQuote(pw, first, last), ...(readableQuote(pw, first, last) ? { display: readableQuote(pw, first, last) } : {}),
        rects: rectsForWords(pw.slice(first, last + 1)), style: 'selection', createdAt: new Date().toISOString()
      })
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
      if (active?.kind === 'text' && active.quote) {
        const quote = active.quote.exact
        items.push({ label: 'Preview reference from selected text', testId: 'menu-preview-selection', run: () => void lookUpReference(quote) })
        if (!readOnly) items.push({ label: 'Add selected reference to map', testId: 'menu-add-selection-to-map', run: () => addReferenceToMap(quote) })
      }
      if (items.length) setMenu({ x: clientX, y: clientY, items })
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
      if (touches.current.size === 1 && el && inputMode !== 'touch') {
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
      if (wasOne && !swipe.current.pinched && e.type === 'pointerup' && inputMode !== 'touch') {
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

  const allNotes = layer?.annotations.marginNotes
  const allTargets = layer?.annotations.targets
  const allStrokes = layer?.ink.strokes

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
  const fitNext = () => {
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

  onKeyRef.current = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    const done = () => e.preventDefault()
    if (mod(e) && key === 'f') { done(); openFind(); return }
    if (e.key === 'F3') {
      done()
      if (!findOpen) openFind()
      else findStep(e.shiftKey ? -1 : 1)
      return
    }
    if (e.key === 'Escape') { setActive(''); setSelected(''); setLinking(''); setMenu(null); setInkSel(null); closeFind() }
    if (mod(e) && (key === '=' || key === '+')) { done(); changeZoom(zoomRef.current * 1.15); return }
    if (mod(e) && (key === '-' || key === '_')) { done(); changeZoom(zoomRef.current / 1.15); return }
    if (mod(e) && key === '0') { done(); fitNext(); return }
    if (isTyping(e)) return
    if (mod(e) && key === 'z') { done(); if (e.shiftKey) redo(); else undo(); return }
    if (mod(e) && key === 'y') { done(); redo(); return }
    if (!readOnly && mod(e) && key === 'n') { done(); setNewNoteTick((t) => t + 1); return }
    if (!readOnly && mod(e) && key === 'e' && selectedRef.current) { done(); setEditingNoteId(selectedRef.current); return }
    if (!readOnly && mod(e) && key === 'k' && selectedRef.current) { done(); setLinking(selectedRef.current); return }
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
    if (!readOnly && key === 'p') setTool('pen')
    else if (!readOnly && key === 'r') setTool('region')
    else if (!readOnly && key === 'e') setTool('eraser')
    else if (!readOnly && key === 's') setTool('select')
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
        {!readOnly && (
          <div className="tool-group">
            {(['pen', 'region', 'eraser', 'select'] as Tool[]).map((t) => (
              <button key={t} className={tool === t ? 'on' : ''} data-testid={`tool-${t}`} onClick={() => setTool(t)}
                title={{ pen: 'Pen (P)', region: 'Region: drag around a figure, table or equation (R)', eraser: 'Eraser (E)', select: 'Select ink: draw a loop round some ink, then drag it (S)' }[t]}>
                {{ pen: 'Pen', region: 'Region', eraser: 'Eraser', select: 'Select ink' }[t]}
              </button>
            ))}
          </div>
        )}
        {!readOnly && tool === 'pen' && (
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
        {!readOnly && (
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
            {readOnly || nextFit === 'page' ? 'Fit page' : 'Fit with margins'}
          </button>
        </div>
        <button
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
        </button>
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
                if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1) }
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
                flashTargetId={flashTargetId}
                flashRects={linkFlash?.byPage.get(i) ?? null}
                flashKey={linkFlash?.key ?? 0}
                readOnly={readOnly}
                ctl={stableCtl.current}
              >
                {menuTarget && menuTarget.page === i && (
                  <TargetMenu
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
                {selectedNote && selectedNote.page === i && (
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
              <button key={item.label} data-testid={item.testId} onClick={() => { setMenu(null); item.run() }}>{item.label}</button>
            ))}
          </div>
        </>
      )}
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
      ) : (
        <div className="menu-row">
          <div className="menu-text" data-testid="note-transcription">{p.note.text || 'Not recognized yet'}</div>
          <span className="menu-hint" data-testid="note-move-hint">Drag ✥ to move it, a corner to resize</span>
          <button data-testid="note-edit-open" onClick={p.onEdit}>Edit text</button>
          <button data-testid="note-drawing" className={p.note.kind === 'drawing' ? 'on' : ''} onClick={() => p.onKind(p.note.kind === 'drawing' ? 'note' : 'drawing')}>Drawing</button>
          <button data-testid="note-link" onClick={p.onLink}>Link…</button>
          <button onClick={p.onLinkPage}>This page</button>
          <button onClick={p.onLinkPaper}>Whole paper</button>
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
