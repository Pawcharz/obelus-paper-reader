import { useEffect, useState } from 'react'

export function Welcome({ onDone }: { onDone: () => void }) {
  const [path, setPath] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void window.api.defaultLibraryPath().then(setPath)
  }, [])

  async function browse(): Promise<void> {
    const p = await window.api.pickFolder()
    if (p) setPath(p)
  }

  async function create(): Promise<void> {
    try {
      await window.api.addWorkspace(path, 'Personal')
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function chooseFolder(): void {
    if (!path.trim()) {
      setError('Type or choose a folder first.')
      return
    }
    void create()
  }

  return (
    <div className="welcome" data-testid="welcome">
      <h2 style={{ margin: 0 }}>Where should your library live?</h2>
      <p style={{ margin: 0 }}>
        Papers and notes are plain files in a folder of your choice. Any cloud drive can sync it.
      </p>
      <div className="path-row">
        <input value={path} onChange={(e) => setPath(e.target.value)} data-testid="welcome-path"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); chooseFolder() } }} />
        <button onClick={() => void browse()}>Browse…</button>
      </div>
      {error && <div className="warn-banner">{error}</div>}
      <div>
        <button className="primary" data-testid="welcome-create" onClick={chooseFolder}>
          Use this folder
        </button>
      </div>
    </div>
  )
}
