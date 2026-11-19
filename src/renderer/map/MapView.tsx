import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges, Background, BaseEdge, Connection, Controls, Edge, EdgeLabelRenderer, EdgeProps, getBezierPath, Handle, Node,
  NodeProps, Position, ReactFlow, ReactFlowInstance, ReactFlowProvider, SelectionMode
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ELK from 'elkjs/lib/elk.bundled.js'
import { MapGroup, PaperEntry, ReadingMap } from '../../shared/types'
import { acceptEdge, addEdge, addNode, groupItems, moveToGroup, nodeLabel, papersInGroup, removeEdge, removeNode, ungroup } from '../../shared/mapLogic'
import { absoluteBoxes, applyPositions, GROUP_COLLAPSED_H, groupNodeId, LaidNode, LayoutEdge, NODE_H, NODE_W, toElk, visibleGraph } from '../../shared/mapLayout'
import { newId } from '../../shared/ids'
import { pinchView, Point, View } from '../../shared/pinch'
import { askConfirm } from '../confirm'
import { isTyping, mod, plain, TRASH } from '../keys'
import { logEvent, pointerVia } from '../usageLog'
import { PanelToggle, ResizeHandle, useSidebar } from '../Sidebar'

interface Props {
  onOpen: (e: PaperEntry, mapId: string) => void
  notify: (message: string, action?: { label: string; run: () => void }) => void
  onBusy: (label: string) => () => void
}

interface PaperData extends Record<string, unknown> {
  title: string
  /** The submitted title, when a short name is shown instead. */
  fullTitle?: string
  status: string
  readOn: string
  stub: boolean
  selected: boolean
}
interface GroupData extends Record<string, unknown> {
  group: MapGroup
  memberCount: number
  selected: boolean
  onToggle: (id: string) => void
  onUngroup: (id: string) => void
}
interface EdgeData extends Record<string, unknown> {
  layout: LayoutEdge
  onAccept: (e: LayoutEdge) => void
  onDismiss: (e: LayoutEdge) => void
}

function PaperNode({ data }: NodeProps<Node<PaperData>>) {
  // With a short name, it is shown large and the submitted title small beneath it.
  const named = !!data.fullTitle && data.fullTitle !== data.title
  const marker =
    data.status === 'read' ? (data.readOn ? `Read on ${data.readOn}` : 'Read') : data.status === 'reading' ? 'Reading' : data.stub ? 'No PDF yet' : 'Unread'
  return (
    <div
      className={`paper-node status-${data.status} ${data.stub ? 'stub' : ''}`}
      style={data.selected ? { outline: '2px solid #d9480f' } : undefined}
      data-testid="map-node"
      title={data.fullTitle && data.fullTitle !== data.title ? `${data.title}: ${data.fullTitle}` : data.title}
    >
      <Handle type="target" position={Position.Top} />
      {named ? (
        <>
          <div className="node-name" data-testid="map-node-name">{data.title}</div>
          <div className="node-title" data-testid="map-node-title">{data.fullTitle}</div>
        </>
      ) : (
        <div style={{ overflow: 'hidden', maxHeight: 44 }}>{data.title}</div>
      )}
      <div className="marker">{marker}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  const { group, memberCount, onToggle, onUngroup, selected } = data
  return (
    <div className={`group-node ${group.collapsed ? 'collapsed' : ''}`} data-testid="map-group"
      style={selected ? { outline: '2px solid #d9480f', outlineOffset: 2 } : undefined}>
      {/* Only papers are linked. A folded group still needs these points, invisible and not
          draggable, to draw its papers' arrows to the folded box. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="group-handle" />
      <div className="group-head" style={{ width: '100%' }}>
        <span>{group.title}{group.collapsed ? ` (${memberCount})` : ''}</span>
        <span className="nodrag" style={{ display: 'flex', gap: 3 }}>
          <button data-testid="group-toggle" onClick={(e) => { e.stopPropagation(); onToggle(group.id) }}>{group.collapsed ? 'Open' : 'Fold'}</button>
          <button onClick={(e) => { e.stopPropagation(); onUngroup(group.id) }}>Ungroup</button>
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="group-handle" />
    </div>
  )
}

function PaperEdge(p: EdgeProps<Edge<EdgeData>>) {
  const [path, labelX, labelY] = getBezierPath(p)
  const data = p.data as EdgeData
  const suggested = data.layout.status === 'suggested'
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd="url(#paper-arrow)"
        style={{
          stroke: p.selected ? '#d9480f' : suggested ? '#e8590c' : '#868e96',
          strokeWidth: 1.5,
          strokeDasharray: suggested ? '6 5' : undefined
        }}
      />
      {suggested && data.layout.editable && (
        <EdgeLabelRenderer>
          <div className="edge-buttons nodrag nopan" data-testid="edge-buttons"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <button data-testid="edge-accept" onClick={() => data.onAccept(data.layout)}>Accept</button>
            <button data-testid="edge-dismiss" onClick={() => data.onDismiss(data.layout)}>Dismiss</button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

interface LaidOut {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: LaidOut[]
}

const nodeTypes = { paper: PaperNode, groupBox: GroupNode }
const edgeTypes = { paper: PaperEdge }
const elk = new ELK()
/** Below this zoom the text in the boxes is too small to read, so the app never goes lower by itself. */
const READABLE_ZOOM = 0.6

const ACTIVE_MAP_KEY = 'paper-reader.map-active'
const viewportKey = (mapId: string) => `paper-reader.map-view.${mapId}`

function storedGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function storedSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage unavailable: nothing is remembered */ }
}
/** Where a map was last looked at on this computer, if anywhere. */
function readViewport(mapId: string): { x: number; y: number; zoom: number } | null {
  try {
    const v = JSON.parse(storedGet(viewportKey(mapId)) ?? 'null') as { x: number; y: number; zoom: number } | null
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0 ? v : null
  } catch {
    return null
  }
}

export function MapView(props: Props) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  )
}

function MapInner({ onOpen, notify, onBusy }: Props) {
  const [mapMenu, setMapMenu] = useState('')
  const addInput = useRef<HTMLInputElement>(null)
  const groupInput = useRef<HTMLInputElement>(null)
  const newNameInput = useRef<HTMLInputElement>(null)
  const [maps, setMaps] = useState<ReadingMap[]>([])
  const side = useSidebar('maps', 240, 160, 600)
  const [activeId, setActiveId] = useState(() => storedGet(ACTIVE_MAP_KEY) ?? '')
  useEffect(() => { if (activeId) storedSet(ACTIVE_MAP_KEY, activeId) }, [activeId])
  const [papers, setPapers] = useState<PaperEntry[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Lets a finger or pen select papers, as Ctrl-click does with a mouse. */
  const [selecting, setSelecting] = useState(false)
  const [newName, setNewName] = useState('')
  const [addText, setAddText] = useState('')
  const [groupName, setGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [layoutCount, setLayoutCount] = useState(-1)
  const shownMapId = useRef('')
  const focusGroup = useRef<{ id: string; opening: boolean } | null>(null)
  const flowBox = useRef<HTMLDivElement>(null)
  const flow = useRef<ReactFlowInstance | null>(null)
  /** Where every box was drawn last time, absolute, to tell what a drag moved. */
  const boxesRef = useRef(new Map<string, { x: number; y: number; width: number; height: number; leaf: boolean }>())
  const layoutSeq = useRef(0)

  // Two fingers zoom and pan anywhere on the map. The map library only does that when both fingers
  // start on empty space: a finger on a box (a big group box most of all) is taken for dragging it.
  // So two-finger moves are handled here, before the library sees them, and kept from it until
  // every finger is lifted. Lifts still reach it so its own touch tracking ends cleanly.
  useEffect(() => {
    const box = flowBox.current
    if (!box) return
    let pinch: { view: View; start: [Point, Point]; ids: [number, number] } | null = null
    let holding = false
    const at = (t: Touch): Point => {
      const r = box.getBoundingClientRect()
      return { x: t.clientX - r.left, y: t.clientY - r.top }
    }
    const find = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
      return null
    }
    const begin = (e: TouchEvent): void => {
      const f = flow.current
      if (!f || e.touches.length < 2) return
      const a = e.touches[0]
      const b = e.touches[1]
      pinch = { view: f.getViewport(), start: [at(a), at(b)], ids: [a.identifier, b.identifier] }
      holding = true
    }
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length >= 2) begin(e)
    }
    const onMove = (e: TouchEvent): void => {
      if (!holding) return
      e.stopPropagation()
      e.preventDefault()
      const f = flow.current
      if (!pinch || !f) return
      const a = find(e.touches, pinch.ids[0])
      const b = find(e.touches, pinch.ids[1])
      if (!a || !b) return
      void f.setViewport(pinchView(pinch.view, pinch.start, [at(a), at(b)], 0.05, 2))
    }
    const onEnd = (e: TouchEvent): void => {
      if (!holding) return
      if (e.touches.length >= 2) { begin(e); return }
      pinch = null
      if (e.touches.length === 0) {
        holding = false
        const f = flow.current
        if (f && shownMapId.current) storedSet(viewportKey(shownMapId.current), JSON.stringify(f.getViewport()))
      }
    }
    box.addEventListener('touchstart', onStart, { capture: true })
    box.addEventListener('touchmove', onMove, { capture: true, passive: false })
    box.addEventListener('touchend', onEnd, { capture: true })
    box.addEventListener('touchcancel', onEnd, { capture: true })
    return () => {
      box.removeEventListener('touchstart', onStart, { capture: true })
      box.removeEventListener('touchmove', onMove, { capture: true })
      box.removeEventListener('touchend', onEnd, { capture: true })
      box.removeEventListener('touchcancel', onEnd, { capture: true })
    }
  }, [])

  const reloadMaps = useCallback(async () => setMaps(await window.api.listMaps()), [])
  const reloadPapers = useCallback(async () => setPapers(await window.api.listPapers()), [])

  useEffect(() => {
    void reloadMaps()
    void reloadPapers()
    return window.api.onChange((e) => {
      if (e.kind === 'maps') void reloadMaps()
      if (e.kind === 'papers') void reloadPapers()
    })
  }, [reloadMaps, reloadPapers])

  useEffect(() => {
    if (!activeId && maps.length) setActiveId(maps[0].id)
    if (activeId && maps.length && !maps.some((m) => m.id === activeId)) setActiveId(maps[0].id)
  }, [maps, activeId])

  const map = maps.find((m) => m.id === activeId) ?? null
  const byId = useMemo(() => new Map(papers.map((p) => [p.meta.id, p])), [papers])

  // Undo and Redo for map changes, kept per open map.
  const undoStack = useRef<ReadingMap[]>([])
  const redoStack = useRef<ReadingMap[]>([])
  const [, setHistoryTick] = useState(0)

  const commit = useCallback(async (next: ReadingMap, record = true) => {
    const before = mapRef.current
    if (record && before && before.id === next.id) {
      undoStack.current.push(before)
      if (undoStack.current.length > 100) undoStack.current.shift()
      redoStack.current = []
      setHistoryTick((t) => t + 1)
    }
    setMaps((all) => all.map((m) => (m.id === next.id ? next : m)))
    await window.api.saveMap(next)
  }, [])

  const undoMap = useCallback(() => {
    const prev = undoStack.current.pop()
    const now = mapRef.current
    if (!prev || !now) return
    redoStack.current.push(now)
    setHistoryTick((t) => t + 1)
    void commit(prev, false)
  }, [commit])

  const redoMap = useCallback(() => {
    const next = redoStack.current.pop()
    const now = mapRef.current
    if (!next || !now) return
    undoStack.current.push(now)
    setHistoryTick((t) => t + 1)
    void commit(next, false)
  }, [commit])

  useEffect(() => {
    undoStack.current = []
    redoStack.current = []
    setHistoryTick((t) => t + 1)
  }, [activeId])

  // Replaced on every render (below), so the handler always sees the current selection.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const mapRef = useRef(map)
  mapRef.current = map

  const onToggleGroup = useCallback((id: string) => {
    const m = mapRef.current
    if (!m) return
    const group = m.groups.find((g) => g.id === id)
    focusGroup.current = { id, opening: !!group?.collapsed }
    void commit({ ...m, groups: m.groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)) })
  }, [commit])

  /**
   * Keeps the map readable. A map opens fitted only if its boxes can still be read that way;
   * otherwise it starts at the top left at reading size. Opening or folding a group moves the
   * view to that group without zooming out.
   */
  const placeView = useCallback((laid: Node[], focus: { id: string; opening: boolean } | null) => {
    const f = flow.current
    const box = flowBox.current
    if (!f || !box) return
    const W = box.clientWidth
    const H = box.clientHeight
    const size = (n: Node) => [Number(n.style?.width ?? NODE_W), Number(n.style?.height ?? NODE_H)]
    if (!focus) {
      // Coming back to a map shows it where it was left.
      const id = mapRef.current?.id
      const saved = id ? readViewport(id) : null
      if (saved) { void f.setViewport(saved); return }
      const top = laid.filter((n) => !n.parentId)
      if (top.length === 0) return
      const x0 = Math.min(...top.map((n) => n.position.x))
      const y0 = Math.min(...top.map((n) => n.position.y))
      const x1 = Math.max(...top.map((n) => n.position.x + size(n)[0]))
      const y1 = Math.max(...top.map((n) => n.position.y + size(n)[1]))
      const fitZoom = Math.min((W - 60) / (x1 - x0), (H - 60) / (y1 - y0), 1)
      if (fitZoom >= READABLE_ZOOM) void f.fitView({ padding: 0.1, maxZoom: 1 })
      else void f.setViewport({ x: 30 - x0 * READABLE_ZOOM, y: 30 - y0 * READABLE_ZOOM, zoom: READABLE_ZOOM })
      return
    }
    const g = laid.find((n) => n.id === groupNodeId(focus.id))
    if (!g) return
    const z = Math.max(f.getZoom(), READABLE_ZOOM)
    const [gw, gh] = size(g)
    const x = gw * z < W - 60 ? W / 2 - (g.position.x + gw / 2) * z : 30 - g.position.x * z
    // The group, opened or folded, is centred in the view.
    const y = H / 2 - (g.position.y + gh / 2) * z
    void f.setViewport({ x, y, zoom: z }, { duration: 250 })
  }, [])
  const onUngroup = useCallback((id: string) => {
    const m = mapRef.current
    if (!m) return
    void commit(ungroup(m, id))
  }, [commit])
  const onAccept = useCallback((e: LayoutEdge) => {
    const m = mapRef.current
    if (m) void commit(acceptEdge(m, e.from, e.to))
  }, [commit])
  const onDismiss = useCallback((e: LayoutEdge) => {
    const m = mapRef.current
    if (m) void commit(removeEdge(m, e.from, e.to))
  }, [commit])

  useEffect(() => {
    if (!map) {
      setNodes([])
      setEdges([])
      setLayoutCount(-1)
      return
    }
    const seq = ++layoutSeq.current
    void (async () => {
      const graph = visibleGraph(map)
      const auto = (await elk.layout(toElk(graph) as never)) as unknown as LaidNode
      if (seq !== layoutSeq.current) return
      const laid = applyPositions(auto, map.positions ?? {}) as LaidOut
      boxesRef.current = absoluteBoxes(laid)
      const titleOf = (id: string) => nodeLabel(id, map.nodes.find((n) => n.paperId === id), byId.get(id)?.meta)
      const paperNode = (id: string, x: number, y: number, parentId?: string): Node => {
        const entry = byId.get(id)
        return {
          id,
          type: 'paper',
          position: { x, y },
          ...(parentId ? { parentId } : {}),
          deletable: false,
          selected: selected.has(id),
          data: {
            title: titleOf(id),
            fullTitle: entry?.meta.title ?? titleOf(id),
            status: entry?.meta.status ?? 'unread',
            readOn: entry?.meta.read_on ?? '',
            stub: !entry?.meta.has_pdf,
            selected: selected.has(id)
          } satisfies PaperData,
          style: { width: NODE_W, height: NODE_H }
        }
      }
      const out: Node[] = []
      // A group comes before what it holds; positions inside a group are relative to it.
      const place = (items: LaidOut[], parentId?: string): void => {
        for (const c of items) {
          if (c.id.startsWith('group:')) {
            const group = graph.groups.find((g) => groupNodeId(g.id) === c.id)
            if (!group) continue
            out.push({
              id: c.id,
              type: 'groupBox',
              position: { x: c.x ?? 0, y: c.y ?? 0 },
              ...(parentId ? { parentId } : {}),
              deletable: false,
              selected: selected.has(c.id),
              data: { group, memberCount: group.memberCount, onToggle: onToggleGroup, onUngroup, selected: selected.has(c.id) } satisfies GroupData,
              style: { width: c.width ?? NODE_W, height: c.height ?? GROUP_COLLAPSED_H }
            })
            place(c.children ?? [], c.id)
          } else {
            out.push(paperNode(c.id, c.x ?? 0, c.y ?? 0, parentId))
          }
        }
      }
      place(laid.children ?? [])
      setNodes(out)
      setEdges(
        graph.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'paper',
          deletable: e.editable,
          // Wide enough to hit with a finger.
          interactionWidth: 26,
          data: { layout: e, onAccept, onDismiss } satisfies EdgeData
        }))
      )
      setLayoutCount(out.length)
      const newlyShown = map.id !== shownMapId.current
      shownMapId.current = map.id
      const focus = focusGroup.current
      focusGroup.current = null
      if (newlyShown || focus) requestAnimationFrame(() => placeView(out, newlyShown ? null : focus))
    })()
  }, [map, byId, selected, onToggleGroup, onUngroup, onAccept, onDismiss, placeView])

  async function createMap(): Promise<void> {
    const name = newName.trim()
    if (!name) {
      newNameInput.current?.focus()
      notify('Type a name for the new map first.')
      return
    }
    const m = await window.api.createMap(name)
    setNewName('')
    await reloadMaps()
    setActiveId(m.id)
  }

  async function addPaper(): Promise<void> {
    const text = addText.trim()
    if (!map) return
    if (!text) {
      addInput.current?.focus()
      notify('Type a paper title, arXiv ID or DOI first.')
      return
    }
    const match = papers.find((p) => p.meta.title.toLowerCase() === text.toLowerCase() || (!!p.meta.short_name && p.meta.short_name.toLowerCase() === text.toLowerCase()) || p.meta.id === text)
    if (match) {
      await commit(addNode(map, match.meta.id))
      setAddText('')
      return
    }
    setBusy(true)
    const done = onBusy(`Looking up ${text}`)
    const r = await window.api.addPaperById(text, true).finally(done)
    setBusy(false)
    if (!r.ok) {
      notify(r.reason)
      return
    }
    await commit(addNode(map, r.entry.meta.id))
    await reloadPapers()
    setAddText('')
  }

  async function openNode(id: string): Promise<void> {
    if (!map) return
    const entry = byId.get(id)
    if (entry?.meta.has_pdf) {
      onOpen(entry, map.id)
      return
    }
    setBusy(true)
    const title = entry?.meta.title ?? map.nodes.find((n) => n.paperId === id)?.title ?? id
    const done = onBusy(`Downloading ${title}`)
    let result = await (entry
      ? window.api.fetchPdfForStub(id)
      : window.api.addPaperById(id.replace(/^doi:/, ''))
    ).finally(done)
    setBusy(false)
    if (result.ok && !result.entry.meta.has_pdf) result = { ok: false, reason: 'No open PDF found' }
    if (result.ok) {
      await reloadPapers()
      onOpen(result.entry, map.id)
    } else {
      notify(result.reason, { label: 'Search the web', run: () => void window.api.searchWeb(title) })
    }
  }

  function onNodeClick(e: React.MouseEvent, node: Node): void {
    if (node.type !== 'paper' && !(node.type === 'groupBox' && (selecting || e.ctrlKey || e.shiftKey))) return
    if (selecting || e.ctrlKey || e.shiftKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
      return
    }
    // A mouse click selects, as on a desktop; a double-click opens. A pen or finger tap opens.
    if ((e.nativeEvent as PointerEvent).pointerType === 'mouse' && node.type === 'paper') {
      setSelected(new Set([node.id]))
      return
    }
    void openNode(node.id)
  }

  function onNodeDoubleClick(e: React.MouseEvent, node: Node): void {
    if (node.type !== 'paper' || selecting || e.ctrlKey || e.shiftKey) return
    void openNode(node.id)
  }

  /**
   * After a drag: everything that moved keeps its new place, and a box dropped inside another
   * group's box joins that group, or leaves its group when dropped outside it.
   */
  function onNodeDragStop(_e: unknown, _node: Node, dragged: Node[]): void {
    const m = mapRef.current
    const f = flow.current
    if (!m || !f) return
    const before = boxesRef.current
    const positions = { ...(m.positions ?? {}) }
    let moved = false
    for (const n of f.getNodes()) {
      const old = before.get(n.id)
      const now = f.getInternalNode(n.id)?.internals.positionAbsolute
      if (!old || !now || !old.leaf) continue
      if (Math.abs(old.x - now.x) > 0.5 || Math.abs(old.y - now.y) > 0.5) {
        positions[n.id] = { x: Math.round(now.x), y: Math.round(now.y) }
        moved = true
      }
    }
    let next: ReadingMap = { ...m, positions }
    // Only the outermost dragged boxes change group; what they hold comes along.
    const draggedIds = new Set(dragged.map((d) => d.id))
    const tops = dragged.filter((d) => !d.parentId || !draggedIds.has(d.parentId))
    for (const d of tops) {
      const now = f.getInternalNode(d.id)?.internals.positionAbsolute
      const box = before.get(d.id)
      if (!now || !box) continue
      const cx = now.x + box.width / 2
      const cy = now.y + box.height / 2
      // The innermost open group under the drop point, other than the box itself and what it holds.
      const own = d.id.startsWith('group:') ? new Set([d.id.slice(6), ...[...papersInGroupIdsOf(m, d.id.slice(6))]]) : new Set<string>()
      let into: string | undefined
      let area = Infinity
      for (const [id, b] of before) {
        if (!id.startsWith('group:') || b.leaf || id === d.id || own.has(id.slice(6))) continue
        if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height && b.width * b.height < area) {
          into = id.slice(6)
          area = b.width * b.height
        }
      }
      const current = d.id.startsWith('group:') ? m.groups.find((g) => g.id === d.id.slice(6))?.parent : m.nodes.find((n) => n.paperId === d.id)?.group
      if (into !== current) {
        next = moveToGroup(next, d.id, into)
        moved = true
      }
    }
    if (moved) {
      logEvent('map.move', { items: dragged.length })
      void commit(next)
    }
  }

  /** Box selection, drawn in Select mode, picks what lies inside the box. */
  function onSelectionEnd(): void {
    const f = flow.current
    if (!f) return
    setSelected(new Set(f.getNodes().filter((n) => n.selected).map((n) => n.id)))
  }

  function tidyUp(): void {
    const m = mapRef.current
    if (!m) return
    if (!m.positions || Object.keys(m.positions).length === 0) {
      notify('Nothing was moved by hand; the map is already laid out automatically.')
      return
    }
    const { positions: _drop, ...rest } = m
    void commit(rest)
    notify('Laid out automatically again. Undo brings back where you had moved things.')
  }

  function onConnect(c: Connection): void {
    if (!map || !c.source || !c.target || c.source.startsWith('group:') || c.target.startsWith('group:')) return
    const r = addEdge(map, { from: c.source, to: c.target, status: 'confirmed' })
    logEvent('map.arrow', { ok: r.ok, via: pointerVia() })
    if (r.ok) void commit(r.map)
    else notify(r.reason)
  }

  function onEdgesDelete(deleted: Edge[]): void {
    let m = map
    if (!m) return
    for (const e of deleted) {
      const l = (e.data as EdgeData).layout
      if (l.editable) m = removeEdge(m, l.from, l.to)
    }
    void commit(m)
  }

  function groupSelected(): void {
    const title = groupName.trim()
    if (!map) return
    // Instead of a greyed-out button, say what is missing.
    if (selected.size === 0) {
      notify('Select papers or groups first: press Select, then tap them.')
      return
    }
    if (!title) {
      groupInput.current?.focus()
      notify('Type a name for the group first.')
      return
    }
    void commit(groupItems(map, [...selected], newId('g'), title))
    setGroupName('')
    setSelected(new Set())
    setSelecting(false)
  }

  /** Removing papers from a map is confirmed. They stay in the library, and Undo brings them back. */
  async function removeSelected(): Promise<void> {
    if (!map) return
    const ids = new Set<string>()
    for (const item of selected) {
      if (item.startsWith('group:')) for (const id of papersInGroup(map, item.slice(6))) ids.add(id)
      else ids.add(item)
    }
    if (ids.size === 0) {
      notify('The selected groups hold no papers.')
      return
    }
    const one = ids.size === 1 ? byId.get([...ids][0])?.meta.title ?? map.nodes.find((n) => ids.has(n.paperId))?.title : ''
    const ok = await askConfirm({
      title: one ? `Remove "${one}" from this map?` : `Remove ${ids.size} papers from this map?`,
      body: 'They stay in your library. Undo brings them back to the map.',
      action: 'Remove from map'
    })
    if (!ok) return
    let m = map
    for (const id of ids) m = removeNode(m, id)
    void commit(m)
    setSelected(new Set())
    setSelecting(false)
  }

  const selectedEdges = edges.filter((e) => e.selected && (e.data as EdgeData).layout.editable)

  onKeyRef.current = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if (e.key === 'Escape') {
      setSelected(new Set())
      setSelecting(false)
      setMapMenu('')
      if (isTyping(e)) (e.target as HTMLElement).blur()
      return
    }
    if (isTyping(e)) return
    if (mod(e) && key === 'z') { e.preventDefault(); if (e.shiftKey) redoMap(); else undoMap(); return }
    if (mod(e) && key === 'y') { e.preventDefault(); redoMap(); return }
    if (!map || !plain(e)) return
    // Arrows are removed by the map itself; this covers papers picked in Select mode.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) { e.preventDefault(); void removeSelected(); return }
    if (e.shiftKey) return
    if (key === 's') {
      if (selecting) setSelected(new Set())
      setSelecting(!selecting)
    } else if (key === 'g' && selected.size > 0) {
      e.preventDefault()
      groupInput.current?.focus()
    }
  }

  /** A map holds your reading plan, so deleting it is confirmed and the file goes to the Recycle Bin or Trash. */
  async function deleteMap(m: ReadingMap): Promise<void> {
    setMapMenu('')
    const ok = await askConfirm({
      title: `Delete the map "${m.name}"?`,
      body: `The map goes to the ${TRASH}, where it can be restored. The papers stay in your library.`,
      action: 'Delete map'
    })
    if (!ok) return
    await window.api.removeMap(m.id)
    if (m.id === activeId) setActiveId('')
    await reloadMaps()
    notify(`Moved to the ${TRASH}: ${m.name}`)
  }

  return (
    <div className="map-view" data-testid="map-view">
      {side.open && (
      <div className="side-shell left" style={{ width: side.width }} data-testid="maps-shell">
      <ResizeHandle side="left" width={side.width} onWidth={side.setWidth} testId="maps-resize" />
      <div className="map-side">
        <div style={{ display: 'flex', gap: 4 }}>
          <input ref={newNameInput} style={{ flex: 1, minWidth: 0 }} placeholder="New map name" value={newName} data-testid="new-map-name"
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void createMap()} />
          <button data-testid="new-map-btn" onClick={() => void createMap()}>Add</button>
        </div>
        {maps.map((m) => (
          <div key={m.id} className="map-item-row">
            <button className={m.id === activeId ? 'map-item on' : 'map-item'} data-testid="map-item" onClick={() => setActiveId(m.id)}>
              {m.name}
            </button>
            <button className="row-menu-btn" title="More" data-testid="map-menu" onClick={() => setMapMenu(mapMenu === m.id ? '' : m.id)}>⋯</button>
            {mapMenu === m.id && (
              <div className="pop-menu">
                <button className="danger" data-testid="delete-map" onClick={() => void deleteMap(m)}>Delete map…</button>
              </div>
            )}
          </div>
        ))}
        {maps.length === 0 && <p className="hint">A map shows which papers to read before which.</p>}
      </div>
      </div>
      )}
      <div className="map-canvas">
        {!map && !side.open && (
          <div className="map-tools">
            <PanelToggle side="left" open={false} label="map list" testId="maps-toggle" onClick={() => side.setOpen(true)} />
          </div>
        )}
        {map && (
          <div className="map-tools">
            <PanelToggle side="left" open={side.open} label="map list" testId="maps-toggle" onClick={() => side.setOpen((v) => !v)} />
            <button data-testid="map-undo" disabled={undoStack.current.length === 0} onClick={undoMap}>Undo</button>
            <button data-testid="map-redo" disabled={redoStack.current.length === 0} onClick={redoMap}>Redo</button>
            <button data-testid="map-tidy" title="Clear where you moved things and lay the map out automatically (Undo brings it back)" onClick={tidyUp}>Tidy up</button>
            <input ref={addInput} placeholder="Paper title, arXiv ID or DOI" value={addText} list="library-titles" data-testid="map-add-text" style={{ width: 260 }}
              onChange={(e) => setAddText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addPaper()} />
            <datalist id="library-titles">
              {papers.map((p) => <option key={p.meta.id} value={p.meta.title}>{p.meta.short_name || undefined}</option>)}
            </datalist>
            <button disabled={busy} data-testid="map-add-btn" onClick={() => void addPaper()}>Add paper</button>
            <button
              className={selecting ? 'on' : ''}
              data-testid="map-select-mode"
              title="While on, tapping a paper or a group selects it, and dragging across empty space draws a box that selects what is inside (S)"
              onClick={() => {
                if (selecting) setSelected(new Set())
                setSelecting(!selecting)
              }}
            >
              {selecting ? `Selecting (${selected.size})` : 'Select'}
            </button>
            <input ref={groupInput} placeholder="Group name" value={groupName} data-testid="group-name" style={{ width: 130 }} onChange={(e) => setGroupName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && groupSelected()} />
            <button data-testid="group-btn" onClick={groupSelected}>Group</button>
            <button data-testid="remove-node" onClick={() => {
              if (selected.size === 0) notify('Select papers first: press Select, then tap them.')
              else void removeSelected()
            }}>Remove from map</button>
            <button data-testid="remove-edge" onClick={() => {
              if (selectedEdges.length === 0) notify('Tap an arrow first.')
              else onEdgesDelete(selectedEdges)
            }}>Remove arrow</button>
          </div>
        )}
        <div className="map-flow" ref={flowBox} data-testid="map-flow" data-layout-count={layoutCount}>
          <svg style={{ position: 'absolute', width: 0, height: 0 }}>
            <defs>
              <marker id="paper-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="#868e96" />
              </marker>
            </defs>
          </svg>
          {map ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(i) => { flow.current = i as unknown as ReactFlowInstance }}
              onMoveEnd={(_, v) => { if (map) storedSet(viewportKey(map.id), JSON.stringify(v)) }}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodesChange={(changes) => setNodes((ns) => applyNodeChanges(changes, ns))}
              onNodeDragStop={onNodeDragStop}
              onSelectionEnd={onSelectionEnd}
              nodeDragThreshold={6}
              selectionOnDrag={selecting}
              panOnDrag={selecting ? [1, 2] : true}
              selectionMode={SelectionMode.Full}
              multiSelectionKeyCode={['Control', 'Meta', 'Shift']}
              onConnect={onConnect}
              onEdgesDelete={onEdgesDelete}
              onEdgesChange={(changes) =>
                setEdges((es) =>
                  es.map((e) => {
                    const c = changes.find((x) => x.type === 'select' && x.id === e.id)
                    return c && c.type === 'select' ? { ...e, selected: c.selected } : e
                  })
                )
              }
              deleteKeyCode={['Delete', 'Backspace']}
              nodesDraggable
              onlyRenderVisibleElements
              minZoom={0.05}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} color="#e5e1d9" />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="empty">Create a map on the left.</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** The ids of the groups inside a group, at any depth. */
function papersInGroupIdsOf(map: ReadingMap, id: string): Set<string> {
  const inside = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const g of map.groups) if (g.parent && (g.parent === id || inside.has(g.parent)) && !inside.has(g.id)) { inside.add(g.id); grew = true }
  }
  return inside
}
