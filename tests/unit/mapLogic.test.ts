import { describe, expect, it } from 'vitest'
import {
  acceptEdge,
  containerOf,
  groupItems,
  papersInGroup,
  ungroup,
  addEdge,
  emptyMap,
  mapShortName,
  nodeLabel,
  removeEdge,
  removeNode,
  suggestCitationEdge,
  wouldCreateCycle
} from '../../src/shared/mapLogic'
import { MapEdge, ReadingMap } from '../../src/shared/types'
import { visibleGraph } from '../../src/shared/mapLayout'

const e = (from: string, to: string): MapEdge => ({ from, to, status: 'confirmed' })

describe('cycles', () => {
  it('detects a loop', () => {
    expect(wouldCreateCycle([e('a', 'b'), e('b', 'c')], 'c', 'a')).toBe(true)
  })
  it('allows many-to-many without loops', () => {
    expect(wouldCreateCycle([e('a', 'c'), e('b', 'c')], 'a', 'd')).toBe(false)
    expect(wouldCreateCycle([e('a', 'c'), e('b', 'c')], 'b', 'a')).toBe(false)
  })
  it('refuses a self arrow', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true)
  })
  it('refuses a loop with a message', () => {
    const map = { ...emptyMap('m', 'M'), edges: [e('a', 'b')] }
    const r = addEdge(map, e('b', 'a'))
    expect(r.ok).toBe(false)
  })
})

describe('citation suggestions', () => {
  it('adds the cited paper with a dashed arrow towards the citing paper', () => {
    const map = { ...emptyMap('m', 'M'), nodes: [{ paperId: 'gmr' }] }
    const out = suggestCitationEdge(map, 'mdm', 'gmr')
    expect(out.nodes.map((n) => n.paperId)).toEqual(['gmr', 'mdm'])
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]).toMatchObject({ from: 'mdm', to: 'gmr', status: 'suggested' })
  })
  it('accept makes it solid; dismiss keeps the paper', () => {
    const map = suggestCitationEdge({ ...emptyMap('m', 'M'), nodes: [{ paperId: 'gmr' }] }, 'mdm', 'gmr')
    expect(acceptEdge(map, 'mdm', 'gmr').edges[0].status).toBe('confirmed')
    const dismissed = removeEdge(map, 'mdm', 'gmr')
    expect(dismissed.edges).toEqual([])
    expect(dismissed.nodes).toHaveLength(2)
  })
  it('keeps the paper without an arrow if the arrow would loop', () => {
    const map = { ...emptyMap('m', 'M'), nodes: [{ paperId: 'a' }, { paperId: 'b' }], edges: [e('a', 'b')] }
    expect(suggestCitationEdge(map, 'b', 'a').edges).toHaveLength(1)
  })
  it('removing a node removes its arrows', () => {
    const map = { ...emptyMap('m', 'M'), nodes: [{ paperId: 'a' }, { paperId: 'b' }], edges: [e('a', 'b')] }
    expect(removeNode(map, 'a').edges).toEqual([])
  })
})

describe('nested groups', () => {
  const base = (): ReadingMap => ({
    schema: 1, id: 'm', name: 'M', edges: [],
    nodes: [{ paperId: 'a', group: 'g1' }, { paperId: 'b', group: 'g1' }, { paperId: 'c' }, { paperId: 'd', group: 'g2' }],
    groups: [{ id: 'g1', title: 'One', collapsed: false }, { id: 'g2', title: 'Two', collapsed: false }]
  })

  it('groups a group together with a paper, and the new group holds both', () => {
    const m = groupItems(base(), ['group:g1', 'c'], 'g3', 'Outer')
    expect(m.groups.find((g) => g.id === 'g1')?.parent).toBe('g3')
    expect(m.nodes.find((n) => n.paperId === 'c')?.group).toBe('g3')
    expect(m.groups.find((g) => g.id === 'g3')?.parent).toBeUndefined()
    expect(papersInGroup(m, 'g3').sort()).toEqual(['a', 'b', 'c'])
  })

  it('makes a group inside a group when the items share it', () => {
    const m = groupItems(base(), ['a', 'b'], 'g3', 'Inner')
    expect(m.groups.find((g) => g.id === 'g3')?.parent).toBe('g1')
    expect(containerOf(m, 'group:g3')).toBe('g1')
  })

  it('ungrouping moves the contents to the group around it', () => {
    const inner = groupItems(base(), ['a'], 'g3', 'Inner')
    const m = ungroup(inner, 'g3')
    expect(m.nodes.find((n) => n.paperId === 'a')?.group).toBe('g1')
    const top = ungroup(groupItems(base(), ['group:g1'], 'g4', 'Outer'), 'g4')
    expect(top.groups.find((g) => g.id === 'g1')?.parent).toBeUndefined()
  })

  it('a folded outer group hides the groups inside it and stands in for their arrows', () => {
    let m = groupItems(base(), ['group:g1', 'c'], 'g3', 'Outer')
    m = { ...m, edges: [{ from: 'a', to: 'd', status: 'confirmed' }] }
    m = { ...m, groups: m.groups.map((g) => (g.id === 'g3' ? { ...g, collapsed: true } : g)) }
    const v = visibleGraph(m)
    expect(v.groups.map((g) => g.id).sort()).toEqual(['g2', 'g3'])
    expect(v.groups.find((g) => g.id === 'g3')?.memberCount).toBe(3)
    expect(v.papers.map((p) => p.paperId)).toEqual(['d'])
    expect(v.edges[0].source).toBe('group:g3')
  })
})

describe('moving into and out of groups', () => {
  const m = (): ReadingMap => ({
    schema: 1, id: 'm', name: 'M', edges: [],
    nodes: [{ paperId: 'a', group: 'g1' }, { paperId: 'b' }],
    groups: [{ id: 'g1', title: 'One', collapsed: false }, { id: 'g2', title: 'Two', collapsed: false, parent: 'g1' }]
  })
  it('moves a paper into a group and out to the top', async () => {
    const { moveToGroup } = await import('../../src/shared/mapLogic')
    expect(moveToGroup(m(), 'b', 'g2').nodes.find((n) => n.paperId === 'b')?.group).toBe('g2')
    expect(moveToGroup(m(), 'a', undefined).nodes.find((n) => n.paperId === 'a')?.group).toBeUndefined()
  })
  it('never puts a group inside itself or a group it holds', async () => {
    const { moveToGroup } = await import('../../src/shared/mapLogic')
    expect(moveToGroup(m(), 'group:g1', 'g2')).toEqual(m())
    expect(moveToGroup(m(), 'group:g1', 'g1')).toEqual(m())
    expect(moveToGroup(m(), 'group:g2', undefined).groups.find((g) => g.id === 'g2')?.parent).toBeUndefined()
  })
})

describe('short names on map boxes', () => {
  const node = { paperId: 'arxiv:1912.01603', title: 'Dream to Control', short_name: 'Dreamer' }
  const full = { title: 'Dream to Control: Learning Behaviors by Latent Imagination' }

  it('shows the box name until the library entry has its own', () => {
    expect(nodeLabel(node.paperId, node, undefined)).toBe('Dreamer')
    expect(nodeLabel(node.paperId, node, full)).toBe('Dreamer')
    expect(nodeLabel(node.paperId, node, { ...full, short_name: 'Dreamer v1' })).toBe('Dreamer v1')
  })

  it('falls back to the library title, then the box title, then the id', () => {
    const plain = { paperId: 'x', title: 'Box title' }
    expect(nodeLabel('x', plain, full)).toBe(full.title)
    expect(nodeLabel('x', plain, undefined)).toBe('Box title')
    expect(nodeLabel('x', undefined, undefined)).toBe('x')
    expect(nodeLabel('x', { ...plain, short_name: '  ' }, { ...full, short_name: ' ' })).toBe(full.title)
  })

  it('finds the first short name any map gives a paper', () => {
    const a: ReadingMap = { ...emptyMap('a', 'A'), nodes: [{ paperId: 'arxiv:1912.01603' }] }
    const b: ReadingMap = { ...emptyMap('b', 'B'), nodes: [node] }
    expect(mapShortName([a, b], 'arxiv:1912.01603')).toBe('Dreamer')
    expect(mapShortName([a], 'arxiv:1912.01603')).toBe('')
    expect(mapShortName([b], 'arxiv:2010.02193')).toBe('')
  })
})
