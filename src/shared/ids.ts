export function newId(prefix: string): string {
  const r = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${r}`
}

/** Removes the version suffix: 2410.24034v2 -> 2410.24034. */
export function stripArxivVersion(id: string): string {
  return id.replace(/v\d+$/i, '')
}

const NEW_ARXIV = /(?<![\d.])(\d{4}\.\d{4,5})(v\d+)?(?![\d])/
const OLD_ARXIV = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/
const DOI = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+[A-Za-z0-9)])/

/** Finds an arXiv ID in free text, only when the text says it is one or it is a bare ID. */
export function findArxivId(text: string): string {
  const marked =
    /arxiv(?:\.org\/(?:abs|pdf|html)\/|[:\s]+(?:preprint\s+)?(?:arxiv:)?)\s*([^\s,;)\]]+)/i.exec(text)
  if (marked) {
    const candidate = marked[1].replace(/\.pdf$/i, '').replace(/\.$/, '')
    const m = NEW_ARXIV.exec(candidate) ?? OLD_ARXIV.exec(candidate)
    if (m) return stripArxivVersion(m[1])
  }
  const bare = /^\s*(\d{4}\.\d{4,5})(v\d+)?\s*$/.exec(text)
  return bare ? bare[1] : ''
}

export function findDoi(text: string): string {
  const m = DOI.exec(text)
  return m ? m[1].replace(/[.,;]+$/, '') : ''
}

export function paperIdFor(arxiv: string, doi: string, localHash = ''): string {
  if (arxiv) return `arxiv:${arxiv}`
  if (doi) return `doi:${doi.toLowerCase()}`
  return `local:${localHash}`
}

/** A safe single path component made from anything. */
export function safeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'x'
}

export function slugifyTitle(title: string, max = 60): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= max) return slug || 'untitled'
  const cut = slug.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '')
}

export function folderNameFor(paperId: string, title: string): string {
  const idPart = safeSegment(paperId.replace(':', '-').replace(/\//g, '-')).slice(0, 60)
  return `${idPart}--${slugifyTitle(title)}`
}
