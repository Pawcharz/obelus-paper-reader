import { EdgeStatus, MapGroup, ReadingMap } from './types'

export const NODE_W = 220
export const NODE_H = 66
export const GROUP_COLLAPSED_H = 70

export interface LayoutEdge {
  id: string
  /** Real ends of the arrow, used when accepting or removing it. */
  from: string
  to: string
  source: string
  target: string
  status: EdgeStatus
  /** False when the arrow touches a collapsed group and cannot be edited as one paper-to-paper arrow. */
  editable: boolean
}

export interface VisibleGraph {
  /** Papers shown on their own, with the group they sit inside. */
  papers: { paperId: string; group?: string }[]
  groups: (MapGroup & { memberCount: number })[]
  edges: LayoutEdge[]
}

export const groupNodeId = (id: string): string => `group:${id}`

/**
 * Replaces everything inside a folded group with one box and reroutes its arrows to that box.
 * Groups can sit inside groups; a folded group hides all the groups and papers inside it.
 */
export function visibleGraph(map: ReadingMap): VisibleGraph {
  const byId = new Map(map.groups.map((g) => [g.id, g]))
  const parentOf = (id: string): string | undefined => {
    const parent = byId.get(id)?.parent
    return parent && byId.has(parent) && parent !== id ? parent : undefined
  }
  /** The group and its outer groups, innermost first. Stops at a loop, which a bad file could hold. */
  const chain = (id: string | undefined): string[] => {
    const out: string[] = []
    for (let g = id; g && byId.has(g) && !out.includes(g); g = parentOf(g)) out.push(g)
    return out
  }
  /** The outermost folded group around something, which is what stands in for it on screen. */
  const foldedAround = (id: string | undefined): string | undefined =>
    chain(id).filter((g) => byId.get(g)?.collapsed).pop()
  const groupOf = new Map(
    map.nodes.flatMap((n) => (n.group && byId.has(n.group) ? [[n.paperId, n.group] as const] : []))
  )
  const end = (paperId: string): string => {
    const folded = foldedAround(groupOf.get(paperId))
    return folded ? groupNodeId(folded) : paperId
  }
  const present = new Set(map.nodes.map((n) => n.paperId))
  const seen = new Set<string>()
  const edges: LayoutEdge[] = []
  for (const e of map.edges) {
    if (!present.has(e.from) || !present.has(e.to)) continue
    const source = end(e.from)
    const target = end(e.to)
    if (source === target) continue
    const id = `${source}->${target}`
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({ id, from: e.from, to: e.to, source, target, status: e.status, editable: source === e.from && target === e.to })
  }
  // Papers anywhere inside a group, nested groups included.
  const memberCount = (g: string): number => map.nodes.filter((n) => chain(groupOf.get(n.paperId)).includes(g)).length
  // A group is shown unless a folded group around it hides it.
  const shownGroup = (g: string): boolean => !chain(parentOf(g)).some((x) => byId.get(x)?.collapsed)
  return {
    papers: map.nodes
      .filter((n) => !foldedAround(groupOf.get(n.paperId)))
      .map((n) => ({ paperId: n.paperId, group: groupOf.get(n.paperId) })),
    groups: map.groups
      .filter((g) => memberCount(g.id) > 0 && shownGroup(g.id))
      .map((g) => ({ ...g, parent: parentOf(g.id), memberCount: memberCount(g.id) })),
    edges
  }
}

export interface ElkInput {
  id: string
  layoutOptions: Record<string, string>
  children: ElkChild[]
  edges: { id: string; sources: string[]; targets: string[] }[]
}

export interface ElkChild {
  id: string
  width?: number
  height?: number
  layoutOptions?: Record<string, string>
  children?: ElkChild[]
}

/**
 * Layered top-to-bottom layout. Parents are centred over their children (balanced placement), and
 * the gaps are wide enough that boxes and arrows never run into each other.
 */
const ROOT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Long enough that an arrow still shows around its Accept and Dismiss buttons.
  'elk.layered.spacing.nodeNodeBetweenLayers': '130',
  'elk.layered.spacing.edgeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '50',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '16',
  'elk.spacing.componentComponent': '80'
}

const GROUP_OPTIONS = {
  'elk.padding': '[top=44,left=24,bottom=24,right=24]',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.nodeNode': '36'
}

/**
 * A layered layout puts everything without arrows in one endless row. Invisible arrows that only
 * the layout sees wrap such items into a block roughly as wide as it is tall.
 */
function wrapEdges(ids: string[], scope: string): ElkInput['edges'] {
  const perRow = Math.max(4, Math.ceil(Math.sqrt(ids.length * 2)))
  return ids.slice(perRow).map((id, i) => ({ id: `wrap:${scope}:${i}`, sources: [ids[i]], targets: [id] }))
}

export function toElk(graph: VisibleGraph): ElkInput {
  const paper = (id: string): ElkChild => ({ id, width: NODE_W, height: NODE_H })
  const touched = new Set(graph.edges.flatMap((e) => [e.source, e.target]))
  const wraps: ElkInput['edges'] = []

  /** The papers and groups directly inside one group, or at the top when scope is undefined. */
  const build = (scope: string | undefined): { children: ElkChild[]; anyTouched: boolean } => {
    const children: ElkChild[] = []
    const loose: string[] = []
    let anyTouched = false
    for (const p of graph.papers.filter((x) => x.group === scope)) {
      children.push(paper(p.paperId))
      if (touched.has(p.paperId)) anyTouched = true
      else loose.push(p.paperId)
    }
    for (const g of graph.groups.filter((x) => x.parent === scope)) {
      const id = groupNodeId(g.id)
      if (g.collapsed) {
        children.push({ id, width: NODE_W, height: GROUP_COLLAPSED_H })
        if (touched.has(id)) anyTouched = true
        else loose.push(id)
        continue
      }
      const inner = build(g.id)
      children.push({ id, layoutOptions: GROUP_OPTIONS, children: inner.children })
      if (inner.anyTouched || touched.has(id)) anyTouched = true
      else loose.push(id)
    }
    wraps.push(...wrapEdges(loose, scope ?? 'top'))
    return { children, anyTouched }
  }

  const top = build(undefined)
  return {
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children: top.children,
    edges: [...graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })), ...wraps]
  }
}

/** A laid-out box: a paper, a folded group, or an open group holding others. Positions are relative to the parent. */
export interface LaidNode {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: LaidNode[]
}

export type Positions = Record<string, { x: number; y: number }>

/** Space around the contents of an open group, the same as the automatic layout leaves. */
export const GROUP_PAD = { top: 44, left: 24, bottom: 24, right: 24 }

/**
 * Puts papers and folded groups where they were moved by hand, keeping the automatic place for the
 * rest. An open group is then redrawn around whatever it holds, wherever that now is. Positions are
 * absolute, so a paper keeps its place when the group around it changes size.
 */
export function applyPositions(root: LaidNode, positions: Positions): LaidNode {
  const place = (n: LaidNode, ox: number, oy: number): LaidNode & { ax: number; ay: number } => {
    let ax = ox + (n.x ?? 0)
    let ay = oy + (n.y ?? 0)
    // The layout gives papers an empty list of children: only a box holding something is a group.
    if (!n.children?.length) {
      const p = positions[n.id]
      if (p) { ax = p.x; ay = p.y }
      return { ...n, ax, ay }
    }
    const kids = n.children.map((c) => place(c, ax, ay))
    let width = n.width
    let height = n.height
    if (kids.length && n.id !== root.id) {
      const x0 = Math.min(...kids.map((k) => k.ax))
      const y0 = Math.min(...kids.map((k) => k.ay))
      const x1 = Math.max(...kids.map((k) => k.ax + (k.width ?? 0)))
      const y1 = Math.max(...kids.map((k) => k.ay + (k.height ?? 0)))
      ax = x0 - GROUP_PAD.left
      ay = y0 - GROUP_PAD.top
      width = x1 - x0 + GROUP_PAD.left + GROUP_PAD.right
      height = y1 - y0 + GROUP_PAD.top + GROUP_PAD.bottom
    }
    return { ...n, ax, ay, width, height, children: kids }
  }
  // Back to positions relative to the parent, which is what the map view draws.
  const relative = (n: LaidNode & { ax: number; ay: number }, px: number, py: number): LaidNode => ({
    id: n.id,
    x: n.ax - px,
    y: n.ay - py,
    width: n.width,
    height: n.height,
    ...(n.children ? { children: (n.children as (LaidNode & { ax: number; ay: number })[]).map((c) => relative(c, n.ax, n.ay)) } : {})
  })
  const top = place(root, 0, 0)
  return relative(top, 0, 0)
}

/** Every box's absolute rectangle, by id. */
export function absoluteBoxes(root: LaidNode): Map<string, { x: number; y: number; width: number; height: number; leaf: boolean }> {
  const out = new Map<string, { x: number; y: number; width: number; height: number; leaf: boolean }>()
  const walk = (n: LaidNode, ox: number, oy: number) => {
    const x = ox + (n.x ?? 0)
    const y = oy + (n.y ?? 0)
    if (n !== root) out.set(n.id, { x, y, width: n.width ?? 0, height: n.height ?? 0, leaf: !n.children?.length })
    for (const c of n.children ?? []) walk(c, x, y)
  }
  walk(root, 0, 0)
  return out
}
