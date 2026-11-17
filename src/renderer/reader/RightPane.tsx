import { ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import { askConfirm } from '../confirm'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Annotations, MarginNote, PaperEntry, SideNote } from '../../shared/types'
import { targetLabel } from '../../shared/inkLogic'
import { MathText } from '../MathText'
import { matchSpans, parseTextLink } from '../../shared/textFind'

interface Props {
  entry: PaperEntry
  annotations: Annotations | null
  onJumpNote: (n: MarginNote) => void
  onJumpTarget: (targetId: string) => void
  /** A link in a side note: shows the note or mark in place and flashes it, selecting nothing. */
  onShowNote: (n: MarginNote) => void
  onShowMark: (targetId: string) => void
  /** Page counted from 0. */
  onJumpPage: (page: number) => void
  /** A link to words on a page (counted from 0): shows them and flashes them. */
  onJumpText: (page: number, quote: string) => void
  /** A web link in a side note was tapped; offers preview, add to map, or open. */
  onWebLink: (text: string, url: string, clientX: number, clientY: number) => void
  /** What Find looks for in side notes; its matches in the shown note are highlighted. */
  findQuery?: string
  /** The side note match Find went to: that note is shown, scrolled to the match, which stands out. */
  findFocus?: { path: string; occurrence: number; tick: number } | null
  /** Goes up by one for each Ctrl+N; each new value makes a side note. */
  newNoteTick?: number
}

const MARKS_TAB = '__marks__'

export function RightPane({ entry, annotations, onJumpNote, onJumpTarget, onShowNote, onShowMark, onJumpPage, onJumpText, onWebLink, findQuery = '', findFocus = null, newNoteTick = 0 }: Props) {
  const [notes, setNotes] = useState<SideNote[]>([])
  const [tab, setTab] = useState<string>(MARKS_TAB)
  useEffect(() => {
    if (findFocus) setTab(findFocus.path)
  }, [findFocus])
  const paperId = entry.meta.id
  const initialised = useRef(false)

  const reload = useCallback(async () => {
    const list = await window.api.listSideNotes(paperId)
    setNotes(list)
    return list
  }, [paperId])

  useEffect(() => {
    initialised.current = false
    void reload().then((list) => {
      if (initialised.current) return
      initialised.current = true
      const pinned = list.find((n) => n.pinned)
      setTab(pinned ? pinned.path : MARKS_TAB)
    })
  }, [reload])

  useEffect(() => {
    const folder = entry.folder.replace(/\\/g, '/')
    return window.api.onChange((e) => {
      if (e.kind === 'notes' && e.folder === folder) void reload()
    })
  }, [entry.folder, reload])

  async function addNote(): Promise<void> {
    const n = await window.api.createSideNote(paperId, { title: 'New note' })
    await reload()
    setTab(n.path)
  }

  // Ctrl+N in the reader. The first value is the starting count, not a press.
  const seenTick = useRef(newNoteTick)
  useEffect(() => {
    if (newNoteTick === seenTick.current) return
    seenTick.current = newNoteTick
    void addNote()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newNoteTick])

  const active = notes.find((n) => n.path === tab)

  return (
    <aside className="right-pane" data-testid="right-pane">
      <div className="tabs">
        <button className={tab === MARKS_TAB ? 'tab on' : 'tab'} onClick={() => setTab(MARKS_TAB)} data-testid="tab-marks">
          Margin notes
        </button>
        {notes.map((n) => (
          <button key={n.path} className={tab === n.path ? 'tab on' : 'tab'} onClick={() => setTab(n.path)} data-testid="tab-note" title={n.title}>
            {n.pinned ? '★ ' : ''}
            {n.generated_by ? '✦ ' : ''}
            {n.title}
          </button>
        ))}
        <button className="tab add" onClick={() => void addNote()} data-testid="add-note" title="New side note (Ctrl+N)">+</button>
      </div>
      {tab === MARKS_TAB || !active ? (
        <MarksList annotations={annotations} onJumpNote={onJumpNote} onJumpTarget={onJumpTarget} />
      ) : (
        <NoteEditor
          key={active.path}
          note={active}
          annotations={annotations}
          onJumpNote={onShowNote}
          onJumpTarget={onShowMark}
          onJumpPage={onJumpPage}
          onJumpText={onJumpText}
          onWebLink={onWebLink}
          findQuery={findQuery}
          findCurrent={findFocus?.path === active.path ? findFocus.occurrence : -1}
          findTick={findFocus?.tick ?? 0}
          onChanged={() => void reload()}
          onDeleted={() => {
            setTab(MARKS_TAB)
            void reload()
          }}
        />
      )}
    </aside>
  )
}

function MarksList({
  annotations,
  onJumpNote,
  onJumpTarget
}: {
  annotations: Annotations | null
  onJumpNote: (n: MarginNote) => void
  onJumpTarget: (id: string) => void
}) {
  const [onlyNoTarget, setOnlyNoTarget] = useState(false)
  const notes = useMemo(
    () => [...(annotations?.marginNotes ?? [])].sort((a, b) => a.page - b.page || a.box[1] - b.box[1]),
    [annotations]
  )
  const lacksTarget = (n: MarginNote) => n.kind !== 'drawing' && n.targetIds.length === 0
  const noTargetCount = notes.filter(lacksTarget).length
  const shown = onlyNoTarget ? notes.filter(lacksTarget) : notes
  const byPage: [number, MarginNote[]][] = []
  for (const n of shown) {
    const last = byPage[byPage.length - 1]
    if (last && last[0] === n.page) last[1].push(n)
    else byPage.push([n.page, [n]])
  }
  const targets = annotations?.targets ?? []
  const quote = (id: string): string => {
    const t = targets.find((x) => x.id === id)
    if (!t) return ''
    return targetLabel(t, true)
  }
  const renderNote = (n: MarginNote) => (
    <li key={n.id} className="mark-item" data-testid="mark-item">
      <button className="link-row" onClick={() => onJumpNote(n)}>
        {lacksTarget(n) && <span className="note-badge attention" data-testid="no-target-badge">no target</span>}
        <span className="mark-text">{n.kind === 'drawing' ? '(drawing)' : n.text || '(not recognized)'}</span>
      </button>
      {n.targetIds.map((id) => (
        <button key={id} className="quote-row" onClick={() => onJumpTarget(id)}><MathText text={quote(id)} /></button>
      ))}
    </li>
  )
  return (
    <div className="marks">
      <div className="mark-filter">
        <button className={onlyNoTarget ? '' : 'on'} data-testid="filter-all" onClick={() => setOnlyNoTarget(false)}>
          All ({notes.length})
        </button>
        <button className={onlyNoTarget ? 'on' : ''} data-testid="filter-no-target" onClick={() => setOnlyNoTarget(true)}>
          No target ({noTargetCount})
        </button>
      </div>
      {notes.length === 0 ? (
        <p className="hint">Write in the margin with the pen. Notes appear here.</p>
      ) : shown.length === 0 ? (
        <p className="hint">Every note has a target.</p>
      ) : (
        byPage.map(([page, list]) => (
          <section key={page} data-testid="notes-page">
            <h4>Page {page + 1}</h4>
            <ul>{list.map(renderNote)}</ul>
          </section>
        ))
      )}
    </div>
  )
}

/** Links an agent can write in a side note, explained in the library's AGENTS.md. */
function noteUrl(url: string): string {
  return /^(note|mark|page|text):/i.test(url) ? url : defaultUrlTransform(url)
}

/** The visible text of a link, for looking the paper up. */
function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (node && typeof node === 'object' && 'props' in node) return plainText((node.props as { children?: ReactNode }).children)
  return ''
}

interface LinkProps {
  annotations: Annotations | null
  onJumpNote: (n: MarginNote) => void
  onJumpTarget: (id: string) => void
  onJumpPage: (page: number) => void
  onJumpText: (page: number, quote: string) => void
  onWebLink: (text: string, url: string, clientX: number, clientY: number) => void
}

function NoteLink({ href = '', children, ...p }: LinkProps & { href?: string; children?: ReactNode }) {
  // Words on a page: text:<page from 1>:<quote>.
  if (/^text:/i.test(href)) {
    const t = parseTextLink(href)
    if (!t) return <span className="note-link broken" data-testid="note-link-broken" title="Nothing to go to: the link needs a page and the words to find, as text:4:Training objective">{children}</span>
    return (
      <a href={href} className="note-link text" data-testid="note-link-text" title={`Go to “${t.quote}” on p. ${t.page}`}
        onClick={(e) => { e.preventDefault(); p.onJumpText(t.page - 1, t.quote) }}>{children}</a>
    )
  }
  const m = /^(note|mark|page):(.+)$/i.exec(href)
  if (m) {
    const kind = m[1].toLowerCase()
    const id = m[2].trim()
    const note = kind === 'note' ? p.annotations?.marginNotes.find((n) => n.id === id) : undefined
    const mark = kind === 'mark' ? p.annotations?.targets.find((t) => t.id === id) : undefined
    const page = kind === 'page' ? Number.parseInt(id, 10) : NaN
    const found = note || mark || (kind === 'page' && page >= 1)
    if (!found) {
      return <span className="note-link broken" data-testid="note-link-broken" title={`Nothing to go to: ${kind} ${id} is not in this paper`}>{children}</span>
    }
    const title = note ? `Go to your note on p. ${note.page + 1}: ${note.text}` : mark ? `Go to the mark: ${targetLabel(mark, true)}` : `Go to page ${page}`
    return (
      <a href={href} className={`note-link ${kind}`} data-testid={`note-link-${kind}`} title={title}
        onClick={(e) => {
          e.preventDefault()
          if (note) p.onJumpNote(note)
          else if (mark) p.onJumpTarget(mark.id)
          else p.onJumpPage(page - 1)
        }}>{children}</a>
    )
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} data-testid="note-link-web" title={href}
        onClick={(e) => { e.preventDefault(); p.onWebLink(plainText(children), href, e.clientX, e.clientY) }}>{children}</a>
    )
  }
  return <a href={href}>{children}</a>
}

/**
 * Highlights the matches of `query` in a shown note, the current one more strongly, and scrolls
 * the pane to the current one. Uses the CSS highlight API, so React's rendering is left alone.
 */
function useFindHighlight(root: RefObject<HTMLElement | null>, query: string, current: number, tick: number, deps: unknown[]): void {
  useEffect(() => {
    const el = root.current
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const clear = () => { reg?.delete('side-find'); reg?.delete('side-find-current') }
    if (!el || !query) { clear(); if (el) { delete el.dataset.findCount; delete el.dataset.findCurrent } return clear }
    // The note's title and text, without KaTeX's hidden copy of each formula.
    const nodes: Text[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement
        if (!p || p.closest('.katex-mathml, .note-actions, button, textarea, input')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    const ranges = matchSpans(nodes.map((n) => n.data), query).map((s) => {
      const r = document.createRange()
      r.setStart(nodes[s.from[0]], s.from[1])
      r.setEnd(nodes[s.to[0]], s.to[1])
      return r
    })
    el.dataset.findCount = String(ranges.length)
    // Counted from the note's Markdown, the match may be one the page shows differently: then the last.
    const at = current < 0 || ranges.length === 0 ? -1 : Math.min(current, ranges.length - 1)
    el.dataset.findCurrent = String(at)
    const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (reg && H) {
      reg.set('side-find', new H(...ranges.filter((_, i) => i !== at)))
      if (at >= 0) reg.set('side-find-current', new H(ranges[at]))
      else reg.delete('side-find-current')
    }
    if (at >= 0) {
      // Into the middle of the nearest scrolling area round the match, which may lie inside the note.
      let box: HTMLElement | null = ranges[at].startContainer.parentElement
      while (box && !(box.scrollHeight > box.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement
      const r = ranges[at].getBoundingClientRect()
      if (box) {
        const b = box.getBoundingClientRect()
        box.scrollTop += r.top + r.height / 2 - (b.top + b.height / 2)
      }
    }
    return clear
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, current, tick, ...deps])
}

function NoteEditor({ note, onChanged, onDeleted, findQuery, findCurrent, findTick, ...links }: {
  note: SideNote; onChanged: () => void; onDeleted: () => void; findQuery: string; findCurrent: number; findTick: number
} & LinkProps) {
  const components = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: ReactNode }) => <NoteLink href={href} {...links}>{children}</NoteLink>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [links.annotations, links.onJumpNote, links.onJumpTarget, links.onJumpPage, links.onWebLink])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [title, setTitle] = useState(note.title)
  const dirty = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useFindHighlight(rootRef, editing ? '' : findQuery, findCurrent, findTick, [draft, title, editing, note.title])

  // A file changed from outside (by Claude Code, say) shows up unless it is being edited here.
  useEffect(() => {
    if (!dirty.current) {
      setDraft(note.body)
      setTitle(note.title)
    }
  }, [note.body, note.title])

  async function save(patch: Partial<SideNote> = {}): Promise<void> {
    dirty.current = false
    await window.api.saveSideNote({ ...note, body: draft, title, ...patch })
    onChanged()
  }

  function finish(): void {
    setEditing(false)
    void save()
  }

  return (
    <div className="note-editor" ref={rootRef} data-testid="note-editor">
      <div className="note-head">
        {editing ? (
          <input className="title-input" value={title} data-testid="note-title" title="Enter saves"
            onChange={(e) => { dirty.current = true; setTitle(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); finish() } }} />
        ) : (
          <h3>{note.title}</h3>
        )}
        <div className="note-actions">
          <button onClick={() => void save({ pinned: !note.pinned })}>{note.pinned ? 'Unpin' : 'Pin'}</button>
          {editing ? (
            <button data-testid="note-done" title="Enter in the title, or Ctrl+Enter in the text" onClick={finish}>Done</button>
          ) : (
            <button data-testid="note-edit" onClick={() => setEditing(true)}>Edit</button>
          )}
          <button className="danger" data-testid="note-file-delete" onClick={() => void (async () => {
            const ok = await askConfirm({
              title: `Delete "${note.title}"?`,
              body: 'The note file goes to the Recycle Bin, where it can be restored.',
              action: 'Delete side note'
            })
            if (ok) await window.api.deleteSideNote(note.path).then(onDeleted)
          })()}>Delete…</button>
        </div>
      </div>
      {note.generated_by && <div className="generated">Generated by {note.generated_by}</div>}
      {editing ? (
        <textarea className="note-text-input" value={draft} data-testid="note-body"
          onChange={(e) => { dirty.current = true; setDraft(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish() } }} />
      ) : (
        <div className="markdown" data-testid="note-rendered">
          <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={noteUrl} components={components}>{draft}</Markdown>
        </div>
      )}
    </div>
  )
}
