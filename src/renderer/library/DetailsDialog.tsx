import { useRef, useState } from 'react'
import type { PdfHints } from '../../shared/api'
import type { PaperMeta } from '../../shared/types'
import { parseAuthors, parseYear } from '../../shared/pdfDetails'

/** The details box: checking a PDF no lookup found before adding it, or editing a paper's details. */
export interface DetailsForm {
  mode: 'add' | 'edit'
  /** For adding: the PDF and what was read from it. */
  path?: string
  hints?: PdfHints
  /** For editing: the paper. */
  id?: string
  title: string
  short_name: string
  authors: string
  year: string
  url: string
}

/** The box filled in with a paper's current details, for editing. */
export function detailsFor(meta: PaperMeta): DetailsForm {
  return {
    mode: 'edit', id: meta.id, title: meta.title, short_name: meta.short_name ?? '',
    authors: meta.authors.join(', '), year: meta.year ? String(meta.year) : '', url: meta.url
  }
}

/** What to save for a filled-in box. */
export function patchFrom(f: DetailsForm): Pick<PaperMeta, 'title' | 'short_name' | 'authors' | 'year' | 'url'> {
  return { title: f.title.trim(), short_name: f.short_name.trim(), authors: parseAuthors(f.authors), year: parseYear(f.year), url: f.url.trim() }
}

const FIELDS = [
  ['title', 'Title', 'title-input', ''],
  ['short_name', 'Short name', 'short-name-input', 'What people call it, such as DreamerV3 (optional)'],
  ['authors', 'Authors', 'authors-input', 'Separated by commas'],
  ['year', 'Year', 'year-input', 'Such as 2015'],
  ['url', 'Link', 'url-input', 'Where the PDF came from (optional)']
] as const

export function DetailsDialog({ initial, onSave, onCancel }: { initial: DetailsForm; onSave: (f: DetailsForm) => void; onCancel: () => void }) {
  const [form, setForm] = useState(initial)
  const [titleMissing, setTitleMissing] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const save = () => {
    if (!form.title.trim()) {
      setTitleMissing(true)
      titleRef.current?.focus()
      return
    }
    onSave(form)
  }
  return (
    <div className="modal-back">
      <div className="modal" data-testid="title-prompt">
        <h3>{form.mode === 'add' ? 'What is this paper?' : 'Paper details'}</h3>
        {form.mode === 'add' && <p className="hint">No details were found online. Check these, read from the PDF, and fill in what is missing.</p>}
        {FIELDS.map(([key, label, testId, placeholder]) => (
          <label key={key} className="details-field">
            {label}
            <input ref={key === 'title' ? titleRef : undefined} value={form[key]} data-testid={testId} placeholder={placeholder}
              autoFocus={key === (form.mode === 'edit' ? 'short_name' : 'title')} inputMode={key === 'year' ? 'numeric' : undefined}
              onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, [key]: v })); if (key === 'title') setTitleMissing(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); save() }
                else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
              }} />
          </label>
        ))}
        {titleMissing && <div className="warn-banner" data-testid="title-missing">Type a title first.</div>}
        <div className="row">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" data-testid="title-save" onClick={save}>{form.mode === 'add' ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
