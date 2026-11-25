import { useCallback, useEffect, useRef, useState } from 'react'
import { AppSettings, PaperEntry, PreviewItem, paperLabel } from '../shared/types'
import { Reader, ReaderSource } from './reader/Reader'
import { GearIcon, KeyboardIcon, LibraryIcon, MapsIcon, ObelusLogo, PenModeIcon, PersonIcon, RecordIcon } from './icons'
import { modeOf } from './mode'

/** One or two letters for the account's badge in the side rail. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase()
}
import { Library } from './library/Library'
import { MapView } from './map/MapView'
import { Welcome } from './library/Welcome'
import { SettingsDialog } from './library/SettingsDialog'
import { AccountSection } from './library/AccountSection'
import { ConfirmHost } from './confirm'
import { logEvent, setUsageLogging } from './usageLog'

type DocTab = { key: string; title: string; source: ReaderSource }
type View = { kind: 'library' } | { kind: 'map' } | { kind: 'doc'; key: string }

const OPEN_TABS_KEY = 'paper-reader.open-tabs'
interface OpenTabs { workspace: string; papers: string[]; view: string }
function loadOpenTabs(): OpenTabs | null {
  try { return JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? 'null') as OpenTabs | null } catch { return null }
}
function saveOpenTabs(v: OpenTabs): void {
  try { localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(v)) } catch { /* storage unavailable: tabs are not reopened */ }
}

interface Lookup {
  id: number
  /** The normalised reference text, so the same reference is not looked up twice at once. */
  key: string
  label: string
}

interface Toast {
  id: number
  message: string
  action?: { label: string; run: () => void }
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [view, setView] = useState<View>({ kind: 'library' })
  const [tabs, setTabs] = useState<DocTab[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [workspaceTick, setWorkspaceTick] = useState(0)
  const nextToast = useRef(1)
  const marginTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setSettings(s)
      setUsageLogging(!!s.usageLog)
    })
  }, [])

  // The papers you had open, and which tab was in front, come back when the app starts. Kept per
  // workspace on this computer; previews are left out, as they are temporary.
  const restoredTabs = useRef(false)
  // Saving starts only after restoring, so the empty start-up state never overwrites the saved tabs.
  // A plain flag, not state: flipping it must not re-render the app (that unsettled the map on start-up).
  const tabsReady = useRef(false)
  useEffect(() => {
    if (!settings || restoredTabs.current) return
    restoredTabs.current = true
    const saved = loadOpenTabs()
    if (!saved || saved.workspace !== settings.activeWorkspaceId || saved.papers.length === 0) { tabsReady.current = true; return }
    window.api.listPapers().then((papers) => {
      const byId = new Map(papers.map((p) => [p.meta.id, p]))
      const restored: DocTab[] = saved.papers
        .map((id) => byId.get(id))
        .filter((e): e is PaperEntry => !!e)
        .map((entry) => ({ key: `paper:${entry.meta.id}`, title: paperLabel(entry.meta), source: { kind: 'paper', entry, fromMapId: '' } }))
      if (restored.length > 0) {
        setTabs((t) => (t.length ? t : restored))
        if (saved.view === 'map') setView({ kind: 'map' })
        else if (saved.view.startsWith('paper:') && restored.some((r) => r.key === saved.view)) setView({ kind: 'doc', key: saved.view })
        logEvent('tabs.restored', { tabs: restored.length })
      }
      tabsReady.current = true
    }).catch(() => { tabsReady.current = true })
  }, [settings])

  const mode = settings ? modeOf(settings) : 'pen'
  const toggleMode = useCallback(async () => {
    if (!settings) return
    const next = modeOf(settings) === 'pc' ? 'pen' : 'pc'
    logEvent('mode', { mode: next, via: 'rail' })
    setSettings(await window.api.updateSettings({ mode: next }))
  }, [settings])

  const toggleUsageLog = useCallback(async () => {
    const on = !settings?.usageLog
    // Switching on writes the first line only after the setting is saved; switching off writes the last line first.
    if (!on) setUsageLogging(false)
    const next = await window.api.updateSettings({ usageLog: on })
    setSettings(next)
    if (on) setUsageLogging(true)
  }, [settings?.usageLog])

  // Which screen is shown, for the usage log.
  useEffect(() => {
    logEvent('view', view.kind === 'doc' ? { view: view.key.split(':')[0], tab: view.key } : { view: view.kind })
  }, [view])

  const notify = useCallback((message: string, action?: Toast['action']) => {
    const id = nextToast.current++
    setToasts((t) => [...t, { id, message, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 15000 : 5000)
  }, [])

  const openPaper = useCallback((entry: PaperEntry, fromMapId = '', page?: number) => {
    const key = `paper:${entry.meta.id}`
    const goTo = page === undefined ? undefined : { page, tick: Date.now() }
    setTabs((t) =>
      t.some((x) => x.key === key)
        ? goTo ? t.map((x) => (x.key === key && x.source.kind === 'paper' ? { ...x, source: { ...x.source, goTo } } : x)) : t
        : [...t, { key, title: paperLabel(entry.meta), source: { kind: 'paper', entry, fromMapId, goTo } }]
    )
    setView({ kind: 'doc', key })
  }, [])

  const openPreview = useCallback((preview: PreviewItem, citingId: string, fromMapId: string, page?: number) => {
    const key = `preview:${preview.previewId}`
    // The same preview is never opened twice; its tab is shown again instead.
    setTabs((t) =>
      t.some((x) => x.key === key)
        ? t
        : [...t, { key, title: `Preview: ${preview.paper.title}`, source: { kind: 'preview', preview, citingId, fromMapId, goTo: page === undefined ? undefined : { page, tick: Date.now() } } }]
    )
    setView({ kind: 'doc', key })
  }, [])

  const viewRef = useRef(view)
  viewRef.current = view
  const lookupsRef = useRef<Lookup[]>([])
  const [lookups, setLookups] = useState<Lookup[]>([])
  const nextLookup = useRef(1)
  const setLookupList = (next: Lookup[]) => {
    lookupsRef.current = next
    setLookups(next)
  }

  /**
   * Looks up a reference while you keep reading. The result opens straight away if you are still
   * on the paper you asked from; otherwise a message offers to open it.
   */
  const lookUp = useCallback(
    async (originKey: string, text: string, citingId: string, fromMapId: string, page?: number) => {
      const key = text.replace(/\s+/g, ' ').trim().toLowerCase()
      if (!key) {
        notify('No reference text was found here. Underline the entry and try again.')
        return
      }
      if (lookupsRef.current.some((l) => l.key === key)) {
        notify('Already looking this reference up.')
        return
      }
      const lookup: Lookup = { id: nextLookup.current++, key, label: text.replace(/\s+/g, ' ').trim().slice(0, 70) }
      setLookupList([...lookupsRef.current, lookup])
      const started = Date.now()
      logEvent('citation.lookup', { lookup: lookup.id })
      const outcome = await window.api.previewReference(text)
      logEvent('citation.result', {
        lookup: lookup.id, tookMs: Date.now() - started, ok: outcome.ok,
        ...(outcome.ok ? {} : { reason: outcome.reason, inLibrary: !!outcome.libraryId })
      })
      const cancelled = !lookupsRef.current.some((l) => l.id === lookup.id)
      setLookupList(lookupsRef.current.filter((l) => l.id !== lookup.id))
      if (cancelled) return
      if (!outcome.ok && outcome.libraryId) {
        // The cited paper is already in the library: open that copy, with its notes.
        const entry = (await window.api.listPapers()).find((p) => p.meta.id === outcome.libraryId)
        if (entry) {
          openPaper(entry, '', page)
          notify(page === undefined ? `Already in your library: ${entry.meta.title}` : `${paperLabel(entry.meta)}, p. ${page + 1}, from your library`)
          return
        }
      }
      if (!outcome.ok) {
        notify(outcome.reason, { label: 'Search the web', run: () => void window.api.searchWeb(outcome.searchText) })
        return
      }
      const v = viewRef.current
      if (v.kind === 'doc' && v.key === originKey) {
        openPreview(outcome.preview, citingId, fromMapId, page)
      } else {
        notify(`Preview ready: ${outcome.preview.paper.title}`, {
          label: 'Open',
          run: () => openPreview(outcome.preview, citingId, fromMapId, page)
        })
      }
    },
    [notify, openPaper, openPreview]
  )

  // Saved whenever the tabs or the tab in front change, once the earlier ones have been restored.
  useEffect(() => {
    if (!settings || !tabsReady.current) return
    const papers = tabs.filter((t) => t.source.kind === 'paper').map((t) => (t.source as { entry: PaperEntry }).entry.meta.id)
    saveOpenTabs({
      workspace: settings.activeWorkspaceId,
      papers,
      view: view.kind === 'doc' ? view.key : view.kind
    })
  }, [tabs, view, settings])

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  /** Recently closed tabs, newest last, for Ctrl+Shift+T. */
  const closedTabs = useRef<{ tab: DocTab; index: number }[]>([])

  /** A reference goes onto the map as a suggestion, without opening a preview. */
  const addToMap = useCallback(async (text: string, citingId: string, fromMapId: string) => {
    const label = text.replace(/\s+/g, ' ').trim().slice(0, 60)
    const done = onBusyRef.current(`Adding to map: ${label}`)
    logEvent('citation.toMap')
    const r = await window.api.addReferenceToMap(text, citingId, fromMapId).finally(done)
    if (!r.ok) notify(r.reason)
    else if (r.already) notify(`Already on "${r.mapName}": ${r.title}`)
    else notify(`Added to "${r.mapName}" as a suggestion: ${r.title}`, { label: 'Show map', run: () => setView({ kind: 'map' }) })
  }, [notify])

  const closeTab = useCallback((key: string) => {
    const index = tabsRef.current.findIndex((x) => x.key === key)
    logEvent('tab.close', { tab: key })
    if (index >= 0) closedTabs.current = [...closedTabs.current.slice(-19), { tab: tabsRef.current[index], index }]
    setTabs((t) => t.filter((x) => x.key !== key))
    setView((v) => (v.kind === 'doc' && v.key === key ? { kind: 'library' } : v))
  }, [])

  /** Brings back the last closed tab, skipping papers deleted since. */
  const reopenTab = useCallback(async () => {
    const papers = await window.api.listPapers()
    while (closedTabs.current.length) {
      const { tab, index } = closedTabs.current[closedTabs.current.length - 1]
      closedTabs.current = closedTabs.current.slice(0, -1)
      if (tab.source.kind === 'paper') {
        const id = tab.source.entry.meta.id
        const entry = papers.find((p) => p.meta.id === id)
        if (!entry) continue
        tab.source = { ...tab.source, entry }
      }
      setTabs((t) => {
        if (t.some((x) => x.key === tab.key)) return t
        const next = [...t]
        next.splice(Math.min(index, next.length), 0, tab)
        return next
      })
      setView({ kind: 'doc', key: tab.key })
      logEvent('tab.reopen', { tab: tab.key })
      return
    }
  }, [])

  // App-wide keys. Ctrl+W closes the open paper's tab, never the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const v = viewRef.current
      if (key === 'w') {
        e.preventDefault()
        if (v.kind === 'doc') closeTab(v.key)
      } else if (key === 't' && e.shiftKey) {
        e.preventDefault()
        void reopenTab()
      } else if (e.key === 'Tab') {
        // Library, Maps, then each open paper, in the order shown at the top.
        e.preventDefault()
        const order: View[] = [{ kind: 'library' }, { kind: 'map' }, ...tabsRef.current.map((t): View => ({ kind: 'doc', key: t.key }))]
        const at = order.findIndex((x) => x.kind === v.kind && (x.kind !== 'doc' || (v.kind === 'doc' && x.key === v.key)))
        setView(order[(Math.max(at, 0) + (e.shiftKey ? -1 : 1) + order.length) % order.length])
      } else if (key === '1' && !e.shiftKey) {
        e.preventDefault()
        setView({ kind: 'library' })
      } else if (key === '2' && !e.shiftKey) {
        e.preventDefault()
        setView({ kind: 'map' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeTab, reopenTab])

  /** Shows that something is happening, such as a PDF downloading, until the returned function is called. */
  const [busyList, setBusyList] = useState<{ id: number; label: string }[]>([])
  const nextBusy = useRef(1)
  const onBusy = useCallback((label: string) => {
    const id = nextBusy.current++
    setBusyList((b) => [...b, { id, label }])
    return () => setBusyList((b) => b.filter((x) => x.id !== id))
  }, [])
  const onBusyRef = useRef(onBusy)
  onBusyRef.current = onBusy

  const onPreviewAdded = useCallback(
    (entry: PaperEntry, preview: PreviewItem) => {
      const previewKey = `preview:${preview.previewId}`
      const key = `paper:${entry.meta.id}`
      setTabs((t) => [
        ...t.filter((x) => x.key !== previewKey && x.key !== key),
        { key, title: paperLabel(entry.meta), source: { kind: 'paper', entry, fromMapId: '' } }
      ])
      setView({ kind: 'doc', key })
      logEvent('preview.added', { paper: entry.meta.id })
      notify(`Added: ${entry.meta.title}`)
    },
    [notify]
  )

  const onEntryChanged = useCallback((entry: PaperEntry) => {
    const key = `paper:${entry.meta.id}`
    setTabs((t) =>
      t.map((x) =>
        x.key === key && x.source.kind === 'paper'
          ? { ...x, title: paperLabel(entry.meta), source: { ...x.source, entry } }
          : x
      )
    )
  }, [])


  async function switchWorkspace(id: string): Promise<void> {
    await window.api.setActiveWorkspace(id)
    setTabs([])
    setView({ kind: 'library' })
    setSettings(await window.api.getSettings())
    setWorkspaceTick((t) => t + 1)
  }

  async function addWorkspace(): Promise<void> {
    const path = await window.api.pickFolder()
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'Workspace'
    await window.api.addWorkspace(path, name)
    setTabs([])
    setView({ kind: 'library' })
    setSettings(await window.api.getSettings())
    setWorkspaceTick((t) => t + 1)
  }

  // A paper renamed or edited anywhere (the Library, a map, Claude) shows its new name on its tab
  // and in its reader.
  useEffect(() => window.api.onChange((e) => {
    if (e.kind !== 'papers' || !tabsRef.current.some((t) => t.source.kind === 'paper')) return
    void window.api.listPapers().then((papers) => {
      const byId = new Map(papers.map((p) => [p.meta.id, p]))
      setTabs((t) => t.map((x) => {
        if (x.source.kind !== 'paper') return x
        const fresh = byId.get(x.source.entry.meta.id)
        if (!fresh || JSON.stringify(fresh.meta) === JSON.stringify(x.source.entry.meta)) return x
        return { ...x, title: paperLabel(fresh.meta), source: { ...x.source, entry: fresh } }
      }))
    })
  }), [])

  // Arrows at the ends of the paper tabs, shown only when tabs are hidden that way.
  const tabStrip = useRef<HTMLDivElement>(null)
  const [hiddenTabs, setHiddenTabs] = useState({ left: false, right: false })
  const checkStrip = useCallback(() => {
    const el = tabStrip.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setHiddenTabs((h) => (h.left === left && h.right === right ? h : { left, right }))
  }, [])
  useEffect(() => {
    const el = tabStrip.current
    if (!el) return
    const ro = new ResizeObserver(checkStrip)
    ro.observe(el)
    // A mouse wheel scrolls the tabs sideways.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { ro.disconnect(); el.removeEventListener('wheel', onWheel) }
  }, [checkStrip, settings, tabs.length > 0])
  useEffect(checkStrip, [tabs, checkStrip])
  const scrollStrip = (dir: number) => {
    const el = tabStrip.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' })
  }

  // The open tab stays in sight when there are more tabs than fit.
  useEffect(() => {
    document.querySelector('.doc-tabs .doc-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [view, tabs.length])

  if (!settings) return <div data-testid="app-root" />
  const account = settings.profile.account

  if (settings.workspaces.length === 0) {
    return (
      <div data-testid="app-root" className="app">
        <div style={{ position: 'absolute', top: 16, left: 16 }}><ObelusLogo size={40} /></div>
        <Welcome onDone={() => void window.api.getSettings().then(setSettings)} />
      </div>
    )
  }

  return (
    <div className="app" data-testid="app-root">
      <nav className="rail" data-testid="rail">
        <button
          className={showAccount ? 'rail-account on' : 'rail-account'}
          data-testid="account-button"
          title={account ? `Signed in as ${account.name}${account.email ? ` (${account.email})` : ''}` : 'Not signed in: sign in to share your notes between computers'}
          onClick={() => setShowAccount((v) => !v)}
        >
          <span className={account ? 'rail-badge' : 'rail-badge signed-out'}>{account ? initials(account.name) : <PersonIcon />}</span>
          <span className="rail-label">{account ? account.name.split(/\s+/)[0] : 'Sign in'}</span>
        </button>
        <button className={view.kind === 'library' ? 'rail-btn on' : 'rail-btn'} data-testid="nav-library" title="Library (Ctrl+1)" onClick={() => setView({ kind: 'library' })}>
          <LibraryIcon /><span className="rail-label">Library</span>
        </button>
        <button className={view.kind === 'map' ? 'rail-btn on' : 'rail-btn'} data-testid="nav-map" title="Maps (Ctrl+2)" onClick={() => setView({ kind: 'map' })}>
          <MapsIcon /><span className="rail-label">Maps</span>
        </button>
        <div className="spacer" />
        <button
          data-testid="mode-toggle"
          className="rail-btn"
          title={mode === 'pc'
            ? 'PC mode: mouse and keyboard, typed notes. Click for Pen mode.'
            : 'Pen mode: a pen writes in the margins. Click for PC mode (mouse and keyboard).'}
          onClick={() => void toggleMode()}
        >
          {mode === 'pc' ? <KeyboardIcon /> : <PenModeIcon />}<span className="rail-label">{mode === 'pc' ? 'PC mode' : 'Pen mode'}</span>
        </button>
        <button
          data-testid="log-toggle"
          className={settings.usageLog ? 'rail-btn log-toggle on' : 'rail-btn log-toggle'}
          title={settings.usageLog
            ? 'Usage log is on: every action is written with its time, to study real use. Press to stop.'
            : 'Usage log is off. Turn it on while reading for real (not while testing), to record which actions you use and in what order.'}
          onClick={() => void toggleUsageLog()}
        >
          <RecordIcon on={settings.usageLog} /><span className="rail-label">{settings.usageLog ? 'Logging' : 'Log off'}</span>
        </button>
        <button className="rail-btn" data-testid="nav-settings" title="Settings" onClick={() => setShowSettings(true)}>
          <GearIcon /><span className="rail-label">Settings</span>
        </button>
      </nav>

      <div className="main">
      {tabs.length > 0 && (
      <div className="tabbar">
        {hiddenTabs.left && <button className="strip-arrow" data-testid="tabs-left" title="Earlier tabs" onClick={() => scrollStrip(-1)}>‹</button>}
        <div className="doc-tabs" data-testid="doc-tabs" ref={tabStrip} onScroll={checkStrip}>
        {tabs.map((t) => {
          const on = view.kind === 'doc' && view.key === t.key
          return (
            <div key={t.key} className={on ? 'doc-tab on' : 'doc-tab'}>
              <button className="doc-tab-name" title={t.title} data-testid="doc-tab" onClick={() => setView({ kind: 'doc', key: t.key })}>{t.title}</button>
              <button className="doc-tab-close" title="Close (Ctrl+W)" aria-label={`Close ${t.title}`} data-testid="doc-close" onClick={() => closeTab(t.key)}>×</button>
            </div>
          )
        })}
        </div>
        {hiddenTabs.right && <button className="strip-arrow" data-testid="tabs-right" title="More tabs" onClick={() => scrollStrip(1)}>›</button>}
      </div>
      )}

      <div className="view">
        {view.kind === 'library' && <Library key={workspaceTick} onOpen={(e) => openPaper(e)} notify={notify} onBusy={onBusy} onDeleted={(id) => closeTab(`paper:${id}`)} />}
        {view.kind === 'map' && <MapView key={workspaceTick} onOpen={(e, mapId) => openPaper(e, mapId)} notify={notify} onBusy={onBusy} />}
        {tabs.map((t) => (
          <div key={t.key} className={view.kind === 'doc' && view.key === t.key ? 'view' : 'hidden-view'}>
            <Reader
              source={t.source}
              active={view.kind === 'doc' && view.key === t.key}
              marginShare={settings.marginShare ?? 1}
              inputMode={settings.inputMode ?? 'pen'}
              mode={mode}
              typedNoteSize={settings.typedNoteSize ?? 'M'}
              onTypedNoteSize={(size) => void window.api.updateSettings({ typedNoteSize: size }).then(setSettings)}
              onSwitchMode={(m) => void window.api.updateSettings({ mode: m }).then(setSettings)}
              mathLayout={settings.mathLayout ?? 'wrap'}
              onLookUp={(text, citingId, fromMapId, page) => void lookUp(t.key, text, citingId, fromMapId, page)}
              onAddToMap={(text, citingId, fromMapId) => void addToMap(text, citingId, fromMapId)}
              onPreviewAdded={onPreviewAdded}
              onEntryChanged={onEntryChanged}
              notify={notify}
            />
          </div>
        ))}
      </div>

      </div>

      {showSettings && (
        <SettingsDialog settings={settings} onClose={() => setShowSettings(false)} onSaved={setSettings}
          onSwitchWorkspace={(id) => void switchWorkspace(id)} onAddWorkspace={() => void addWorkspace()} />
      )}
      {showAccount && (
        <>
          <div className="menu-backdrop" onPointerDown={() => setShowAccount(false)} />
          <div className="account-pop" data-testid="account-pop" onKeyDown={(e) => { if (e.key === 'Escape') setShowAccount(false) }}>
            <AccountSection />
          </div>
        </>
      )}

      <ConfirmHost />
      <div className="toasts">
        {busyList.map((b) => (
          <div key={`busy-${b.id}`} className="toast lookup-toast" data-testid="busy-status">
            <span>{b.label}…</span>
          </div>
        ))}
        {lookups.map((l) => (
          <div key={`lookup-${l.id}`} className="toast lookup-toast" data-testid="lookup-status">
            <span>Looking up: {l.label}…</span>
            <button data-testid="lookup-cancel" onClick={() => setLookupList(lookupsRef.current.filter((x) => x.id !== l.id))}>Cancel</button>
          </div>
        ))}
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-testid="toast">
            <span>{t.message}</span>
            {t.action && (
              <button
                data-testid="toast-action"
                onClick={() => {
                  t.action?.run()
                  setToasts((list) => list.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
