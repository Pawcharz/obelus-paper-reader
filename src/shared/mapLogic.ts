import { MapEdge, MapNode, ReadingMap, SCHEMA_VERSION } from './types'

export function emptyMap(id: string, name: string): ReadingMap {
  return { schema: SCHEMA_VERSION, id, name, nodes: [], edges: [], groups: [] }
}

/** True if adding from -> to would close a loop. Arrows mean "read before", so loops make no sense. */
export function wouldCreateCycle(edges: MapEdge[], from: string, to: string): boolean {
  if (from === to) return true
  const next = new Map<string, string[]>()
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length) {
    const n = stack.pop() as string
    if (n === from) return true
    if (seen.has(n)) continue
    seen.add(n)
    stack.push(...(next.get(n) ?? []))
  }
  return false
}

export type AddEdgeResult = { ok: true; map: ReadingMap } | { ok: false; reason: string }

export function addEdge(map: ReadingMap, edge: MapEdge): AddEdgeResult {
  if (map.edges.some((e) => e.from === edge.from && e.to === edge.to)) return { ok: true, map }
  if (wouldCreateCycle(map.edges, edge.from, edge.to)) {
    return { ok: false, reason: 'That arrow would create a loop, so it was not added.' }
  }
  return { ok: true, map: { ...map, edges: [...map.edges, edge] } }
}

export function addNode(map: ReadingMap, paperId: string): ReadingMap {
  if (map.nodes.some((n) => n.paperId === paperId)) return map
  return { ...map, nodes: [...map.nodes, { paperId }] }
}

export function removeNode(map: ReadingMap, paperId: string): ReadingMap {
  return {
    ...map,
    nodes: map.nodes.filter((n) => n.paperId !== paperId),
    edges: map.edges.filter((e) => e.from !== paperId && e.to !== paperId)
  }
}

/**
 * The map change after adding a cited paper while reading another one: the cited paper joins the
 * map with a dashed arrow towards the citing paper, because it may be worth reading first.
 */
export function suggestCitationEdge(map: ReadingMap, cited: string, citing: string): ReadingMap {
  const withNode = addNode(map, cited)
  const result = addEdge(withNode, {
    from: cited,
    to: citing,
    status: 'suggested',
    reason: 'cited by the paper you were reading'
  })
  return result.ok ? result.map : withNode
}

/** What is known about when a paper came out. */
export interface PaperWhen {
  year?: number | null
  arxiv?: string
  /** Any text naming the paper, such as a link's words "(Hafner et al., 2023)". */
  text?: string
}

/**
 * When a paper came out, as a year with the month as a fraction where arXiv gives it; null if
 * nothing says. An arXiv number holds the year and month, so it is preferred to a plain year.
 */
export function paperTime(p: PaperWhen): number | null {
  const a = (p.arxiv ?? '').trim()
  const m = /^(\d{2})(\d{2})\.\d{4,5}/.exec(a) ?? /\/(\d{2})(\d{2})\d{3}/.exec(a)
  if (m) {
    const yy = Number(m[1])
    const month = Number(m[2])
    if (month >= 1 && month <= 12) return (yy < 90 ? 2000 + yy : 1900 + yy) + (month - 1) / 12
  }
  if (p.year && p.year > 1900) return p.year + 0.5
  const y = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(p.text ?? '')
  return y ? Number(y[1]) + 0.5 : null
}

export type ReferenceDirection = 'earlier' | 'later' | 'unknown'

/** Whether a referenced paper came before or after the one being read. Same time counts as earlier. */
export function referenceDirection(ref: PaperWhen, current: PaperWhen): ReferenceDirection {
  const r = paperTime(ref)
  const c = paperTime(current)
  if (r === null || c === null) return 'unknown'
  return r > c ? 'later' : 'earlier'
}

/**
 * The map change after adding a paper named in another one: an earlier paper gets a dashed arrow
 * towards the paper being read (worth reading first); a later one gets a dashed arrow from it
 * (later work that builds on it). When either date is unknown it is taken as earlier, as a paper
 * cited in another one's references always is.
 */
export function suggestReferenceEdge(map: ReadingMap, ref: string, refWhen: PaperWhen, current: string, currentWhen: PaperWhen): ReadingMap {
  const dir = referenceDirection(refWhen, currentWhen)
  if (dir !== 'later') return suggestCitationEdge(map, ref, current)
  const withNode = addNode(map, ref)
  const result = addEdge(withNode, { from: current, to: ref, status: 'suggested', reason: 'later work that builds on the paper you were reading' })
  return result.ok ? result.map : withNode
}

export function acceptEdge(map: ReadingMap, from: string, to: string): ReadingMap {
  return {
    ...map,
    edges: map.edges.map((e) =>
      e.from === from && e.to === to ? { from, to, status: 'confirmed' as const } : e
    )
  }
}

export function removeEdge(map: ReadingMap, from: string, to: string): ReadingMap {
  return { ...map, edges: map.edges.filter((e) => !(e.from === from && e.to === to)) }
}

export function mapContains(map: ReadingMap, paperId: string): boolean {
  return map.nodes.some((n) => n.paperId === paperId)
}

/**
 * The name a map box shows: the library's short name, then the box's own short name, then the
 * library title, then the box's title.
 */
export function nodeLabel(id: string, node: MapNode | undefined, meta: { title: string; short_name?: string } | undefined): string {
  return meta?.short_name?.trim() || node?.short_name?.trim() || meta?.title || node?.title || id
}

/** The first short name any map gives this paper, or '' if none does. */
export function mapShortName(maps: ReadingMap[], paperId: string): string {
  for (const m of maps) {
    const name = m.nodes.find((n) => n.paperId === paperId)?.short_name?.trim()
    if (name) return name
  }
  return ''
}

/** What holds an item: a paper's group, or a group's parent; undefined for the top of the map. */
export function containerOf(map: ReadingMap, item: string): string | undefined {
  if (item.startsWith('group:')) return map.groups.find((g) => `group:${g.id}` === item)?.parent
  return map.nodes.find((n) => n.paperId === item)?.group
}

/**
 * Puts papers and groups into a new group. Items written as "group:<id>" are groups, the rest
 * papers. The new group sits where the items were if they were all in the same place, otherwise at
 * the top of the map.
 */
export function groupItems(map: ReadingMap, items: string[], id: string, title: string): ReadingMap {
  const places = new Set(items.map((i) => containerOf(map, i) ?? ''))
  const parent = places.size === 1 ? [...places][0] || undefined : undefined
  const groupIds = new Set(items.filter((i) => i.startsWith('group:')).map((i) => i.slice(6)))
  const paperIds = new Set(items.filter((i) => !i.startsWith('group:')))
  return {
    ...map,
    groups: [
      ...map.groups.map((g) => (groupIds.has(g.id) ? { ...g, parent: id } : g)),
      { id, title, collapsed: false, ...(parent ? { parent } : {}) }
    ],
    nodes: map.nodes.map((n) => (paperIds.has(n.paperId) ? { ...n, group: id } : n))
  }
}

/** Removes a group; what was inside it moves to the group around it, or to the top of the map. */
export function ungroup(map: ReadingMap, id: string): ReadingMap {
  const parent = map.groups.find((g) => g.id === id)?.parent
  const move = <T extends object>(item: T, key: 'group' | 'parent'): T => {
    const { [key]: _drop, ...rest } = item as Record<string, unknown>
    return (parent ? { ...rest, [key]: parent } : rest) as T
  }
  return {
    ...map,
    groups: map.groups.filter((g) => g.id !== id).map((g) => (g.parent === id ? move(g, 'parent') : g)),
    nodes: map.nodes.map((n) => (n.group === id ? move(n, 'group') : n))
  }
}

/** Every paper inside a group, nested groups included. */
export function papersInGroup(map: ReadingMap, id: string): string[] {
  const inside = new Set([id])
  for (let grew = true; grew;) {
    grew = false
    for (const g of map.groups) if (g.parent && inside.has(g.parent) && !inside.has(g.id)) { inside.add(g.id); grew = true }
  }
  return map.nodes.filter((n) => n.group && inside.has(n.group)).map((n) => n.paperId)
}

/**
 * Moves a paper, or a group written as "group:<id>", into a group, or to the top of the map when
 * the group is undefined. A group is never moved into itself or into a group it holds.
 */
export function moveToGroup(map: ReadingMap, item: string, into: string | undefined): ReadingMap {
  if (item.startsWith('group:')) {
    const id = item.slice(6)
    if (into && (into === id || papersInGroupIds(map, id).has(into))) return map
    return { ...map, groups: map.groups.map((g) => (g.id === id ? withKey(g, 'parent', into) : g)) }
  }
  return { ...map, nodes: map.nodes.map((n) => (n.paperId === item ? withKey(n, 'group', into) : n)) }
}

function withKey<T extends object>(o: T, key: string, value: string | undefined): T {
  const { [key]: _drop, ...rest } = o as Record<string, unknown>
  return (value ? { ...rest, [key]: value } : rest) as T
}

/** The ids of the groups inside a group, at any depth. */
function papersInGroupIds(map: ReadingMap, id: string): Set<string> {
  const inside = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const g of map.groups) if (g.parent && (g.parent === id || inside.has(g.parent)) && !inside.has(g.id)) { inside.add(g.id); grew = true }
  }
  return inside
}
