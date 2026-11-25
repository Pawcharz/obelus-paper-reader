import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PaperStore } from '../../src/main/storage/paperStore'
import { accountAuthorId, currentAuthorId } from '../../src/shared/account'
import { accountFromIdToken, authUrl, signInWithGoogle } from '../../src/main/auth/google'
import type { Layer, MarginNote, Stroke, Target } from '../../src/shared/types'

let root: string
let store: PaperStore
const meta = { id: 'arxiv:1', title: 'One', authors: [], year: 2024, venue: '', arxiv: '1', doi: '', url: '' }
const meta2 = { ...meta, id: 'arxiv:2', title: 'Two', arxiv: '2' }

const note = (id: string, text = id): MarginNote => ({
  id, page: 0, box: [0, 0, 1, 1], strokeIds: [], text, candidates: [], corrected: false, kind: 'note', targetIds: [], createdAt: '', updatedAt: ''
})
const target = (id: string): Target => ({ id, kind: 'page', page: 0, createdAt: '' })
const stroke = (id: string): Stroke => ({ id, page: 0, points: [], color: '#000', width: 1, createdAt: '' })
const layer = (paperId: string, authorId: string, notes: MarginNote[], strokes: Stroke[] = [], targets: Target[] = []): Layer => ({
  annotations: { schema: 1, paperId, authorId, targets, marginNotes: notes },
  ink: { schema: 1, paperId, authorId, strokes }
})

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pr-account-'))
  store = new PaperStore(root)
  await store.ensure('Test', 'ws1')
  await store.add({ meta })
  await store.add({ meta: meta2 })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('account identity', () => {
  it('is the same on every computer for one account', () => {
    const a = { provider: 'google' as const, subject: '1234567890' }
    expect(accountAuthorId(a)).toBe('google-1234567890')
    const profile = (authorId: string) => ({ profile: { authorId, displayName: 'x', account: { ...a, email: '', name: '', signedInAt: '' } } })
    expect(currentAuthorId(profile('computer-a'))).toBe(currentAuthorId(profile('computer-b')))
  })
  it("is the computer's own while signed out", () => {
    expect(currentAuthorId({ profile: { authorId: 'computer-a', displayName: 'x' } })).toBe('computer-a')
  })
})

describe('merging layers', () => {
  it('moves a layer whole when the account has none in that paper', async () => {
    await store.saveLayer('arxiv:1', 'yoga', layer('arxiv:1', 'yoga', [note('m1')], [stroke('s1')]))
    const side = await store.createSideNote('arxiv:1', 'yoga', { title: 'Summary', generated_by: 'claude' })
    expect(await store.mergeLayers('yoga', 'google-1')).toBe(1)
    const l = await store.loadLayer('arxiv:1', 'google-1')
    expect(l.annotations.marginNotes.map((n) => n.id)).toEqual(['m1'])
    expect(l.annotations.authorId).toBe('google-1')
    expect(l.ink.strokes.map((s) => s.id)).toEqual(['s1'])
    const notes = await store.listSideNotes('arxiv:1')
    expect(notes).toHaveLength(1)
    expect(notes[0].author).toBe('google-1')
    expect(notes[0].path).toContain(join('people', 'google-1', 'notes'))
    expect(side.id).toBe(notes[0].id)
    expect((await store.loadLayer('arxiv:1', 'yoga')).annotations.marginNotes).toEqual([])
  })

  it('joins two layers by id, keeping both sides and the account copy of shared ids', async () => {
    await store.saveLayer('arxiv:1', 'google-1', layer('arxiv:1', 'google-1', [note('m1', 'account'), note('m2')], [stroke('s1')], [target('t1')]))
    await store.saveLayer('arxiv:1', 'laptop', layer('arxiv:1', 'laptop', [note('m1', 'laptop'), note('m3')], [stroke('s2')], [target('t2')]))
    await store.createSideNote('arxiv:1', 'google-1', { title: 'A' })
    await store.createSideNote('arxiv:1', 'laptop', { title: 'B' })
    await store.mergeLayers('laptop', 'google-1')
    const l = await store.loadLayer('arxiv:1', 'google-1')
    expect(l.annotations.marginNotes.map((n) => [n.id, n.text])).toEqual([['m1', 'account'], ['m2', 'm2'], ['m3', 'm3']])
    expect(l.annotations.targets.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(l.ink.strokes.map((s) => s.id)).toEqual(['s1', 's2'])
    const notes = await store.listSideNotes('arxiv:1')
    expect(notes.map((n) => n.title).sort()).toEqual(['A', 'B'])
    expect(new Set(notes.map((n) => n.author))).toEqual(new Set(['google-1']))
    await expect(fs.access(join(root, 'papers'))).resolves.toBeUndefined()
    const people = await fs.readdir(join((await store.get('arxiv:1'))!.folder, 'people'))
    expect(people).toEqual(['google-1'])
  })

  it('keeps both pictures when a region file exists on each side', async () => {
    await store.saveRegionImage('arxiv:1', 'google-1', 't1', new Uint8Array([1]))
    await store.saveRegionImage('arxiv:1', 'laptop', 't1', new Uint8Array([2]))
    await store.mergeLayers('laptop', 'google-1')
    const dir = join((await store.get('arxiv:1'))!.folder, 'people', 'google-1', 'regions')
    expect((await fs.readdir(dir)).sort()).toEqual(['t1-2.png', 't1.png'])
  })

  it('lists who has notes, across papers', async () => {
    await store.saveLayer('arxiv:1', 'yoga', layer('arxiv:1', 'yoga', [note('m1')]))
    await store.saveLayer('arxiv:2', 'yoga', layer('arxiv:2', 'yoga', [note('m2')]))
    await store.saveLayer('arxiv:2', 'laptop', layer('arxiv:2', 'laptop', [note('m3')]))
    const owners = await store.layerOwners('laptop')
    expect(owners.map((o) => [o.authorId, o.papers, o.current]).sort()).toEqual([['laptop', 1, true], ['yoga', 2, false]])
  })

  it('joins a save made under the old identity instead of overwriting the merged notes', async () => {
    await store.saveLayer('arxiv:1', 'google-1', layer('arxiv:1', 'google-1', [note('from-yoga')]))
    // The reader still holds the layer it loaded before signing in.
    await store.saveLayer('arxiv:1', 'google-1', layer('arxiv:1', 'laptop', [note('just-written')]))
    const l = await store.loadLayer('arxiv:1', 'google-1')
    expect(l.annotations.marginNotes.map((n) => n.id).sort()).toEqual(['from-yoga', 'just-written'])
    expect(l.annotations.authorId).toBe('google-1')
  })
})

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`
}

describe('Google ID token', () => {
  const now = 1_800_000_000_000
  const good = { iss: 'https://accounts.google.com', aud: 'client-1', sub: '42', exp: now / 1000 + 600, email: 'a@b.c', email_verified: true, name: 'A' }
  it('reads the account', () => {
    const a = accountFromIdToken(idToken(good), 'client-1', now)
    expect(a).toMatchObject({ provider: 'google', subject: '42', email: 'a@b.c', name: 'A' })
  })
  it('refuses a token for another app, from elsewhere, or expired', () => {
    expect(() => accountFromIdToken(idToken({ ...good, aud: 'other' }), 'client-1', now)).toThrow(/another app/)
    expect(() => accountFromIdToken(idToken({ ...good, iss: 'evil.example' }), 'client-1', now)).toThrow(/not from Google/)
    expect(() => accountFromIdToken(idToken({ ...good, exp: now / 1000 - 3600 }), 'client-1', now)).toThrow(/expired/)
  })
  it('asks only for identity, with PKCE', () => {
    const u = new URL(authUrl({ clientId: 'c', clientSecret: 's' }, 'http://127.0.0.1:5/callback', 'st', 'ch'))
    expect(u.searchParams.get('scope')).toBe('openid email profile')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5/callback')
  })
})

describe('Google sign-in flow', () => {
  it('completes through the loopback redirect', async () => {
    const client = { clientId: 'client-1', clientSecret: 'secret' }
    let tokenBody = ''
    const fakeFetch = async (_url: string, init: { body: string }) => {
      tokenBody = init.body
      return {
        ok: true,
        status: 200,
        json: async () => ({ id_token: idToken({ iss: 'accounts.google.com', aud: 'client-1', sub: '7', exp: Date.now() / 1000 + 600, email: 'p@x.y', name: 'P' }) })
      }
    }
    const handle = signInWithGoogle(client, async (url) => {
      // Stands in for the browser: Google sends it back with a code.
      const u = new URL(url)
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'the-code')
      back.searchParams.set('state', u.searchParams.get('state')!)
      const res = await fetch(back)
      expect(res.status).toBe(200)
    }, fakeFetch)
    const account = await handle.result
    expect(account.subject).toBe('7')
    const sent = new URLSearchParams(tokenBody)
    expect(sent.get('code')).toBe('the-code')
    expect(sent.get('code_verifier')).toBeTruthy()
    expect(sent.get('client_secret')).toBe('secret')
  })

  it('ignores a callback with the wrong state, and can be cancelled', async () => {
    let redirect = ''
    const handle = signInWithGoogle({ clientId: 'c', clientSecret: 's' }, (url) => {
      redirect = new URL(url).searchParams.get('redirect_uri')!
    })
    await new Promise((r) => setTimeout(r, 50))
    const res = await fetch(`${redirect}?code=x&state=forged`)
    expect(res.status).toBe(400)
    handle.cancel()
    await expect(handle.result).rejects.toThrow(/cancelled/)
  })
})
