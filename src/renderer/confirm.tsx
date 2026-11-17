import { useEffect, useState } from 'react'

export interface ConfirmRequest {
  title: string
  body: string
  /** The label of the button that does it, e.g. "Delete paper". */
  action: string
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void }

let show: ((p: Pending) => void) | null = null

/** Asks before anything destructive. Resolves true only if the person confirms. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(false)
      return
    }
    show({ ...request, resolve })
  })
}

/** Mounted once, in the app shell. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    show = setPending
    return () => {
      show = null
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  function finish(ok: boolean): void {
    pending?.resolve(ok)
    setPending(null)
  }

  if (!pending) return null
  return (
    <div className="modal-back" data-testid="confirm-dialog" onPointerDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div className="modal">
        <h3>{pending.title}</h3>
        <p style={{ margin: 0 }}>{pending.body}</p>
        <div className="row">
          <button data-testid="confirm-cancel" autoFocus onClick={() => finish(false)}>Cancel</button>
          <button className="danger-solid" data-testid="confirm-ok" onClick={() => finish(true)}>{pending.action}</button>
        </div>
      </div>
    </div>
  )
}
