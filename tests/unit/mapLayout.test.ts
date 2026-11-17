import { describe, expect, it } from 'vitest'
import ELK from 'elkjs/lib/elk.bundled.js'
import { groupNodeId, toElk, visibleGraph } from '../../src/shared/mapLayout'
import { ReadingMap } from '../../src/shared/types'

const map: ReadingMap = {
  schema: 1, id: 'm', name: 'M',
  nodes: [{ paperId: 'a' }, { paperId: 'b', group: 'g' }, { paperId: 'c', group: 'g' }, { paperId: 'd' }],
  groups: [{ id: 'g', title: 'Line of work', collapsed: false }],
  edges: [
    { from: 'a', to: 'b', status: 'confirmed' },
    { from: 'a', to: 'c', status: 'suggested' },
    { from: 'b', to: 'c', status: 'confirmed' },
    { from: 'c', to: 'd', status: 'confirmed' }
  ]
}

describe('visibleGraph', () => {
  it('keeps everything when expanded', () => {
    const g = visibleGraph(map)
    expect(g.papers).toHaveLength(4)
    expect(g.edges).toHaveLength(4)
    expect(g.edges.every((e) => e.editable)).toBe(true)
  })
  it('folds a collapsed group into one box and reroutes arrows', () => {
    const g = visibleGraph({ ...map, groups: [{ id: 'g', title: 'L', collapsed: true }] })
    expect(g.papers.map((p) => p.paperId)).toEqual(['a', 'd'])
    expect(g.edges.map((e) => e.id).sort()).toEqual([`a->${groupNodeId('g')}`, `${groupNodeId('g')}->d`].sort())
    expect(g.edges.every((e) => !e.editable)).toBe(true)
    expect(g.groups[0].memberCount).toBe(2)
  })
  it('ignores arrows to papers no longer on the map, and unknown groups', () => {
    const g = visibleGraph({
      ...map,
      nodes: [{ paperId: 'a', group: 'ghost' }],
      edges: [{ from: 'a', to: 'gone', status: 'confirmed' }]
    })
    expect(g.edges).toEqual([])
    expect(g.papers).toEqual([{ paperId: 'a', group: undefined }])
  })
})

describe('layout', () => {
  it('places prerequisites above what they lead to, across many-to-many arrows', async () => {
    const out = (await new ELK().layout(toElk(visibleGraph({ ...map, groups: [], nodes: map.nodes.map((n) => ({ paperId: n.paperId })) })) as never)) as unknown as { children?: { id: string; y?: number }[] }
    const y = (id: string) => (out.children ?? []).find((c) => c.id === id)?.y ?? NaN
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('c'))
    expect(y('c')).toBeLessThan(y('d'))
  })
  it('wraps papers with no arrows into a block, not one long row', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ paperId: `p${i}` }))
    const out = (await new ELK().layout(toElk(visibleGraph({ schema: 1, id: 'x', name: 'x', nodes, edges: [], groups: [] })) as never)) as unknown as { width: number; height: number }
    expect(out.width / out.height).toBeLessThan(5)
    expect(toElk(visibleGraph({ schema: 1, id: 'x', name: 'x', nodes, edges: [], groups: [] })).edges.every((e) => e.id.startsWith('wrap:'))).toBe(true)
    expect(visibleGraph({ schema: 1, id: 'x', name: 'x', nodes, edges: [], groups: [] }).edges).toEqual([])
  })
  it('handles 300 papers in groups', async () => {
    const nodes = Array.from({ length: 300 }, (_, i) => ({ paperId: `p${i}`, group: i % 2 ? `g${i % 10}` : undefined }))
    const edges = Array.from({ length: 299 }, (_, i) => ({ from: `p${i}`, to: `p${i + 1}`, status: 'confirmed' as const }))
    const groups = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, title: `G${i}`, collapsed: i > 5 }))
    const started = Date.now()
    const out = (await new ELK().layout(toElk(visibleGraph({ schema: 1, id: 'x', name: 'x', nodes, edges, groups })) as never)) as unknown as { children?: unknown[] }
    expect(out.children?.length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(20000)
  }, 30000)
})

describe('layout of nested groups and balance', () => {
  type Box = { id: string; x?: number; y?: number; width?: number; height?: number; children?: Box[] }
  const flatten = (items: Box[], ox = 0, oy = 0): Box[] =>
    items.flatMap((c) => {
      const abs = { ...c, x: ox + (c.x ?? 0), y: oy + (c.y ?? 0) }
      return [abs, ...flatten(c.children ?? [], abs.x, abs.y)]
    })

  it('puts an inner group inside its outer group, with nothing overlapping', async () => {
    const nested: ReadingMap = {
      schema: 1, id: 'n', name: 'N',
      nodes: [{ paperId: 'a', group: 'inner' }, { paperId: 'b', group: 'inner' }, { paperId: 'c', group: 'outer' }, { paperId: 'd' }],
      groups: [{ id: 'outer', title: 'Outer', collapsed: false }, { id: 'inner', title: 'Inner', collapsed: false, parent: 'outer' }],
      edges: [{ from: 'a', to: 'c', status: 'confirmed' }, { from: 'c', to: 'd', status: 'confirmed' }]
    }
    const out = (await new ELK().layout(toElk(visibleGraph(nested)) as never)) as unknown as Box
    const all = flatten(out.children ?? [])
    const get = (id: string) => all.find((b) => b.id === id)!
    const o = get('group:outer')
    const i = get('group:inner')
    expect(i.x!).toBeGreaterThanOrEqual(o.x!)
    expect(i.y!).toBeGreaterThanOrEqual(o.y!)
    expect(i.x! + i.width!).toBeLessThanOrEqual(o.x! + o.width!)
    expect(i.y! + i.height!).toBeLessThanOrEqual(o.y! + o.height!)
    const papers = ['a', 'b', 'c', 'd'].map(get)
    for (const p of papers) for (const q of papers) {
      if (p === q) continue
      const apart = p.x! + p.width! <= q.x! || q.x! + q.width! <= p.x! || p.y! + p.height! <= q.y! || q.y! + q.height! <= p.y!
      expect(apart).toBe(true)
    }
  })

  it('centres a paper over the papers it leads to', async () => {
    const fan: ReadingMap = {
      schema: 1, id: 'f', name: 'F', groups: [],
      nodes: ['top', 'x', 'y', 'z'].map((paperId) => ({ paperId })),
      edges: ['x', 'y', 'z'].map((to) => ({ from: 'top', to, status: 'confirmed' as const }))
    }
    const out = (await new ELK().layout(toElk(visibleGraph(fan)) as never)) as unknown as Box
    const all = flatten(out.children ?? [])
    const mid = (id: string) => { const b = all.find((c) => c.id === id)!; return b.x! + b.width! / 2 }
    const children = ['x', 'y', 'z'].map(mid)
    const centre = (Math.min(...children) + Math.max(...children)) / 2
    expect(Math.abs(mid('top') - centre)).toBeLessThan(40)
  })
})

describe('papers moved by hand', () => {
  const laid = {
    id: 'root',
    children: [
      { id: 'a', x: 0, y: 0, width: 220, height: 66 },
      { id: 'group:g', x: 300, y: 0, width: 268, height: 134, children: [{ id: 'b', x: 24, y: 44, width: 220, height: 66 }] }
    ]
  }
  it('keeps the automatic place for papers not moved', async () => {
    const { applyPositions, absoluteBoxes } = await import('../../src/shared/mapLayout')
    const boxes = absoluteBoxes(applyPositions(laid, {}))
    expect(boxes.get('a')).toMatchObject({ x: 0, y: 0 })
    expect(boxes.get('b')).toMatchObject({ x: 324, y: 44 })
  })
  it('puts a moved paper where it was dropped and redraws its group around it', async () => {
    const { applyPositions, absoluteBoxes, GROUP_PAD } = await import('../../src/shared/mapLayout')
    const boxes = absoluteBoxes(applyPositions(laid, { b: { x: 600, y: 400 }, a: { x: -50, y: 10 } }))
    expect(boxes.get('a')).toMatchObject({ x: -50, y: 10 })
    expect(boxes.get('b')).toMatchObject({ x: 600, y: 400 })
    expect(boxes.get('group:g')).toMatchObject({ x: 600 - GROUP_PAD.left, y: 400 - GROUP_PAD.top })
  })
})
