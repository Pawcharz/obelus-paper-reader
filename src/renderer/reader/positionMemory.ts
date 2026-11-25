/**
 * Where you were in each paper: the page, how far down it, the zoom and the sideways scroll.
 * A paper reopens there (unless a link asks for a page). Kept on this computer, in local storage;
 * losing it only means starting at the top.
 */

const KEY = 'paper-reader.positions'
/** Papers remembered; the least recently read is forgotten first. */
const MAX_PAPERS = 300

export interface ReadingPosition {
  page: number
  /** Page units from the top of that page to the top of the view (plus the usual 80 px heading room). */
  y: number
  zoom: number
  left: number
  used: number
}

function load(): Record<string, ReadingPosition> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, ReadingPosition>) ?? {}
  } catch {
    return {}
  }
}

export function rememberedPosition(paperId: string): ReadingPosition | null {
  const p = load()[paperId]
  return p && Number.isFinite(p.page) && Number.isFinite(p.y) && Number.isFinite(p.zoom) ? p : null
}

export function rememberPosition(paperId: string, pos: Omit<ReadingPosition, 'used'>): void {
  const all = load()
  all[paperId] = { ...pos, used: Date.now() }
  const ids = Object.keys(all)
  if (ids.length > MAX_PAPERS) {
    ids.sort((a, b) => all[a].used - all[b].used)
    for (const id of ids.slice(0, ids.length - MAX_PAPERS)) delete all[id]
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable: the paper opens at the top next time */
  }
}
