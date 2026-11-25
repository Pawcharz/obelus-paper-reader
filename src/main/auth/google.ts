import { createHash, randomBytes } from 'node:crypto'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Account } from '../../shared/types'

/**
 * Sign-in with Google for a desktop app: the system browser opens Google's page, Google sends the
 * browser back to a one-off server on 127.0.0.1, and the code it brings is swapped for an ID token
 * (OAuth 2.0 for installed apps, with PKCE). Only who the person is is kept; no access to their
 * Google data is asked for and no token is stored.
 */

export interface GoogleClient {
  clientId: string
  /** Google issues one to desktop clients and requires it, though an installed app cannot keep it secret. */
  clientSecret: string
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const TIMEOUT_MS = 5 * 60 * 1000

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function authUrl(client: GoogleClient, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  })
  return `${AUTH_URL}?${q}`
}

interface IdClaims {
  iss?: string
  aud?: string
  sub?: string
  exp?: number
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

/**
 * Reads the account from an ID token. The token came straight from Google's token endpoint over
 * HTTPS, which OpenID Connect accepts in place of checking its signature (Core 1.0, 3.1.3.7);
 * the issuer, audience and expiry are still checked.
 */
export function accountFromIdToken(idToken: string, clientId: string, now = Date.now()): Account {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Google sent an unreadable sign-in token')
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as IdClaims
  if (!claims.iss || !ISSUERS.has(claims.iss)) throw new Error('The sign-in token is not from Google')
  if (claims.aud !== clientId) throw new Error('The sign-in token is for another app')
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw new Error('The sign-in token has expired')
  if (!claims.sub) throw new Error('The sign-in token names no account')
  return {
    provider: 'google',
    subject: claims.sub,
    email: claims.email_verified === false ? '' : claims.email ?? '',
    name: claims.name ?? claims.email ?? 'Google account',
    picture: claims.picture,
    signedInAt: new Date(now).toISOString()
  }
}

function page(title: string, text: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222;background:#faf8f3">
<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p>${text}</p></div></body>`
}

export type OpenBrowser = (url: string) => Promise<void> | void
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SignInHandle {
  result: Promise<Account>
  cancel(): void
}

/** Starts a sign-in. The promise settles when the browser comes back, on cancel, or after five minutes. */
export function signInWithGoogle(
  client: GoogleClient,
  openBrowser: OpenBrowser,
  fetchFn: Fetch = fetch as unknown as Fetch,
  timeoutMs = TIMEOUT_MS
): SignInHandle {
  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let rejectOuter: (e: Error) => void = () => undefined
  const finish = (): void => {
    if (timer) clearTimeout(timer)
    server?.close()
    server = null
  }
  const result = new Promise<Account>((resolve, reject) => {
    rejectOuter = reject
    const state = base64url(randomBytes(16))
    const { verifier, challenge } = pkcePair()
    let redirectUri = ''
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const reply = (status: number, title: string, text: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, text))
      }
      if (url.searchParams.get('state') !== state) {
        reply(400, 'Sign-in failed', 'This page did not come from the sign-in Obelus started. Try again from the app.')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code) {
        reply(400, 'Sign-in cancelled', 'You can close this tab and go back to Obelus.')
        finish()
        reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled' : `Google refused the sign-in (${error ?? 'no code'})`))
        return
      }
      void (async () => {
        try {
          const r = await fetchFn(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: client.clientId,
              client_secret: client.clientSecret,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
              code_verifier: verifier
            }).toString()
          })
          const body = (await r.json()) as { id_token?: string; error?: string; error_description?: string }
          if (!r.ok || !body.id_token) throw new Error(body.error_description || body.error || `Google answered ${r.status}`)
          const account = accountFromIdToken(body.id_token, client.clientId)
          reply(200, 'Signed in to Obelus', `As ${account.email || account.name}. You can close this tab and go back to the app.`)
          resolve(account)
        } catch (e) {
          reply(500, 'Sign-in failed', 'Go back to Obelus to see why.')
          reject(e instanceof Error ? e : new Error(String(e)))
        } finally {
          finish()
        }
      })()
    })
    server = srv
    srv.on('error', (e) => {
      finish()
      reject(e)
    })
    // Port 0: the system picks a free one. Google allows any port for a loopback address.
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      redirectUri = `http://127.0.0.1:${port}/callback`
      timer = setTimeout(() => {
        finish()
        reject(new Error('Sign-in timed out: nothing came back from the browser in five minutes'))
      }, timeoutMs)
      Promise.resolve(openBrowser(authUrl(client, redirectUri, state, challenge))).catch((e) => {
        finish()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  })
  return {
    result,
    cancel: () => {
      finish()
      rejectOuter(new Error('Sign-in was cancelled'))
    }
  }
}
