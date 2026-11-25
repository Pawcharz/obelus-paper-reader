import { memo, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { InkPoint, MarginNote, Rect, Stroke, Target, isTyped } from '../../shared/types'
import { MathText } from '../MathText'
import { TYPED_LINE } from '../../shared/typedNotes'
import { PdfDoc, PageSize } from './pdf'
import { adjustRegion, joinLines, outlineBlocks, outlinePath } from '../../shared/markShape'

export type Tool = 'pen' | 'region' | 'eraser' | 'select'

export const INK_COLOR = '#1f3a93'
export const INK_WIDTH = 1.1

const MAX_PDF_PIXELS = 16_000_000
const MAX_INK_PIXELS = 8_000_000

/** A client position and pen pressure, for drawing the stroke in progress. */
export type LivePoint = [number, number, number]

/** Actions the page reports. Coordinates are PDF page units unless named client. */
export interface PageController {
  toolRef: React.MutableRefObject<Tool>
  /** True when a finger, the mouse or a simple stylus writes, instead of only an active pen. */
  touchWrites(): boolean
  /** How many fingers are on the page now. */
  touchCount(): number
  penSeen(): void
  /** The pen was on the page a moment ago, so a hand touching the screen is most likely resting on it. */
  writingRecently(): boolean
  isPalm(): boolean
  penStroke(page: number, points: InkPoint[]): void
  beforeStroke(): void
  liveDraw(from: LivePoint, to: LivePoint[]): void
  strokeCancelled(): void
  tap(page: number, x: number, y: number): void
  eraseStart(): void
  eraseAt(page: number, x: number, y: number): void
  finishRegion(page: number, rect: Rect): void
  /** The selected note was dragged by this much, in page units. */
  moveNote(page: number, noteId: string, dx: number, dy: number): void
  /** A region was moved or resized by its handles to this box, in page units. */
  setTargetRect(page: number, targetId: string, rect: Rect): void
  /** A loop was drawn with Select ink; an empty loop clears the selection. */
  selectInk(page: number, loop: [number, number][]): void
  /** The selected ink was dragged by this much, in page units. */
  moveInk(page: number, ids: ReadonlySet<string>, dx: number, dy: number): void
  deleteInk(page: number, ids: ReadonlySet<string>): void
  /** The selected ink, or a note, made larger or smaller by this factor about the anchor point. */
  scaleInk(page: number, ids: ReadonlySet<string>, factor: number, anchor?: [number, number]): void
  selectionPreview(page: number, a: [number, number], b: [number, number]): Rect[]
  /** A mouse drag over text: the words become a selection, marked only when an action is chosen. */
  finishSelection(page: number, a: [number, number], b: [number, number], clientX: number, clientY: number): void
  /** The note under a point, or ''. */
  noteAt(page: number, x: number, y: number): string
  /** Whether a point is on or close to printed words, where a mouse drag selects text. */
  onText(page: number, x: number, y: number): boolean
  /** A rectangle dragged with the mouse over no text. `now`: make the region at once (Region tool, Alt+drag). */
  finishRect(page: number, rect: Rect, now: boolean, clientX: number, clientY: number): void
  /** A rubber band, from a margin or with Shift: chooses the notes and marks fully inside it. */
  band(page: number, rect: Rect, add: boolean): void
  /** A mouse double-click: a word, a note to edit, or a new typed note on blank space. */
  doubleClick(page: number, x: number, y: number): void
  /** A typed note's new left edge and width, from dragging its side. */
  setNoteWidth(page: number, noteId: string, x: number, width: number): void
  /** A typed note's drawn height, so the stored box and hit tests follow its text. */
  noteHeight(noteId: string, height: number): void
  hover(page: number, x: number, y: number): void
  contextMenu(page: number, x: number, y: number, clientX: number, clientY: number): void
  touchStart(e: React.PointerEvent): void
  touchMove(e: React.PointerEvent): void
  touchEnd(e: React.PointerEvent): void
}

interface Props {
  index: number
  doc: PdfDoc
  size: PageSize
  /** The zoom used for layout, which changes continuously during a pinch. */
  zoom: number
  /** The zoom bitmaps are drawn at. It settles after a pinch, so a pinch stays smooth. */
  renderZoom: number
  margin: number
  visible: boolean
  showText: boolean
  /** Draws a line from every note on the page to each of its targets. */
  showLinks: boolean
  /** Find matches on this page; the current one is drawn stronger. */
  highlights: { rects: Rect[]; current: boolean }[]
  strokes: Stroke[]
  targets: Target[]
  notes: MarginNote[]
  activeTargetId: string
  selectedNoteId: string
  connectFrom: MarginNote | null
  flashTargetId: string
  /** Boxes on this page that blink and fade, after following a link from a side note. */
  flashRects: Rect[] | null
  /** Changes with each new flash, so the same boxes can flash again. */
  flashKey: number
  readOnly: boolean
  /** How many pages the paper has, for the page number. */
  pageCount: number
  /** Marks that stand for the whole paper, which belong to no page. */
  wholePaperIds: ReadonlySet<string>
  /** Ink chosen with Select ink on this page. */
  inkSelection: ReadonlySet<string> | null
  /** Selected words not yet marked, shown blue. */
  pendingRects: Rect[] | null
  /** A dragged rectangle not yet made into anything, with its own bar. */
  pendingRect: Rect | null
  /** Notes and marks chosen together with a rubber band. */
  chosenIds: ReadonlySet<string> | null
  /** A typed note being edited is hidden: its editor sits in its place. */
  editingNoteId: string
  ctl: PageController
  children?: ReactNode
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Pick<Stroke, 'points' | 'color' | 'width'>): void {
  ctx.strokeStyle = s.color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const pts = s.points
  if (pts.length === 1) {
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.arc(pts[0][0], pts[0][1], s.width * 0.6, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  for (let i = 1; i < pts.length; i++) {
    ctx.lineWidth = s.width * (0.65 + 0.7 * (pts[i][2] || 0.5))
    ctx.beginPath()
    ctx.moveTo(pts[i - 1][0], pts[i - 1][1])
    ctx.lineTo(pts[i][0], pts[i][1])
    ctx.stroke()
  }
}

function targetShape(t: Target, active: boolean, flash: boolean): ReactNode {
  const stroke = active || flash ? '#d9480f' : '#2b6cb0'
  // A marked line of text or equation is drawn as one box per line, not one per word or symbol.
  const rects = t.style === 'region' || t.style === 'equation' ? t.rects : joinLines(t.rects ?? [])
  if (t.style === 'circle') {
    // Lines that follow each other share one outline, as if circled in one go.
    const padded = (rects ?? []).map((r): Rect => [r[0] - 2, r[1] - 1, r[2] + 4, r[3] + 2])
    return outlineBlocks(padded).map((block, i) => (
      <path key={`${t.id}-${i}`} data-target={t.id} d={outlinePath(block)}
        fill={active ? '#ffa94d55' : 'none'} stroke={stroke} strokeWidth={1.1} strokeLinejoin="round" />
    ))
  }
  return rects?.map((r, i) => {
    const key = `${t.id}-${i}`
    if (t.style === 'underline') {
      const y = r[1] + r[3] + 0.5
      return (
        <g key={key} data-target={t.id}>
          {active && <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="#ffa94d" opacity={0.3} />}
          <line x1={r[0]} y1={y} x2={r[0] + r[2]} y2={y} stroke={stroke} strokeWidth={1.2} strokeLinecap="round" />
        </g>
      )
    }
    if (t.style === 'equation') {
      return (
        <rect key={key} data-target={t.id} data-equation={t.equation ?? ''} x={r[0]} y={r[1]} width={r[2]} height={r[3]}
          rx={6} fill={active ? '#ffa94d33' : '#2b6cb00d'} stroke={stroke} strokeWidth={1.1} />
      )
    }
    if (t.style === 'region') {
      return (
        <rect key={key} data-target={t.id} x={r[0]} y={r[1]} width={r[2]} height={r[3]}
          fill={active ? '#ffa94d33' : '#2b6cb010'} stroke={stroke} strokeWidth={1} strokeDasharray="4 3" />
      )
    }
    return <rect key={key} data-target={t.id} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={active ? '#ffa94d' : '#74c0fc'} opacity={0.4} />
  })
}

function connector(note: MarginNote, target: Target): ReactNode {
  const r = target.rects?.[0]
  if (!r) return null
  const [nx, ny, nw, nh] = note.box
  const fromRight = nx + nw < r[0]
  const x1 = fromRight ? nx + nw : nx
  const y1 = ny + nh / 2
  const x2 = fromRight ? r[0] : nx > r[0] + r[2] ? r[0] + r[2] : r[0]
  const y2 = r[1] + r[3] / 2
  return <line key={`${note.id}-${target.id}`} data-link={`${note.id}-${target.id}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d9480f" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.75} />
}

function backingScale(renderZoom: number, width: number, height: number, maxPixels: number): number {
  const dpr = window.devicePixelRatio || 1
  return Math.min(renderZoom * dpr, Math.sqrt(maxPixels / (width * height)))
}

/** The part of a page on screen, in the page box's CSS pixels, or null when none of it is. */
function visiblePart(wrap: HTMLElement): { x: number; y: number; w: number; h: number } | null {
  const scroller = wrap.closest('.pages-scroll')
  if (!scroller) return null
  const a = wrap.getBoundingClientRect()
  const b = scroller.getBoundingClientRect()
  const x0 = Math.max(a.left, b.left)
  const y0 = Math.max(a.top, b.top)
  const x1 = Math.min(a.right, b.right)
  const y1 = Math.min(a.bottom, b.bottom)
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: Math.floor(x0 - a.left), y: Math.floor(y0 - a.top), w: Math.ceil(x1 - x0) + 1, h: Math.ceil(y1 - y0) + 1 }
}

const strokeBoxes = new WeakMap<Stroke, [number, number, number, number]>()
/** A stroke's extent, padded by its width; kept per stroke, as strokes are never changed in place. */
function strokeBox(s: Stroke): [number, number, number, number] {
  let b = strokeBoxes.get(s)
  if (!b) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of s.points) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    b = [x0 - s.width, y0 - s.width, x1 + s.width, y1 + s.width]
    strokeBoxes.set(s, b)
  }
  return b
}

export const PageView = memo(function PageView(p: Props) {
  const { index, doc, size, zoom, renderZoom, margin, visible, ctl } = p
  /** A note or selected ink being dragged, drawn where it would land until the pen lifts. */
  // A move by dx, dy, or a resize by the factor f about the point ax, ay.
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; noteId?: string; dx: number; dy: number; scale?: { ax: number; ay: number; f: number } } | null>(null)
  const strokes = useMemo(() => {
    if (!drag || (drag.dx === 0 && drag.dy === 0 && !drag.scale)) return p.strokes
    const sc = drag.scale
    const at = (x: number, y: number): [number, number] => (sc ? [sc.ax + (x - sc.ax) * sc.f, sc.ay + (y - sc.ay) * sc.f] : [x + drag.dx, y + drag.dy])
    return p.strokes.map((s) => (drag.ids.has(s.id)
      ? { ...s, width: sc ? s.width * sc.f : s.width, points: s.points.map(([x, y, pr, t]) => [...at(x, y), pr, t] as InkPoint) }
      : s))
  }, [p.strokes, drag])
  const notes = useMemo(() => {
    if (!drag?.noteId) return p.notes
    const sc = drag.scale
    return p.notes.map((n) => {
      if (n.id !== drag.noteId) return n
      const [x, y, w, h] = n.box
      const box: Rect = sc ? [sc.ax + (x - sc.ax) * sc.f, sc.ay + (y - sc.ay) * sc.f, w * sc.f, h * sc.f] : [x + drag.dx, y + drag.dy, w, h]
      return { ...n, box }
    })
  }, [p.notes, drag])
  /** The loop being drawn with Select ink. */
  const [lasso, setLasso] = useState<[number, number][] | null>(null)
  /** The box around the selected ink, where it is shown now. */
  const selBox = useMemo(() => {
    if (!p.inkSelection?.size) return null
    const pts = strokes.filter((s) => p.inkSelection!.has(s.id)).flatMap((s) => s.points)
    if (pts.length === 0) return null
    const xs = pts.map((q) => q[0])
    const ys = pts.map((q) => q[1])
    const x0 = Math.min(...xs) - 4
    const y0 = Math.min(...ys) - 4
    return [x0, y0, Math.max(...xs) + 4 - x0, Math.max(...ys) + 4 - y0] as Rect
  }, [p.inkSelection, strokes])
  const pdfRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const drawn = useRef<{ key: string; list: Stroke[] }>({ key: '', list: [] })
  const current = useRef<{
    mode: 'pen' | 'erase' | 'region' | 'select' | 'lasso' | 'moveInk' | 'rect' | 'band' | 'moveNote'
    /** For moveNote: the note pressed on. */
    noteId?: string
    alt?: boolean
    shift?: boolean
    points: InkPoint[]
    start: number
    id: number
    lastClient: LivePoint
  } | null>(null)
  const [regionRect, setRegionRect] = useState<Rect | null>(null)
  const [bandRect, setBandRect] = useState<Rect | null>(null)
  const [selRects, setSelRects] = useState<Rect[]>([])
  const wrapW = (size.width + margin * 2) * zoom
  const wrapH = size.height * zoom
  const inkDetailRef = useRef<HTMLCanvasElement>(null)
  const pdfDetailRef = useRef<HTMLCanvasElement>(null)
  // Whole-page pictures are capped in size, so at high zoom they are drawn coarser than the screen.
  // Then the part on screen is drawn again at full sharpness: the ink on every scroll, the PDF once
  // scrolling stops.
  const dprNow = window.devicePixelRatio || 1
  const settled = visible && zoom === renderZoom
  const inkDetail = settled && backingScale(renderZoom, size.width + margin * 2, size.height, MAX_INK_PIXELS) < renderZoom * dprNow * 0.95
  const pdfDetail = settled && backingScale(renderZoom, size.width, size.height, MAX_PDF_PIXELS) < renderZoom * dprNow * 0.95

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    void (async () => {
      const page = await doc.getPage(index + 1)
      if (cancelled || !pdfRef.current) return
      const vp = page.getViewport({ scale: backingScale(renderZoom, size.width, size.height, MAX_PDF_PIXELS) })
      // Drawn off screen and copied, so the old picture stays until the new one is ready.
      const off = document.createElement('canvas')
      off.width = Math.floor(vp.width)
      off.height = Math.floor(vp.height)
      task = page.render({ canvas: off, viewport: vp })
      try {
        await task.promise
      } catch {
        return
      }
      const canvas = pdfRef.current
      if (cancelled || !canvas) return
      canvas.width = off.width
      canvas.height = off.height
      canvas.getContext('2d')?.drawImage(off, 0, 0)
      canvas.dataset.rendered = String(renderZoom)
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, index, renderZoom, visible, size.width, size.height])

  // Only strokes added since the last paint are drawn, so a long session costs no more than a short one.
  useLayoutEffect(() => {
    const c = inkRef.current
    if (!c || !visible) {
      drawn.current = { key: '', list: [] }
      return
    }
    const fullW = size.width + margin * 2
    const scale = backingScale(renderZoom, fullW, size.height, MAX_INK_PIXELS)
    const w = Math.floor(fullW * scale)
    const h = Math.floor(size.height * scale)
    const ctx = c.getContext('2d')
    if (!ctx) return
    const key = `${w}x${h}`
    const prev = drawn.current
    const n = prev.list.length
    // Only when every stroke already drawn is unchanged: a moved note changes strokes in the middle.
    let canAppend = prev.key === key && strokes.length >= n
    for (let i = 0; canAppend && i < n; i++) if (strokes[i] !== prev.list[i]) canAppend = false
    if (canAppend) {
      ctx.setTransform(scale, 0, 0, scale, margin * scale, 0)
      for (let i = n; i < strokes.length; i++) drawStroke(ctx, strokes[i])
    } else {
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
      }
      ctx.setTransform(scale, 0, 0, scale, margin * scale, 0)
      for (const s of strokes) drawStroke(ctx, s)
    }
    drawn.current = { key, list: strokes }
  }, [strokes, renderZoom, margin, visible, size.width, size.height])

  const strokesRef = useRef(strokes)
  strokesRef.current = strokes
  const drawInkDetailRef = useRef<() => void>(() => undefined)
  drawInkDetailRef.current = () => {
    const c = inkDetailRef.current
    const wrap = wrapRef.current
    if (!c || !wrap) return
    const v = visiblePart(wrap)
    if (!v) { c.style.display = 'none'; return }
    const dpr = window.devicePixelRatio || 1
    c.style.display = 'block'
    c.style.left = `${v.x}px`
    c.style.top = `${v.y}px`
    c.style.width = `${v.w}px`
    c.style.height = `${v.h}px`
    const W = Math.round(v.w * dpr)
    const H = Math.round(v.h * dpr)
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const k = zoom * dpr
    ctx.setTransform(k, 0, 0, k, (margin * zoom - v.x) * dpr, -v.y * dpr)
    const x0 = v.x / zoom - margin
    const y0 = v.y / zoom
    const x1 = x0 + v.w / zoom
    const y1 = y0 + v.h / zoom
    for (const s of strokesRef.current) {
      const b = strokeBox(s)
      if (b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1) drawStroke(ctx, s)
    }
  }

  // The ink on screen, sharp: redrawn on every scroll frame, with the coarse page ink hidden.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const base = inkRef.current
    if (!inkDetail || !wrap) return
    const scroller = wrap.closest('.pages-scroll')
    let frame = 0
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawInkDetailRef.current() }) }
    drawInkDetailRef.current()
    if (base) base.style.visibility = 'hidden'
    scroller?.addEventListener('scroll', later, { passive: true })
    window.addEventListener('resize', later)
    const detail = inkDetailRef.current
    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller?.removeEventListener('scroll', later)
      window.removeEventListener('resize', later)
      if (base) base.style.visibility = ''
      if (detail) detail.style.display = 'none'
    }
  }, [inkDetail, zoom, margin])
  useLayoutEffect(() => { if (inkDetail) drawInkDetailRef.current() }, [inkDetail, strokes])

  // The PDF on screen, sharp, once scrolling has stopped; until then the coarser page shows through.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!pdfDetail || !wrap) return
    const scroller = wrap.closest('.pages-scroll')
    const detail = pdfDetailRef.current
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    const render = async () => {
      const c = pdfDetailRef.current
      const v = visiblePart(wrap)
      if (!c) return
      // Only the sheet, not the margins beside it.
      const left = margin * zoom
      const sx = Math.max(0, (v?.x ?? 0) - left)
      const sy = v?.y ?? 0
      const sw = v ? Math.min(size.width * zoom, v.x + v.w - left) - sx : 0
      if (!v || sw < 1) { c.style.display = 'none'; return }
      const dpr = window.devicePixelRatio || 1
      const page = await doc.getPage(index + 1)
      if (cancelled) return
      const off = document.createElement('canvas')
      off.width = Math.round(sw * dpr)
      off.height = Math.round(v.h * dpr)
      task?.cancel()
      task = page.render({ canvas: off, viewport: page.getViewport({ scale: zoom * dpr }), transform: [1, 0, 0, 1, -sx * dpr, -sy * dpr] })
      try {
        await task.promise
      } catch {
        return
      }
      if (cancelled) return
      c.width = off.width
      c.height = off.height
      c.getContext('2d')?.drawImage(off, 0, 0)
      c.style.left = `${sx}px`
      c.style.top = `${sy}px`
      c.style.width = `${sw}px`
      c.style.height = `${v.h}px`
      c.style.display = 'block'
    }
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void render(), 150)
    }
    later()
    scroller?.addEventListener('scroll', later, { passive: true })
    window.addEventListener('resize', later)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      task?.cancel()
      scroller?.removeEventListener('scroll', later)
      window.removeEventListener('resize', later)
      if (detail) detail.style.display = 'none'
    }
  }, [pdfDetail, zoom, margin, doc, index, size.width, size.height])

  function toPage(clientX: number, clientY: number): [number, number] {
    const r = wrapRef.current!.getBoundingClientRect()
    return [(clientX - r.left) / zoom - margin, (clientY - r.top) / zoom]
  }

  function pressureOf(e: PointerEvent | React.PointerEvent): number {
    return e.pressure > 0 ? e.pressure : 0.5
  }

  function point(e: PointerEvent | React.PointerEvent, start: number): InkPoint {
    const [x, y] = toPage(e.clientX, e.clientY)
    return [round(x), round(y), Math.round(pressureOf(e) * 100) / 100, Math.round(e.timeStamp - start)]
  }

  /** What pressed last, so a pen double-tap (a colon, say) never counts as a mouse double-click. */
  const lastPointer = useRef('')

  function onPointerDown(e: React.PointerEvent): void {
    lastPointer.current = e.pointerType
    if (e.pointerType === 'touch') {
      ctl.touchStart(e)
      if (!ctl.touchWrites()) return
      // A second finger means scrolling or zooming: the first finger's stroke is dropped.
      if (ctl.touchCount() > 1) {
        if (current.current) dropStroke()
        return
      }
    }
    if (e.pointerType === 'pen') ctl.penSeen()
    if (e.button === 2 || e.buttons & 2) {
      if (e.pointerType === 'pen') {
        const [x, y] = toPage(e.clientX, e.clientY)
        ctl.contextMenu(index, x, y, e.clientX, e.clientY)
      }
      return
    }
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* simulated pointers cannot be captured */
    }
    const tool = ctl.toolRef.current
    const erasing = tool === 'eraser' || e.button === 5 || (e.buttons & 32) !== 0
    let mode: 'pen' | 'erase' | 'region' | 'select' | 'lasso' | 'moveInk' | 'rect' | 'band' | 'moveNote' = 'select'
    const [px, py] = toPage(e.clientX, e.clientY)
    const mouse = e.pointerType === 'mouse'
    let pressedNote = ''
    if (erasing) mode = 'erase'
    else if (tool === 'region' || (mouse && e.altKey && tool === 'pen')) mode = 'region'
    // The mouse never writes. What a drag does depends on where it starts, as the cursor shows.
    else if (mouse && tool === 'pen') {
      pressedNote = ctl.noteAt(index, px, py)
      if (e.shiftKey) mode = 'band'
      else if (pressedNote && !p.readOnly) mode = 'moveNote'
      else if (px < 0 || px > size.width) mode = 'band'
      else if (ctl.onText(index, px, py)) mode = 'select'
      else mode = 'rect'
    }
    // With Select ink, pressing inside the selection drags it; anywhere else draws a new loop.
    else if (tool === 'select') mode = selBox && px >= selBox[0] && px <= selBox[0] + selBox[2] && py >= selBox[1] && py <= selBox[1] + selBox[3] ? 'moveInk' : 'lasso'
    else if (e.pointerType === 'pen' || (ctl.touchWrites() && !mouse)) mode = 'pen'
    if (p.readOnly && mode !== 'select') mode = 'select'
    current.current = {
      mode,
      noteId: pressedNote || undefined,
      alt: e.altKey,
      shift: e.shiftKey,
      points: [point(e, e.timeStamp)],
      start: e.timeStamp,
      id: e.pointerId,
      lastClient: [e.clientX, e.clientY, pressureOf(e)]
    }
    if (mode === 'erase') {
      ctl.eraseStart()
      const [x, y] = toPage(e.clientX, e.clientY)
      ctl.eraseAt(index, x, y)
    }
    if (mode === 'pen') ctl.beforeStroke()
    if (mode === 'lasso') setLasso([[px, py]])
  }

  function onPointerMove(e: React.PointerEvent): void {
    if (e.pointerType === 'touch') {
      ctl.touchMove(e)
      if (!ctl.touchWrites()) return
    }
    if (e.pointerType === 'pen') ctl.penSeen()
    const cur = current.current
    if (!cur || cur.id !== e.pointerId) {
      if (!cur) {
        const [x, y] = toPage(e.clientX, e.clientY)
        ctl.hover(index, x, y)
        cursorFor(e)
      }
      return
    }
    if (cur.mode === 'pen') {
      const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
      const events: (PointerEvent | React.PointerEvent)[] = coalesced.length ? coalesced : [e]
      const live: LivePoint[] = []
      for (const ev of events) {
        cur.points.push(point(ev, cur.start))
        live.push([ev.clientX, ev.clientY, pressureOf(ev)])
      }
      ctl.liveDraw(cur.lastClient, live)
      cur.lastClient = live[live.length - 1]
      return
    }
    const [x, y] = toPage(e.clientX, e.clientY)
    if (cur.mode === 'lasso') {
      cur.points.push([x, y, 0, 0])
      setLasso(cur.points.map((q) => [q[0], q[1]]))
    } else if (cur.mode === 'rect' || cur.mode === 'band') {
      const [sx, sy] = cur.points[0]
      const r: Rect = [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)]
      if (cur.mode === 'rect') setRegionRect(r)
      else setBandRect(r)
    } else if (cur.mode === 'moveNote') {
      const note = p.notes.find((n) => n.id === cur.noteId)
      const [sx, sy] = cur.points[0]
      // A small wobble is still a click.
      if (!note || (!drag && Math.hypot(x - sx, y - sy) * zoom < 4)) return
      const [nx, ny, nw, nh] = note.box
      const dx = Math.min(Math.max(x - sx, -margin - nx), size.width + margin - nx - nw)
      const dy = Math.min(Math.max(y - sy, -ny), size.height - ny - nh)
      setDrag({ ids: new Set(note.strokeIds), noteId: note.id, dx, dy })
    } else if (cur.mode === 'moveInk') {
      if (!p.inkSelection || !selBox) return
      const [sx, sy] = cur.points[0]
      // The ink stays on the page and its margins.
      const dx = Math.min(Math.max(x - sx, -margin - selBox[0] + (drag?.dx ?? 0)), size.width + margin - selBox[0] - selBox[2] + (drag?.dx ?? 0))
      const dy = Math.min(Math.max(y - sy, -selBox[1] + (drag?.dy ?? 0)), size.height - selBox[1] - selBox[3] + (drag?.dy ?? 0))
      setDrag({ ids: p.inkSelection, dx, dy })
    } else if (cur.mode === 'erase') {
      ctl.eraseAt(index, x, y)
    } else if (cur.mode === 'region') {
      const [sx, sy] = cur.points[0]
      setRegionRect([Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)])
    } else {
      setSelRects(ctl.selectionPreview(index, [cur.points[0][0], cur.points[0][1]], [x, y]))
    }
  }

  function onPointerUp(e: React.PointerEvent): void {
    if (e.pointerType === 'touch') {
      ctl.touchEnd(e)
      if (!ctl.touchWrites()) return
    }
    const cur = current.current
    if (!cur || cur.id !== e.pointerId) return
    current.current = null
    const [x, y] = toPage(e.clientX, e.clientY)
    const [sx, sy] = cur.points[0]
    if (cur.mode === 'pen') {
      cur.points.push(point(e, cur.start))
      ctl.penStroke(index, cur.points)
    } else if (cur.mode === 'region') {
      setRegionRect(null)
      ctl.finishRegion(index, [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)])
    } else if (cur.mode === 'lasso') {
      setLasso(null)
      const loop = cur.points.map((q) => [q[0], q[1]] as [number, number])
      const xs = loop.map((q) => q[0]).concat(x)
      const ys = loop.map((q) => q[1]).concat(y)
      const tapped = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * zoom < 10
      // A tap clears selected ink; with none selected it works as with the pen, so a note or mark
      // can be chosen without changing tool. A real loop chooses what it goes round.
      if (tapped && p.inkSelection?.size) ctl.selectInk(index, [])
      else if (tapped) ctl.tap(index, sx, sy)
      else ctl.selectInk(index, loop)
    } else if (cur.mode === 'moveInk') {
      // A tap inside the box, like one anywhere else, clears the selection; a pen's wobble is not a move.
      if (Math.hypot(x - sx, y - sy) * zoom < 10) ctl.selectInk(index, [])
      else if (drag && (drag.dx !== 0 || drag.dy !== 0)) ctl.moveInk(index, drag.ids, drag.dx, drag.dy)
      // Cleared in the same update as the move itself, so the ink never jumps back.
      setDrag(null)
    } else if (cur.mode === 'select') {
      setSelRects([])
      if (Math.hypot(x - sx, y - sy) * zoom < 8) ctl.tap(index, sx, sy)
      else ctl.finishSelection(index, [sx, sy], [x, y], e.clientX, e.clientY)
    } else if (cur.mode === 'rect' || cur.mode === 'band') {
      setRegionRect(null)
      setBandRect(null)
      const r: Rect = [Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy)]
      if (Math.hypot(x - sx, y - sy) * zoom < 6) ctl.tap(index, sx, sy)
      else if (cur.mode === 'rect') ctl.finishRect(index, r, false, e.clientX, e.clientY)
      else ctl.band(index, r, !!cur.shift)
    } else if (cur.mode === 'moveNote') {
      if (drag?.noteId && (drag.dx !== 0 || drag.dy !== 0)) ctl.moveNote(index, drag.noteId, drag.dx, drag.dy)
      else ctl.tap(index, sx, sy)
      setDrag(null)
    }
  }

  function onPointerCancel(e: React.PointerEvent): void {
    if (e.pointerType === 'touch') ctl.touchEnd(e)
    dropStroke()
  }

  /** Forgets whatever the pointer was doing, leaving the page as it was. */
  function dropStroke(): void {
    if (current.current?.mode === 'pen') ctl.strokeCancelled()
    current.current = null
    setRegionRect(null)
    setBandRect(null)
    setSelRects([])
    setLasso(null)
    setDrag(null)
  }

  /** The mouse cursor says what a drag will do before you press. */
  function cursorFor(e: React.PointerEvent): void {
    if (e.pointerType !== 'mouse' || ctl.toolRef.current !== 'pen') return
    const el = e.currentTarget as HTMLElement
    const [x, y] = toPage(e.clientX, e.clientY)
    const c = e.altKey ? 'crosshair'
      : ctl.noteAt(index, x, y) ? 'move'
        : e.shiftKey || x < 0 || x > size.width ? 'default'
          : ctl.onText(index, x, y) ? 'text' : 'crosshair'
    if (el.style.cursor !== c) el.style.cursor = c
  }

  // ---- Moving the selected note by its grip, with the pen, a finger or the mouse ----
  const grab = useRef<{ id: number; noteId: string; sx: number; sy: number } | null>(null)
  const selectedNote = p.readOnly ? undefined : p.notes.find((n) => n.id === p.selectedNoteId)

  function onGripDown(e: React.PointerEvent): void {
    if (!selectedNote) return
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* simulated pointers cannot be captured */
    }
    const [sx, sy] = toPage(e.clientX, e.clientY)
    grab.current = { id: e.pointerId, noteId: selectedNote.id, sx, sy }
  }

  function onGripMove(e: React.PointerEvent): void {
    const g = grab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    const note = p.notes.find((n) => n.id === g.noteId)
    if (!note) return
    const [x, y] = toPage(e.clientX, e.clientY)
    // The note stays on the page and its margins.
    const [nx, ny, nw, nh] = note.box
    const dx = Math.min(Math.max(x - g.sx, -margin - nx), size.width + margin - nx - nw)
    const dy = Math.min(Math.max(y - g.sy, -ny), size.height - ny - nh)
    setDrag({ ids: new Set(note.strokeIds), noteId: note.id, dx, dy })
  }

  function onGripUp(e: React.PointerEvent): void {
    const g = grab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    grab.current = null
    if (drag?.noteId && (drag.dx !== 0 || drag.dy !== 0)) ctl.moveNote(index, drag.noteId, drag.dx, drag.dy)
    // Cleared in the same update as the move itself, so the note never jumps back.
    setDrag(null)
  }

  function onGripCancel(): void {
    grab.current = null
    setDrag(null)
  }

  // ---- Moving and resizing the selected region: a grip moves it, its corners resize it ----
  const regionGrab = useRef<{ id: number; how: 'move' | 'nw' | 'ne' | 'sw' | 'se'; sx: number; sy: number; start: Rect } | null>(null)
  const [regionDrag, setRegionDrag] = useState<{ id: string; rect: Rect } | null>(null)
  const activeRegion = p.readOnly ? undefined : p.targets.find((t) => t.id === p.activeTargetId && t.kind === 'region' && t.rects?.length === 1)

  function onRegionDown(how: 'move' | 'nw' | 'ne' | 'sw' | 'se', e: React.PointerEvent): void {
    if (!activeRegion?.rects) return
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* simulated pointers cannot be captured */
    }
    const [sx, sy] = toPage(e.clientX, e.clientY)
    regionGrab.current = { id: e.pointerId, how, sx, sy, start: activeRegion.rects[0] }
  }

  function onRegionMove(e: React.PointerEvent): void {
    const g = regionGrab.current
    if (!g || g.id !== e.pointerId || !activeRegion) return
    e.stopPropagation()
    const [x, y] = toPage(e.clientX, e.clientY)
    setRegionDrag({ id: activeRegion.id, rect: adjustRegion(g.start, g.how, x - g.sx, y - g.sy, size.width, size.height) })
  }

  function onRegionUp(e: React.PointerEvent): void {
    const g = regionGrab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    regionGrab.current = null
    if (regionDrag && activeRegion && regionDrag.rect.some((v, i) => v !== g.start[i])) ctl.setTargetRect(index, activeRegion.id, regionDrag.rect)
    setRegionDrag(null)
  }

  function onRegionCancel(): void {
    regionGrab.current = null
    setRegionDrag(null)
  }

  // ---- Resizing a selected note or ink selection by its corners: the opposite corner stays put ----
  type Corner = 'nw' | 'ne' | 'sw' | 'se'
  const sizeGrab = useRef<{ id: number; ids: ReadonlySet<string>; noteId?: string; ax: number; ay: number; px: number; py: number } | null>(null)

  function onSizeDown(corner: Corner, box: Rect, ids: ReadonlySet<string>, noteId: string | undefined, e: React.PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* simulated pointers cannot be captured */
    }
    const [x, y, w, h] = box
    const ax = corner === 'nw' || corner === 'sw' ? x + w : x
    const ay = corner === 'nw' || corner === 'ne' ? y + h : y
    const [px, py] = toPage(e.clientX, e.clientY)
    sizeGrab.current = { id: e.pointerId, ids, noteId, ax, ay, px, py }
  }

  function onSizeMove(e: React.PointerEvent): void {
    const g = sizeGrab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    const [x, y] = toPage(e.clientX, e.clientY)
    // Even scaling by how far the pen now is from the fixed corner, against where it started; steady
    // however thin the note. Pulled past the fixed corner, it stays at the smallest size.
    const sx = g.px - g.ax
    const sy = g.py - g.ay
    const along = ((x - g.ax) * sx + (y - g.ay) * sy) / Math.max(sx * sx + sy * sy, 1e-6)
    const f = Math.min(4, Math.max(0.25, along))
    setDrag({ ids: g.ids, noteId: g.noteId, dx: 0, dy: 0, scale: { ax: g.ax, ay: g.ay, f } })
  }

  function onSizeUp(e: React.PointerEvent): void {
    const g = sizeGrab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    sizeGrab.current = null
    const f = drag?.scale?.f ?? 1
    if (Math.abs(f - 1) > 0.01) ctl.scaleInk(index, g.ids, f, [g.ax, g.ay])
    setDrag(null)
  }

  function onSizeCancel(): void {
    sizeGrab.current = null
    setDrag(null)
  }

  /** Corner squares round a box, in page units, that resize what is inside. */
  function sizeHandles(box: Rect, ids: ReadonlySet<string>, noteId: string | undefined, testId: string): ReactNode {
    const [x, y, w, h] = box
    // Just outside each corner, so the squares never overlap, even on a one-line note.
    const o = 7
    const left = (x + margin) * zoom - o
    const top = y * zoom - o
    const right = (x + w + margin) * zoom + o
    const bottom = (y + h) * zoom + o
    const corners: [Corner, number, number][] = [
      ['nw', left, top], ['ne', right, top], ['sw', left, bottom], ['se', right, bottom]
    ]
    return corners.map(([how, cx, cy]) => (
      <div key={how} className={`region-handle ${how}`} data-testid={`${testId}-${how}`} title="Drag to make it larger or smaller"
        style={{ left: cx - 9, top: cy - 9 }}
        onPointerDown={(e) => onSizeDown(how, box, ids, noteId, e)}
        onPointerMove={onSizeMove} onPointerUp={onSizeUp} onPointerCancel={onSizeCancel} />
    ))
  }

  // ---- Changing a typed note's width by its sides: the text rewraps, its size stays ----
  const widthGrab = useRef<{ id: number; noteId: string; side: 'w' | 'e'; px: number; box: Rect } | null>(null)
  const [widthDrag, setWidthDrag] = useState<{ noteId: string; x: number; w: number } | null>(null)

  function onWidthDown(side: 'w' | 'e', note: MarginNote, e: React.PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* simulated pointers cannot be captured */
    }
    const [px] = toPage(e.clientX, e.clientY)
    widthGrab.current = { id: e.pointerId, noteId: note.id, side, px, box: note.box }
  }

  function onWidthMove(e: React.PointerEvent): void {
    const g = widthGrab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    const [x] = toPage(e.clientX, e.clientY)
    const [bx, , bw] = g.box
    const dx = x - g.px
    const min = 40
    if (g.side === 'e') setWidthDrag({ noteId: g.noteId, x: bx, w: Math.min(Math.max(min, bw + dx), size.width + margin - bx) })
    else {
      const left = Math.min(Math.max(-margin, bx + dx), bx + bw - min)
      setWidthDrag({ noteId: g.noteId, x: left, w: bx + bw - left })
    }
  }

  function onWidthUp(e: React.PointerEvent): void {
    const g = widthGrab.current
    if (!g || g.id !== e.pointerId) return
    e.stopPropagation()
    widthGrab.current = null
    if (widthDrag && (Math.abs(widthDrag.w - g.box[2]) > 0.5 || Math.abs(widthDrag.x - g.box[0]) > 0.5)) ctl.setNoteWidth(index, g.noteId, widthDrag.x, widthDrag.w)
    setWidthDrag(null)
  }

  function onWidthCancel(): void {
    widthGrab.current = null
    setWidthDrag(null)
  }

  function onContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    // A palm resting while writing is a long touch; it must not open the menu.
    if ((e.nativeEvent as PointerEvent).pointerType === 'touch' && ctl.writingRecently()) return
    // When a finger writes, holding it still is part of writing, not a request for the menu.
    if (ctl.touchWrites() && current.current) return
    const [x, y] = toPage(e.clientX, e.clientY)
    ctl.contextMenu(index, x, y, e.clientX, e.clientY)
  }

  const viewBox = `${-margin} 0 ${size.width + margin * 2} ${size.height}`
  const pageLinks: ReactNode[] = []
  for (const n of notes) {
    if (!p.showLinks && n.id !== p.selectedNoteId) continue
    for (const id of n.targetIds) {
      const onPage = p.targets.some((t) => t.id === id && t.kind === 'page')
      const whole = p.wholePaperIds.has(id)
      if (!onPage && !whole) continue
      const label = whole ? 'Whole paper' : `Page ${index + 1}`
      const right = n.box[0] + n.box[2] / 2 > size.width / 2
      const w = label.length * 4.2 + 10
      const tx = right ? size.width - w - 4 : 4
      const ty = 4
      const [nx, ny, nw, nh] = n.box
      pageLinks.push(
        <g key={`page-link-${n.id}-${id}`} data-page-link={whole ? 'paper' : 'page'}>
          <line x1={right ? nx : nx + nw} y1={ny + nh / 2} x2={right ? tx + w : tx} y2={ty + 6}
            stroke="#d9480f" strokeWidth={0.8} strokeDasharray="3 3" opacity={0.75} />
          <rect x={tx} y={ty} width={w} height={12} rx={3} fill="#fff4e6" stroke="#d9480f" strokeWidth={0.6} />
          <text x={tx + w / 2} y={ty + 8.6} textAnchor="middle" fontSize={7.5} fill="#c2410c" fontFamily="system-ui, sans-serif">{label}</text>
        </g>
      )
    }
  }
  const linked = p.showLinks ? notes : p.connectFrom ? [notes.find((n) => n.id === p.connectFrom?.id) ?? p.connectFrom] : []
  const connectors = linked.flatMap((n) =>
    n.targetIds.flatMap((id) => {
      const t = p.targets.find((x) => x.id === id)
      return t ? [connector(n, t)] : []
    })
  )

  return (
    <div
      ref={wrapRef}
      className="page-wrap"
      data-page={index}
      data-zoom={zoom}
      data-margin={margin}
      style={{ width: wrapW, height: wrapH }}
    >
      <div className="page-sheet" style={{ left: margin * zoom, width: size.width * zoom, height: wrapH }}>
        {visible && <canvas ref={pdfRef} className="pdf-canvas" data-testid={`pdf-${index}`} />}
        {visible && <canvas ref={pdfDetailRef} className="detail-canvas" data-testid={`pdf-detail-${index}`} />}
      </div>
      {visible && <canvas ref={inkRef} className="ink-canvas" data-testid={`ink-${index}`} />}
      {visible && <canvas ref={inkDetailRef} className="detail-canvas" data-testid={`ink-detail-${index}`} />}
      <svg className="overlay" viewBox={viewBox} width={wrapW} height={wrapH}>
        {p.targets.map((t) => (
          <g key={t.id}>{targetShape(regionDrag && regionDrag.id === t.id ? { ...t, rects: [regionDrag.rect] } : t, t.id === p.activeTargetId, t.id === p.flashTargetId)}</g>
        ))}
        {p.highlights.flatMap((h, i) =>
          h.rects.map((r, j) => (
            <rect key={`find-${i}-${j}`} data-find={h.current ? 'current' : 'match'} x={r[0] - 1} y={r[1] - 1} width={r[2] + 2} height={r[3] + 2}
              fill={h.current ? '#ff922b' : '#ffe066'} opacity={h.current ? 0.55 : 0.5} />
          ))
        )}
        {(selRects.length ? selRects : p.pendingRects ?? []).map((r, i) => (
          <rect key={i} data-pending-selection="" x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="#74c0fc" opacity={0.5} />
        ))}
        {p.pendingRect && !regionRect && (
          <rect data-testid={`pending-rect-${index}`} x={p.pendingRect[0]} y={p.pendingRect[1]} width={p.pendingRect[2]} height={p.pendingRect[3]}
            fill="#ffa94d22" stroke="#d9480f" strokeWidth={1} strokeDasharray="4 3" />
        )}
        {bandRect && (
          <rect data-testid={`band-${index}`} x={bandRect[0]} y={bandRect[1]} width={bandRect[2]} height={bandRect[3]}
            fill="#4dabf718" stroke="#1c7ed6" strokeWidth={1} strokeDasharray="4 3" />
        )}
        {p.chosenIds && p.targets.filter((t) => p.chosenIds!.has(t.id)).flatMap((t) => (t.rects ?? []).map((r, i) => (
          <rect key={`chosen-${t.id}-${i}`} data-chosen={t.id} x={r[0] - 2} y={r[1] - 2} width={r[2] + 4} height={r[3] + 4}
            fill="none" stroke="#1c7ed6" strokeWidth={1.2} strokeDasharray="3 2" />
        )))}
        {regionRect && (
          <rect x={regionRect[0]} y={regionRect[1]} width={regionRect[2]} height={regionRect[3]}
            fill="#ffa94d33" stroke="#d9480f" strokeWidth={1} strokeDasharray="4 3" />
        )}
        {connectors}
        {pageLinks}
        {lasso && lasso.length > 1 && (
          <polygon data-testid={`lasso-${index}`} points={lasso.map((q) => q.join(',')).join(' ')}
            fill="#4dabf722" stroke="#1c7ed6" strokeWidth={1} strokeDasharray="4 3" />
        )}
        {selBox && (
          <rect data-testid={`ink-selection-${index}`} x={selBox[0]} y={selBox[1]} width={selBox[2]} height={selBox[3]}
            fill="#4dabf718" stroke="#1c7ed6" strokeWidth={1} strokeDasharray="4 3" rx={3} />
        )}
      </svg>
      <div className="page-number" data-testid={`page-number-${index}`}
        style={margin * zoom >= 40
          ? { left: (margin + size.width) * zoom + 6, top: wrapH - 18 }
          : { left: (margin + size.width) * zoom - 46, top: wrapH - 18 }}>
        {index + 1} / {p.pageCount}
      </div>
      <div className="notes-layer">
        {notes.map((n) => {
          const shown = widthDrag?.noteId === n.id ? { ...n, box: [widthDrag.x, n.box[1], widthDrag.w, n.box[3]] as Rect } : n
          if (isTyped(n) && n.id === p.editingNoteId) return null
          return (
            <NoteBox key={n.id} note={shown} zoom={zoom} margin={margin} showText={p.showText}
              selected={n.id === p.selectedNoteId || !!p.chosenIds?.has(n.id)}
              onHeight={isTyped(n) && !drag && !widthDrag ? ctl.noteHeight : undefined} />
          )
        })}
      </div>
      <div
        className={p.inkSelection?.size ? 'input-layer selecting-ink' : 'input-layer'}
        data-testid={`live-${index}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          if (lastPointer.current !== 'mouse') return
          if (ctl.toolRef.current !== 'pen') return
          const [x, y] = toPage(e.clientX, e.clientY)
          ctl.doubleClick(index, x, y)
        }}
      />
      {selectedNote && (() => {
        const shown = notes.find((n) => n.id === selectedNote.id) ?? selectedNote
        return (
          <>
            <div className={drag ? 'note-grip moving' : 'note-grip'} data-testid="note-grip" title="Drag to move the note"
              style={{ left: Math.max(0, (shown.box[0] + margin) * zoom - 44), top: Math.max(0, shown.box[1] * zoom - 30) }}
              onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripCancel}>
              ✥
            </div>
            {isTyped(selectedNote)
              ? (['w', 'e'] as const).map((side) => {
                  const b = widthDrag?.noteId === selectedNote.id ? [widthDrag.x, shown.box[1], widthDrag.w, shown.box[3]] : shown.box
                  const left = side === 'w' ? (b[0] + margin) * zoom - 6 : (b[0] + b[2] + margin) * zoom - 4
                  return (
                    <div key={side} className="width-handle" data-testid={`note-width-${side}`} title="Drag to make the note wider or narrower"
                      style={{ left, top: b[1] * zoom, height: Math.max(14, b[3] * zoom) }}
                      onPointerDown={(e) => onWidthDown(side, selectedNote, e)}
                      onPointerMove={onWidthMove} onPointerUp={onWidthUp} onPointerCancel={onWidthCancel} />
                  )
                })
              : sizeHandles(shown.box, new Set(selectedNote.strokeIds), selectedNote.id, 'note-handle')}
          </>
        )
      })()}
      {activeRegion && (() => {
        const [rx, ry, rw, rh] = regionDrag?.id === activeRegion.id ? regionDrag.rect : activeRegion.rects![0]
        const left = (rx + margin) * zoom
        const top = ry * zoom
        const corners: ['nw' | 'ne' | 'sw' | 'se', number, number][] = [
          ['nw', left, top], ['ne', left + rw * zoom, top], ['sw', left, top + rh * zoom], ['se', left + rw * zoom, top + rh * zoom]
        ]
        const handlers = (how: 'move' | 'nw' | 'ne' | 'sw' | 'se') => ({
          onPointerDown: (e: React.PointerEvent) => onRegionDown(how, e),
          onPointerMove: onRegionMove, onPointerUp: onRegionUp, onPointerCancel: onRegionCancel
        })
        return (
          <>
            <div className={regionDrag ? 'note-grip moving' : 'note-grip'} data-testid="region-grip" title="Drag to move the region"
              style={{ left: Math.max(0, left - 30), top: Math.max(0, top - 30) }} {...handlers('move')}>
              ✥
            </div>
            {corners.map(([how, cx, cy]) => (
              <div key={how} className={`region-handle ${how}`} data-testid={`region-handle-${how}`} title="Drag to resize the region"
                style={{ left: cx - 9, top: cy - 9 }} {...handlers(how)} />
            ))}
          </>
        )
      })()}
      {selBox && p.inkSelection && sizeHandles([selBox[0] + 4, selBox[1] + 4, selBox[2] - 8, selBox[3] - 8], p.inkSelection, undefined, 'ink-handle')}
      {selBox && !drag && p.inkSelection && (
        <div className="ink-selection-menu" data-testid="ink-selection-menu"
          style={{ left: Math.max(0, (selBox[0] + margin) * zoom), top: (selBox[1] + selBox[3]) * zoom + 6 }}>
          <span className="menu-hint">{p.inkSelection.size} stroke{p.inkSelection.size === 1 ? '' : 's'} · drag inside the box to move, a corner to resize</span>
          <button data-testid="ink-delete" onClick={() => ctl.deleteInk(index, p.inkSelection!)}>Delete ink</button>
          <button data-testid="ink-deselect" onClick={() => ctl.selectInk(index, [])}>Done</button>
        </div>
      )}
      {p.flashRects?.map((r, i) => (
        <div key={`${p.flashKey}-${i}`} className="link-flash" data-testid="link-flash"
          style={{ left: (r[0] + margin) * zoom - 4, top: r[1] * zoom - 4, width: r[2] * zoom + 8, height: r[3] * zoom + 8 }} />
      ))}
      {p.children}
    </div>
  )
})

interface NoteBoxProps {
  note: MarginNote
  zoom: number
  margin: number
  selected: boolean
  showText: boolean
  /** For a typed note: reports its drawn height, in page units. */
  onHeight?: (noteId: string, height: number) => void
}

/** Lines a typed note shows before it folds, until it is selected. */
const FOLD_LINES = 6

/** A typed note: its text, wrapped to its width, at its own size; long notes fold. */
function TypedNote({ note, zoom, margin, selected, onHeight }: NoteBoxProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [x, y, w] = note.box
  const fs = note.fontSize ?? 10
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => {
      setOverflow(el.scrollHeight > el.clientHeight + 2)
      if (onHeight && !selected) {
        const h = el.offsetHeight / zoom
        if (Math.abs(h - note.box[3]) > 1) onHeight(note.id, Math.round(h * 10) / 10)
      }
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [note.id, note.box, note.text, zoom, onHeight, selected])
  const folded = !selected
  return (
    <>
      {selected && (
        <div className="note-outline" data-note-outline={note.id}
          style={{ left: (x + margin) * zoom - 3, top: y * zoom - 3, width: w * zoom + 6, height: (ref.current?.offsetHeight ?? note.box[3] * zoom) + 6 }} />
      )}
      <div ref={ref} className={`note-box typed-note kind-${note.kind}${folded ? ' folded' : ''}`} data-note={note.id} data-typed-note={note.id}
        style={{
          left: (x + margin) * zoom, top: y * zoom, width: w * zoom, fontSize: fs * zoom, lineHeight: TYPED_LINE,
          ...(folded ? { maxHeight: fs * zoom * TYPED_LINE * FOLD_LINES + 6 } : {})
        }}>
        <MathText text={note.text} pandoc />
        {note.targetIds.length === 0 && <span className="note-badge none" title="No target"> · no target</span>}
      </div>
      {folded && overflow && (
        <div className="note-more" style={{ left: (x + margin) * zoom, top: y * zoom + fs * zoom * TYPED_LINE * FOLD_LINES + 6 }}>… click to show all</div>
      )}
    </>
  )
}

/** Handwriting always stays visible. The typed text is a small label shown only on request. */
function NoteBox(props: NoteBoxProps) {
  if (isTyped(props.note)) return <TypedNote {...props} />
  const { note, zoom, margin, selected, showText } = props
  const [x, y, w, h] = note.box
  const hasText = showText && note.kind !== 'drawing' && note.text !== ''
  if (!hasText && !selected) return null
  return (
    <>
      {selected && (
        <div className="note-outline" data-note-outline={note.id}
          style={{ left: (x + margin) * zoom - 3, top: y * zoom - 3, width: w * zoom + 6, height: h * zoom + 6 }} />
      )}
      {hasText && (
        <div className={`note-box typed kind-${note.kind}`} data-note={note.id}
          style={{ left: (x + margin) * zoom, top: y * zoom, fontSize: Math.max(10, 8 * zoom), maxWidth: Math.max(180, 240 * zoom) }}>
          <span className="note-text">{note.text}</span>
          {note.targetIds.length === 0 && <span className="note-badge none" title="No target">no target</span>}
        </div>
      )}
    </>
  )
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
