import { useEffect, useState } from 'react'
import { AppMode, AppSettings, InputMode, MathLayout } from '../../shared/types'
import { detectMode, modeOf } from '../mode'
import { ModelControls, useModels } from '../ModelPanel'

const WINDOWS = /Windows/i.test(navigator.userAgent)

interface Props {
  settings: AppSettings
  onClose: () => void
  onSaved: (s: AppSettings) => void
  /** Changing the library folder takes effect at once, without Save. */
  onSwitchWorkspace: (id: string) => void
  onAddWorkspace: () => void
}

export function SettingsDialog({ settings, onClose, onSaved, onSwitchWorkspace, onAddWorkspace }: Props) {
  const [recognizers, setRecognizers] = useState<string[]>([])
  // The languages ticked; none ticked means every installed one. An older single choice carries over.
  const [chosen, setChosen] = useState<string[]>(settings.recognizers?.length ? settings.recognizers : settings.recognizer ? [settings.recognizer] : [])
  const [displayName, setDisplayName] = useState(settings.profile.displayName)
  const [searchUrl, setSearchUrl] = useState(settings.searchUrlTemplate)
  const [days, setDays] = useState(settings.cacheMaxAgeDays)
  const [gb, setGb] = useState(settings.cacheMaxBytes / 1024 ** 3)
  const [marginShare, setMarginShare] = useState(settings.marginShare ?? 1)
  const [inputMode, setInputMode] = useState<InputMode>(settings.inputMode ?? 'pen')
  const [mathLayout, setMathLayout] = useState<MathLayout>(settings.mathLayout ?? 'wrap')
  const [mode, setMode] = useState<AppMode>(modeOf(settings))
  const [findMaths, setFindMaths] = useState(settings.findMaths !== false)
  const models = useModels()

  useEffect(() => {
    void window.api.listRecognizers().then(setRecognizers)
    // The maths switch can also be turned off from a note's offer, outside this dialog.
    void window.api.getSettings().then((s) => setFindMaths(s.findMaths !== false))
  }, [])
  // A model downloaded while the dialog is open adds its recognizer.
  const modelsReady = models.filter((m) => m.state === 'ready').length
  useEffect(() => {
    void window.api.listRecognizers().then(setRecognizers)
  }, [modelsReady])

  async function save(): Promise<void> {
    onSaved(
      await window.api.updateSettings({
        recognizer: '',
        recognizers: chosen.filter((r) => recognizers.length === 0 || recognizers.includes(r)),
        profile: { ...settings.profile, displayName },
        searchUrlTemplate: searchUrl.includes('{q}') ? searchUrl : settings.searchUrlTemplate,
        cacheMaxAgeDays: Math.max(0.1, days),
        cacheMaxBytes: Math.max(0.05, gb) * 1024 ** 3,
        marginShare,
        inputMode,
        mathLayout,
        mode,
        findMaths
      })
    )
    onClose()
  }

  return (
    <div className="modal-back">
      <div className="modal" data-testid="settings" onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void save() }
        else if (e.key === 'Escape') { e.preventDefault(); onClose() }
      }}>
        <h3>Settings</h3>
        <label>
          Library folder (where papers and notes are kept; switching takes effect at once)
          <select value={settings.activeWorkspaceId} data-testid="workspace-select" onChange={(e) => {
            if (e.target.value === '__add') onAddWorkspace()
            else onSwitchWorkspace(e.target.value)
          }}>
            {settings.workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
            <option value="__add">Add a folder…</option>
          </select>
          <span className="hint" data-testid="workspace-path">{settings.workspaces.find((w) => w.id === settings.activeWorkspaceId)?.path}</span>
        </label>
        <label>
          Mode
          <select value={mode} data-testid="mode-select" onChange={(e) => setMode(e.target.value as AppMode)}>
            <option value="pen">Pen: a touchscreen with an active pen; you write in the margins{detectMode() === 'pen' ? ' (suggested here)' : ''}</option>
            <option value="pc">PC: mouse or trackpad and keyboard; you type your notes{detectMode() === 'pc' ? ' (suggested here)' : ''}</option>
          </select>
        </label>
        {mode === 'pc' && (
          <div className="hint" data-testid="mode-hint">
            Select text to mark it, then press Note (N) for a typed margin note. Double-click the margin for a note there. Right-click anything for its menu; press ? for all keys.
          </div>
        )}
        {mode === 'pen' && (<>
        <label>
          Writing with
          <select value={inputMode} data-testid="input-mode-select" onChange={(e) => setInputMode(e.target.value as InputMode)}>
            <option value="pen">An active pen: the pen writes, a finger scrolls (default)</option>
            <option value="touch">A finger or a simple stylus: it writes, two fingers scroll and zoom</option>
          </select>
        </label>
        {inputMode === 'touch' && (
          <div className="hint" data-testid="input-mode-hint">
            One finger or a stylus without electronics writes with the tool chosen in the toolbar. The mouse selects, as in PC mode.
            Scroll and zoom with two fingers or the mouse wheel. Resting your palm on the screen will write, so keep it off.
          </div>
        )}
        </>)}
        <label>
          Writing margin on each side of a page (only hides writing outside it; nothing is deleted)
          <select value={String(marginShare)} data-testid="margin-select" onChange={(e) => setMarginShare(Number(e.target.value))}>
            <option value="1">100% (default)</option>
            <option value="0.75">75%</option>
            <option value="0.5">50%</option>
            <option value="0.25">25%</option>
            <option value="0">None</option>
          </select>
        </label>
        <label>
          Long equations in side notes
          <select value={mathLayout} data-testid="math-layout-select" onChange={(e) => setMathLayout(e.target.value as MathLayout)}>
            <option value="wrap">Wrap onto new lines (default)</option>
            <option value="scroll">Scroll sideways</option>
          </select>
        </label>
        <label>
          Your name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <fieldset className="recognizer-choice" data-testid="recognizer-choice">
          <legend>Handwriting languages: each note is read in every one ticked, and the best reading is kept. With none ticked, every installed language is tried.</legend>
          {recognizers.map((r, i) => (
            <label key={r} className="check">
              <input type="checkbox" data-testid={`recognizer-${i}`} checked={chosen.includes(r)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r] : c.filter((x) => x !== r)))} />
              {r}
            </label>
          ))}
        </fieldset>
        {recognizers.length === 0 && (
          <div className="warn-banner">
            {WINDOWS
              ? 'No recognizer was found. Add a Handwriting language feature in Windows settings.'
              : 'No handwriting reader yet: download it below. Until then, notes stay as ink.'}
          </div>
        )}
        {models.length > 0 && (
          <fieldset className="local-models" data-testid="local-models">
            <legend>Reading on this computer</legend>
            {WINDOWS && (
              <label className="check">
                <input type="checkbox" data-testid="find-maths" checked={findMaths} onChange={(e) => setFindMaths(e.target.checked)} />
                Find maths written among the words of a note, and read it as maths
              </label>
            )}
            {models.map((m) => (
              <div key={m.id} className="local-model" data-testid={`model-${m.id}`}>
                <div><b>{m.title}</b>: {m.purpose}</div>
                <ModelControls status={m} />
                <div className="hint">{m.credit}. Downloaded once; it runs on this computer and nothing is sent anywhere.</div>
              </div>
            ))}
          </fieldset>
        )}
        <label>
          Web search address ({'{q}'} is replaced by the search text)
          <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} />
        </label>
        <label>
          Delete previews unopened for this many days
          <input type="number" min={0.1} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <label>
          Largest preview cache, in GB
          <input type="number" min={0.05} step={0.5} value={gb} onChange={(e) => setGb(Number(e.target.value))} />
        </label>
        <div className="hint">
          Usage log: switched on and off with the button at the top right. One file per day, kept on this computer only.
          <div><button data-testid="open-usage-logs" onClick={() => void window.api.openUsageLogFolder()}>Open the usage log folder</button></div>
        </div>
        <div className="row">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" data-testid="settings-save" onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  )
}
