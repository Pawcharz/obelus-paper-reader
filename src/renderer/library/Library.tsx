import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaperEntry, ReadStatus, paperLabel } from '../../shared/types'
import { extractHints } from '../reader/pdf'
import { isHtmlFile } from '../../shared/htmlReport'
import { askConfirm } from '../confirm'
import { TagInput } from './TagInput'
import { DetailsDialog, DetailsForm, detailsFor, patchFrom } from './DetailsDialog'
import { SortKey, sortPapers } from '../../shared/librarySort'

const SORT_KEY = 'paper-reader.library-sort'

/** The last chosen order, remembered on this computer; by reading status at first. */
function readSort(): { key: SortKey; descending: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null') as { key: SortKey; descending: boolean } | null
    if (saved && ['status', 'title', 'authors', 'year', 'added'].includes(saved.key)) return saved
  } catch {
    /* fall back to the default */
  }
  return { key: 'status', descending: false }
}
import { isTyping, mod, plain, TRASH } from '../keys'

interface Props {
  onOpen: (e: PaperEntry) => void
  notify: (message: string) => void
  /** Shows a progress message until the returned function is called. */
  onBusy: (label: string) => () => void
  onDeleted: (id: string) => void
}

/** A short name for where a paper came from, with the arXiv version when it is known. */
function sourceLabel(url: string, doi: string): string {
  const arxiv = /arxiv\.org\/abs\/([^?#]+)/.exec(url)
  if (arxiv) return `arXiv ${arxiv[1]}`
  if (doi) return `DOI ${doi}`
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Link'
  }
}

export function Library({ onOpen, notify, onBusy, onDeleted }: Props) {
  const [menuFor, setMenuFor] = useState('')
  const [papers, setPapers] = useState<PaperEntry[]>([])
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState<ReadStatus | ''>('')
  const [idText, setIdText] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [titlePrompt, setTitlePrompt] = useState<DetailsForm | null>(null)

  const reload = useCallback(async () => {
    setPapers(await window.api.listPapers())
  }, [])

  useEffect(() => {
    void reload()
    return window.api.onChange((e) => {
      if (e.kind === 'papers') void reload()
    })
  }, [reload])

  useEffect(() => {
    let cancelled = false
    if (!query.trim()) {
      setMatches(null)
      return
    }
    const timer = setTimeout(() => {
      void window.api.searchPapers(query).then((ids) => {
        if (!cancelled) setMatches(new Set(ids))
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, papers])

  const allTags = useMemo(() => [...new Set(papers.flatMap((p) => p.meta.tags))].sort(), [papers])
  const [sort, setSort] = useState(readSort)
  const shown = sortPapers(
    papers.filter(
      (p) =>
        (!matches || matches.has(p.meta.id)) &&
        activeTags.every((t) => p.meta.tags.includes(t)) &&
        (!statusFilter || p.meta.status === statusFilter)
    ),
    sort.key,
    sort.descending
  )
  /** Tapping a column sorts by it; tapping it again reverses the order. */
  const sortBy = (key: SortKey) => {
    const next = { key, descending: sort.key === key ? !sort.descending : false }
    setSort(next)
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next))
    } catch {
      /* the choice just won't be remembered */
    }
  }
  const header = (key: SortKey, label: string) => (
    <th>
      <button className={sort.key === key ? 'sort-head on' : 'sort-head'} data-testid={`sort-${key}`} onClick={() => sortBy(key)}
        title={key === 'status' ? 'Reading first, then read, then unread; newest first in each' : `Sort by ${label.toLowerCase()}`}>
        {label}{sort.key === key ? (sort.descending ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )

  async function addFile(path: string): Promise<void> {
    if (isHtmlFile(path)) return addReport(path)
    setBusy(true)
    try {
      const bytes = await window.api.readFileBytes(path)
      const hints = await extractHints(new Uint8Array(bytes))
      const r = await window.api.addPaperFromFile(path, hints)
      if (r.ok) {
        notify(r.existed ? `Already in the library: ${r.entry.meta.title}` : `Added: ${r.entry.meta.title}`)
        await reload()
      } else if (r.needsTitle) {
        setTitlePrompt({
          mode: 'add', path, hints, title: r.titleGuess ?? '', short_name: '',
          authors: (hints.authorsGuess ?? []).join(', '),
          year: hints.yearGuess ? String(hints.yearGuess) : '',
          url: ''
        })
      } else {
        notify(r.reason)
      }
    } catch (e) {
      notify(`This file could not be added. ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * An HTML report is turned into a PDF (scroll boxes, tabs and collapsed parts opened) and kept
   * beside it. Reports are not looked up online, so the details box always opens.
   */
  async function addReport(path: string): Promise<void> {
    setBusy(true)
    notify('Turning the HTML report into a PDF…')
    try {
      const c = await window.api.convertHtml(path)
      if (!c.ok) { notify(c.reason); return }
      const hints = await extractHints(new Uint8Array(await window.api.readFileBytes(c.pdfPath)))
      const name = path.replace(/.*[\\/]/, '').replace(/\.html?$/i, '')
      setTitlePrompt({
        mode: 'add', path: c.pdfPath, hints, original: path,
        title: c.titleGuess || name, short_name: '', authors: '',
        year: String(new Date().getFullYear()), url: ''
      })
    } catch (e) {
      notify(`This report could not be added. ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function confirmTitle(f: DetailsForm): Promise<void> {
    if (!f.title.trim()) return
    const { authors, year, url } = patchFrom(f)
    const details = { authors, year, url }
    setTitlePrompt(null)
    if (f.mode === 'edit' && f.id) {
      await window.api.updatePaper(f.id, patchFrom(f))
      notify(`Details saved: ${f.title.trim()}`)
      await reload()
      return
    }
    if (!f.path || !f.hints) return
    const r = await window.api.addPaperFromFile(f.path, f.hints, f.title.trim(), details, f.original)
    if (r.ok && f.short_name.trim() && !r.existed) await window.api.updatePaper(r.entry.meta.id, { short_name: f.short_name.trim() })
    if (r.ok) {
      notify(r.existed ? `Already in the library: ${r.entry.meta.title}` : `Added: ${r.entry.meta.title}`)
      await reload()
    } else notify(r.reason)
  }

  function editDetails(p: PaperEntry): void {
    setMenuFor('')
    setTitlePrompt(detailsFor(p.meta))
  }

  async function addById(): Promise<void> {
    const text = idText.trim()
    if (!text) {
      addIdRef.current?.focus()
      notify('Type an arXiv ID, an arXiv link or a DOI first.')
      return
    }
    setBusy(true)
    const done = onBusy(`Looking up ${text}`)
    const r = await window.api.addPaperById(text).finally(done)
    setBusy(false)
    if (r.ok) {
      notify(
        r.existed
          ? `Already in the library: ${r.entry.meta.title}`
          : r.entry.meta.has_pdf
            ? `Added: ${r.entry.meta.title}`
            : `Added without a PDF: ${r.entry.meta.title}`
      )
      setIdText('')
      await reload()
    } else notify(r.reason)
  }

  /** Deleting a paper loses its PDF and every note on it, so it is confirmed and goes to the Recycle Bin or Trash. */
  async function deletePaper(p: PaperEntry): Promise<void> {
    setMenuFor('')
    const ok = await askConfirm({
      title: `Delete "${p.meta.title}"?`,
      body: `The PDF and all your notes and marks on it go to the ${TRASH}, where they can be restored.`,
      action: 'Delete paper'
    })
    if (!ok) return
    await window.api.deletePaper(p.meta.id)
    onDeleted(p.meta.id)
    notify(`Moved to the ${TRASH}: ${p.meta.title}`)
    await reload()
  }

  // "/" or Ctrl+F jumps to the search box; Enter opens the first paper listed.
  const searchRef = useRef<HTMLInputElement>(null)
  const addIdRef = useRef<HTMLInputElement>(null)
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  onKeyRef.current = (e: KeyboardEvent) => {
    if ((mod(e) && e.key.toLowerCase() === 'f') || (plain(e) && e.key === '/' && !isTyping(e))) {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (plain(e) && e.key === 'Enter' && shown.length > 0 && (e.target === document.body || e.target === searchRef.current)) {
      e.preventDefault()
      void open(shown[0])
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function open(e: PaperEntry): Promise<void> {
    if (e.meta.has_pdf) {
      onOpen(e)
      return
    }
    setBusy(true)
    const done = onBusy(`Downloading ${e.meta.title}`)
    const r = await window.api.fetchPdfForStub(e.meta.id).finally(done)
    setBusy(false)
    if (r.ok) {
      await reload()
      onOpen(r.entry)
    } else notify(`${r.reason}. This paper is listed by title only.`)
  }

  async function onDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragging(false)
    for (const f of Array.from(e.dataTransfer.files)) {
      if (f.name.toLowerCase().endsWith('.pdf') || isHtmlFile(f.name)) await addFile(window.api.pathForFile(f))
    }
  }

  async function renamePaper(p: PaperEntry, short_name: string): Promise<void> {
    await window.api.updatePaper(p.meta.id, { short_name })
    await reload()
  }

  async function changeTags(p: PaperEntry, tags: string[]): Promise<void> {
    await window.api.updatePaper(p.meta.id, { tags })
    await reload()
  }

  return (
    <div
      className={`library ${dragging ? 'dragging' : ''}`}
      data-testid="library"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="lib-actions">
        <input ref={searchRef} className="search" title="Search (/ or Ctrl+F); Enter opens the first paper" placeholder="Search titles, tags and notes" value={query} data-testid="search" onChange={(e) => setQuery(e.target.value)} />
        <select value={statusFilter} data-testid="status-filter" onChange={(e) => setStatusFilter(e.target.value as ReadStatus | '')}>
          <option value="">All</option>
          <option value="unread">Unread</option>
          <option value="reading">Reading</option>
          <option value="read">Read</option>
        </select>
        <div className="spacer" style={{ flex: 1 }} />
        <input ref={addIdRef} className="add-id" placeholder="arXiv ID, arXiv link or DOI" value={idText} data-testid="add-id"
          onChange={(e) => setIdText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addById()} />
        <button onClick={() => void addById()} disabled={busy} data-testid="add-id-btn">Add</button>
        <button
          disabled={busy}
          onClick={() => void window.api.pickPdf().then((p) => (p ? addFile(p) : undefined))}
        >
          Add PDF or HTML report…
        </button>
      </div>
      {allTags.length > 0 && (
        <div className="tag-filter">
          {allTags.map((t) => (
            <button key={t} className={activeTags.includes(t) ? 'tag on' : 'tag'}
              onClick={() => setActiveTags((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]))}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="table-scroll">
        {papers.length === 0 ? (
          <div className="empty">Drop a PDF here, or paste an arXiv ID above.</div>
        ) : (
          <table className="papers">
            <thead>
              <tr>{header('name', 'Name')}{header('title', 'Title')}{header('authors', 'Authors')}{header('year', 'Year')}<th>Tags</th>{header('status', 'Status')}<th>Source</th>{header('added', 'Added')}<th /></tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.meta.id} className="row" data-testid="paper-row" onClick={() => void open(p)}>
                  <td className="name-cell" onClick={(e) => e.stopPropagation()}>
                    <input key={p.meta.short_name ?? ''} className="name-input" data-testid="name-input" placeholder="+ name"
                      title="What this paper is usually called, such as DreamerV3. Shown on maps and tabs instead of the title."
                      defaultValue={p.meta.short_name ?? ''}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = p.meta.short_name ?? ''; e.currentTarget.blur() } }}
                      onBlur={(e) => { const v = e.currentTarget.value.trim(); if (v !== (p.meta.short_name ?? '')) void renamePaper(p, v) }} />
                  </td>
                  <td className="title-cell">
                    {p.meta.title}
                    {!p.meta.has_pdf && <span className="stub-mark">no PDF</span>}
                  </td>
                  <td>{p.meta.authors.slice(0, 3).join(', ')}{p.meta.authors.length > 3 ? ' et al.' : ''}</td>
                  <td>{p.meta.year ?? ''}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="tags-cell">
                      {p.meta.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}{' '}
                          <a role="button" style={{ cursor: 'pointer' }} onClick={() => void changeTags(p, p.meta.tags.filter((x) => x !== t))}>×</a>
                        </span>
                      ))}
                      <TagInput have={p.meta.tags} all={allTags} onAdd={(t) => void changeTags(p, [...new Set([...p.meta.tags, t])])} />
                    </div>
                  </td>
                  <td>
                    <span className={`status-dot status-${p.meta.status}`} />
                    {p.meta.status}
                    {p.meta.read_on ? ` on ${p.meta.read_on}` : ''}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {p.meta.url ? (
                      <button className="source-link" data-testid="source-link" title={`${p.meta.url}\nAdded ${p.meta.added.slice(0, 10)}`}
                        onClick={() => void window.api.openExternal(p.meta.url)}>
                        {sourceLabel(p.meta.url, p.meta.doi)}
                      </button>
                    ) : (
                      <span className="hint">Local file</span>
                    )}
                  </td>
                  <td className="added-cell" data-testid="added-cell">{p.meta.added.slice(0, 10)}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
                    <button className="row-menu-btn" title="More" data-testid="row-menu" onClick={() => setMenuFor(menuFor === p.meta.id ? '' : p.meta.id)}>⋯</button>
                    {menuFor === p.meta.id && (
                      <div className="pop-menu">
                        <button data-testid="edit-details" onClick={() => editDetails(p)}>Edit details…</button>
                        <button className="danger" data-testid="delete-paper" onClick={() => void deletePaper(p)}>Delete paper…</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {titlePrompt && <DetailsDialog initial={titlePrompt} onSave={(f) => void confirmTitle(f)} onCancel={() => setTitlePrompt(null)} />}
    </div>
  )
}
