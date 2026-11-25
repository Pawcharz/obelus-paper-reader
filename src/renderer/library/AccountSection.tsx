import { useCallback, useEffect, useState } from 'react'
import type { AccountStatus } from '../../shared/api'
import type { LayerOwner } from '../../shared/types'
import { isAccountAuthorId } from '../../shared/account'
import { askConfirm } from '../confirm'

/**
 * The account pop-up (top of the left rail). Signed in with Google, every computer signed in to the same account shows the
 * same margin notes, marks and side notes. Signed out, notes are kept under this computer's own
 * identity, as before.
 */
export function AccountSection() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [owners, setOwners] = useState<LayerOwner[]>([])
  const [busy, setBusy] = useState<'' | 'signing-in' | 'merging'>('')
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<string[]>([])

  const refresh = useCallback(async () => {
    setStatus(await window.api.accountStatus())
    setOwners(await window.api.listLayerOwners().catch(() => []))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Open papers loaded their notes under the old identity; starting afresh loads the new one's. */
  const restart = (): void => window.location.reload()

  async function signIn(): Promise<void> {
    setError('')
    setBusy('signing-in')
    const r = await window.api.signInWithGoogle()
    setBusy('')
    if (!r.ok) {
      if (r.reason !== 'Sign-in was cancelled') setError(r.reason)
      return
    }
    restart()
  }

  async function signOut(): Promise<void> {
    const ok = await askConfirm({
      title: 'Sign out of this computer?',
      body: "Your account's notes stay in the library and come back when you sign in again. Until then this computer shows only notes made here while signed out.",
      action: 'Sign out'
    })
    if (!ok) return
    await window.api.signOut()
    restart()
  }

  async function merge(): Promise<void> {
    const n = chosen.length
    const ok = await askConfirm({
      title: `Move notes from ${n === 1 ? 'one other identity' : `${n} other identities`}?`,
      body: `Their margin notes, marks, ink and side notes join ${status?.account ? 'your account' : "this computer's"} in every paper. Nothing is deleted: where both have something, both are kept.`,
      action: 'Move notes'
    })
    if (!ok) return
    setBusy('merging')
    try {
      await window.api.mergeLayers(chosen)
    } catch (e) {
      setBusy('')
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    restart()
  }

  if (!status) return null
  const others = owners.filter((o) => !o.current)
  const ownerLabel = (o: LayerOwner): string => {
    if (o.authorId === status.computerAuthorId) return 'This computer, signed out'
    if (isAccountAuthorId(o.authorId)) return `Another Google account (${o.authorId.slice(7, 13)}…)`
    return `Another computer (${o.authorId.slice(0, 8)})`
  }

  return (
    <fieldset className="account" data-testid="account">
      <legend>Account</legend>
      {status.account ? (
        <div className="account-row">
          <div className="account-who">
            <strong data-testid="account-name">{status.account.name}</strong>
            {status.account.email && <span className="hint">{status.account.email}</span>}
            <span className="hint">Every computer signed in to this Google account shows the same notes.</span>
          </div>
          <button data-testid="sign-out" onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : (
        <>
          <div className="hint">
            Not signed in. Notes are kept under this computer's own identity, so another computer opening the same
            library does not show them. Sign in on each computer to share them.
          </div>
          {busy === 'signing-in' ? (
            <div className="account-row">
              <span data-testid="sign-in-waiting">Finish signing in in your browser…</span>
              <button onClick={() => void window.api.cancelSignIn()}>Cancel</button>
            </div>
          ) : (
            <div>
              <button className="primary" data-testid="sign-in-google" disabled={!status.googleConfigured} onClick={() => void signIn()}>
                Sign in with Google
              </button>
            </div>
          )}
          {!status.googleConfigured && (
            <div className="hint" data-testid="google-not-configured">
              Google sign-in is not set up in this copy. Put a Google OAuth client for a desktop app in{' '}
              <code>{status.googleClientFile}</code> and open Settings again.
            </div>
          )}
        </>
      )}
      {others.length > 0 && (
        <div className="account-others" data-testid="layer-owners">
          <div className="hint">
            This library also has notes kept under other identities. Notes you made on another computer before signing in
            are here: move them in to see them.
          </div>
          {others.map((o) => (
            <label key={o.authorId} className="check">
              <input type="checkbox" data-testid="layer-owner" checked={chosen.includes(o.authorId)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, o.authorId] : c.filter((x) => x !== o.authorId)))} />
              {ownerLabel(o)}: {o.papers} {o.papers === 1 ? 'paper' : 'papers'}, last changed {o.lastChanged.slice(0, 10)}
            </label>
          ))}
          <div>
            <button data-testid="merge-layers" disabled={chosen.length === 0 || busy !== ''} onClick={() => void merge()}>
              {busy === 'merging' ? 'Moving…' : status.account ? 'Move into my account' : 'Move into this computer'}
            </button>
          </div>
        </div>
      )}
      {error && <div className="warn-banner" data-testid="account-error">{error}</div>}
    </fieldset>
  )
}
