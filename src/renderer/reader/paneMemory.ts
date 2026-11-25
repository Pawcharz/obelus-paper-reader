/**
 * Where the notes pane was, per paper: which tab was showing and how far each tab was scrolled.
 * Closing and reopening the pane, switching tabs or reopening the paper comes back to the same
 * place. Kept on this computer, in local storage; losing it only means starting at the top.
 */

const KEY = 'paper-reader.notes-pane'
/** Papers remembered; the least recently used is forgotten first. */
const MAX_PAPERS = 200

interface PaperPane {
  tab: string
  scroll: Record<string, number>
  used: number
}

let memory: Record<string, PaperPane> | null = null

function load(): Record<string, PaperPane> {
  if (memory) return memory
  try {
    memory = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, PaperPane>) ?? {}
  } catch {
    memory = {}
  }
  return memory
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistSoon(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const all = load()
    const ids = Object.keys(all)
    if (ids.length > MAX_PAPERS) {
      ids.sort((a, b) => all[a].used - all[b].used)
      for (const id of ids.slice(0, ids.length - MAX_PAPERS)) delete all[id]
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      /* storage unavailable: remembered until the app closes */
    }
  }, 300)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(load()))
    } catch {
      /* nothing to do */
    }
  })
}

function paper(paperId: string): PaperPane {
  const all = load()
  const p = (all[paperId] ??= { tab: '', scroll: {}, used: 0 })
  p.used = Date.now()
  return p
}

export function rememberedTab(paperId: string): string {
  return load()[paperId]?.tab ?? ''
}

export function rememberTab(paperId: string, tab: string): void {
  const p = paper(paperId)
  if (p.tab === tab) return
  p.tab = tab
  persistSoon()
}

export function rememberedScroll(paperId: string, tab: string): number {
  return load()[paperId]?.scroll[tab] ?? 0
}

export function rememberScroll(paperId: string, tab: string, top: number): void {
  const p = paper(paperId)
  const value = Math.max(0, Math.round(top))
  if (p.scroll[tab] === value) return
  if (value === 0) delete p.scroll[tab]
  else p.scroll[tab] = value
  persistSoon()
}

/** For the tests: forgets everything held in memory, so the next read comes from storage. */
export function resetPaneMemoryCache(): void {
  memory = null
}
