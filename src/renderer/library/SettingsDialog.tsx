import { useEffect, useState } from 'react'
import { AppMode, AppSettings, InputMode, MathLayout } from '../../shared/types'
import { detectMode, modeOf } from '../mode'

interface Props {
  settings: AppSettings
  onClose: () => void
  onSaved: (s: AppSettings) => void
}

export function SettingsDialog({ settings, onClose, onSaved }: Props) {
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

  useEffect(() => {
    void window.api.listRecognizers().then(setRecognizers)
  }, [])

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
        mode
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
            No recognizer was found. Add a Handwriting language feature in Windows settings.
          </div>
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
