import { useEffect, useState } from 'react'
import type { ModelPackId, ModelStatus } from '../shared/types'

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} kB`
}

/** The live status of the local models offered on this system (updates during a download). */
export function useModels(): ModelStatus[] {
  const [models, setModels] = useState<ModelStatus[]>([])
  useEffect(() => {
    let live = true
    void window.api.listModels().then((m) => { if (live) setModels(m) })
    const off = window.api.onModels((s) => setModels((all) => all.map((m) => (m.id === s.id ? s : m))))
    return () => { live = false; off() }
  }, [])
  return models
}

/** Download, progress, cancel and remove for one local model; used in Settings and in the offer. */
export function ModelControls({ status, compact = false }: { status: ModelStatus; compact?: boolean }) {
  const [error, setError] = useState('')
  const download = async () => {
    setError('')
    const r = await window.api.downloadModel(status.id)
    if (!r.ok && r.error && !/cancel/i.test(r.error)) setError(r.error)
  }
  const pct = status.bytes ? Math.floor((100 * status.done) / status.bytes) : 0
  switch (status.state) {
    case 'unsupported':
      return <span className="hint">Not available on this computer (needs 64-bit Windows or Linux).</span>
    case 'downloading':
      return (
        <span className="model-progress" data-testid={`model-${status.id}-progress`}>
          <progress max={100} value={pct} /> {pct}% of {formatBytes(status.bytes)}{' '}
          <button onClick={() => void window.api.cancelModelDownload(status.id)}>Cancel</button>
        </span>
      )
    case 'ready':
      return (
        <span data-testid={`model-${status.id}-ready`}>
          Ready{compact ? '' : `, ${formatBytes(status.bytes)} on this computer`}.{' '}
          {!compact && status.source === 'downloaded' && (
            <button onClick={() => void window.api.removeModel(status.id)}>Remove</button>
          )}
          {!compact && status.source === 'folder' && <span className="hint">Set up by hand in {status.folder}; the app leaves it alone.</span>}
        </span>
      )
    default:
      return (
        <span>
          <button className="primary" data-testid={`model-${status.id}-download`} onClick={() => void download()}>
            {status.state === 'error' ? 'Try again' : 'Download'} ({formatBytes(status.bytes)})
          </button>
          {(error || status.error) && <span className="warn-text"> {error || status.error}</span>}
        </span>
      )
  }
}

const OFFER_TEXT: Record<ModelPackId, string> = {
  math: 'This note has maths in it. To read it as maths, Obelus needs its maths reader',
  text: 'To turn handwriting into text on this computer, Obelus needs its handwriting reader'
}

/**
 * Asks once whether to download a local model, the first time a note needs it. "Not now" is
 * remembered in the settings; the download can always be started from Settings.
 */
export function ModelOffer({ id, onClose, onReady }: { id: ModelPackId; onClose: () => void; onReady: () => void }) {
  const status = useModels().find((m) => m.id === id)
  const ready = status?.state === 'ready'
  useEffect(() => { if (ready) onReady() }, [ready, onReady])
  if (!status || status.state === 'unsupported') return null
  const decline = async () => {
    const s = await window.api.getSettings()
    await window.api.updateSettings({ declinedModels: [...new Set([...(s.declinedModels ?? []), id])] })
    onClose()
  }
  return (
    <div className="info-banner" data-testid={`model-offer-${id}`}>
      {ready ? (
        <span>{status.title} is ready. <button onClick={onClose}>Close</button></span>
      ) : (
        <>
          <span>
            {OFFER_TEXT[id]} ({formatBytes(status.bytes)}, downloaded once; it runs on this computer and nothing is sent anywhere).
            Your ink and its plain text are kept meanwhile.{' '}
          </span>
          <ModelControls status={status} compact />
          {status.state !== 'downloading' && (
            <>
              {' '}<button data-testid={`model-offer-${id}-later`} onClick={() => void decline()}>Not now</button>
              {id === 'math' && (
                <button data-testid="model-offer-math-off" onClick={() => void window.api.updateSettings({ findMaths: false }).then(onClose)}>
                  Don't look for maths
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
