import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { exists, writeAtomic } from './storage/atomic'

/** The first line of every guide file the app writes. Without it, the file is the reader's own. */
export const GUIDE_MARKER =
  '<!-- Written by Paper Reader, which replaces this file when it changes. Delete this line to keep your own version. -->'

/**
 * Instructions for coding agents (Claude Code and others) working in the library folder:
 * where things are, and how to write side notes the app understands.
 */
export const AGENT_GUIDE = `${GUIDE_MARKER}
# Working with this Paper Library

This folder is the library of the Paper Reader app. The reader reads papers with a pen; you can read
their notes and write side notes that the app shows next to the paper.

## Where things are

Each paper is a folder: \`papers/<id>--<title>/\`.

| File | Contents |
|---|---|
| \`paper.pdf\` | The paper. Never modify it. |
| \`paper.md\` | Metadata and tags, in the frontmatter. \`short_name\` is what the paper is usually called (such as DreamerV3), shown instead of its title; refer to papers by it when it is set |
| \`people/<author-id>/annotations.json\` | Marks (\`targets\`) and handwritten margin notes (\`marginNotes\`) with their text |
| \`people/<author-id>/ink.json\` | Raw pen strokes. Rarely needed, and never edit it. |
| \`people/<author-id>/regions/*.png\` | Pictures of figures, tables and equations the reader marked |
| \`people/<author-id>/notes/*.md\` | Side notes, shown in the app's right pane |

Do not edit \`annotations.json\` or \`ink.json\`: the app owns them.

## Reading the notes

- \`marginNotes[].id\` identifies a handwritten note, \`page\` is its page counted from 0, and \`text\` is the handwriting as text.
- \`kind\` is \`note\`, \`question\` or \`drawing\`.
- \`marginNotes[].targetIds\` points to entries in \`targets\`. A text target has \`quote.exact\`, and a region target has \`image\`.
- \`corrected: false\` means the text came straight from handwriting recognition and may contain mistakes. \`candidates\` holds the alternatives for each word, and \`alternatives\` holds what other languages' recognizers read. If the text looks wrong, check \`alternatives\` before guessing.

### When a note has no target

If \`targetIds\` is empty, the note says nothing about what it refers to. **Do not guess from position or page. Ask the reader what it refers to.**

## Writing a side note

Create a Markdown file in \`people/<author-id>/notes/\`. It appears in the app without a restart.

\`\`\`markdown
---
id: n-summary-1
author: <author-id>
generated_by: claude
kind: summary
title: Summary
targets: []
---

Text, with $math$ if needed.
\`\`\`

## Links in side notes (required)

The reader taps these links in the app, so **whenever a side note quotes, answers or refers to one of
the reader's handwritten notes, link to it**. The same goes for marks and pages.

| Link | Tapping it | Example |
|---|---|---|
| \`[text](note:<marginNotes[].id>)\` | Scrolls to that handwritten note and selects it | \`[p. 9, “Why?”](note:m_mwcd6elsyc6grn82)\` |
| \`[text](mark:<targets[].id>)\` | Scrolls to that underline, circle or region and flashes it | \`[the circled sentence](mark:t_mwcd5k2a1b2c3d4e)\` |
| \`[text](page:<n>)\` | Scrolls to page n, **counted from 1** as the app shows it | \`[p. 9](page:9)\` |
| \`[text](<text:N:words>)\` | Scrolls to those words on page N (counted from 1) and flashes them; if they are not there, the page top | \`[Eq. 3](<text:4:Training objective>)\` |
| \`[text](https://…)\` | Opens a menu: preview the paper, add it to a reading map as a suggestion, or open the link | \`[MuZero (Schrittwieser et al., 2019)](https://arxiv.org/abs/1911.08265)\` |

- For a paper, link straight to its PDF or its arXiv page (\`https://arxiv.org/abs/…\`), so the app can open it, and put the year in the link text, such as "(Hafner et al., 2023)": the app uses the year to place the paper before or after this one on a reading map.
- To point at a page of another paper, add \`#page=N\` to the address (N counted from 1), such as \`[World Models, p. 10](https://arxiv.org/abs/1803.10122#page=10)\`. The app opens that paper at that page, from the library when it is there.
- To point at an equation, a figure, a table or a sentence, use a \`text:\` link rather than \`page:\`: copy a few distinctive words (4–8) exactly from the paper's text on that page, such as the sentence just before an equation or the start of a caption (\`<text:5:Figure 2: Latent dynamics>\`). Case, spacing, punctuation and hyphenation at line ends do not matter, but the words must be the PDF's own, not a paraphrase or LaTeX. Keep the angle brackets: without them a link with spaces is not a link. Leave out \`(\`, \`)\`, \`<\` and \`>\` from the words.
- Copy ids exactly from \`annotations.json\`; never invent one. A link to an id that does not exist shows as broken.
- \`page\` in \`annotations.json\` counts from 0, so the page to show the reader is \`page + 1\`.
- For a list of the reader's questions with answers, start each item with a link to the question:

\`\`\`markdown
### [p. 9: “Why do they train the controller in the dream?”](note:m_mwcd6elsyc6grn82)
Because…
\`\`\`

- For papers, write the link text as \`Title or short name (Authors, Year)\` and link to arXiv (\`https://arxiv.org/abs/<id>\`) or the DOI (\`https://doi.org/<doi>\`) when there is one. The preview finds the paper from the arXiv id or DOI in the link, and otherwise from the link text.

## Reading maps

A map is \`maps/<name>.json\`. Papers not yet in the library only need their full \`title\`. Put what people call a paper (such as Transformer) in \`short_name\`, never in \`title\`: the box shows it, and it becomes the paper's short name when the paper is added to the library.

\`\`\`json
{
  "name": "My map",
  "nodes": [{ "paperId": "arxiv:1706.03762", "title": "Attention Is All You Need", "short_name": "Transformer", "group": "g1" }],
  "groups": [{ "id": "g1", "title": "Foundations", "collapsed": false }],
  "edges": [{ "from": "arxiv:1706.03762", "to": "arxiv:2006.11239", "status": "confirmed" }]
}
\`\`\`

An arrow means "read \`from\` before \`to\`". Loops are not allowed.
`

/** Claude Code reads CLAUDE.md, which only pulls in the shared guide. */
export const CLAUDE_POINTER = `${GUIDE_MARKER}
@AGENTS.md
`

/**
 * Puts the guide in the library root. A file the reader made or changed (no marker on its first
 * line) is never touched.
 */
export async function writeAgentGuide(root: string): Promise<void> {
  for (const [name, text] of [['AGENTS.md', AGENT_GUIDE], ['CLAUDE.md', CLAUDE_POINTER]] as const) {
    const path = join(root, name)
    if (await exists(path)) {
      const current = (await fs.readFile(path, 'utf8')).replace(/\r\n/g, '\n')
      if (!current.startsWith(GUIDE_MARKER) || current === text) continue
    }
    await writeAtomic(path, text)
  }
}
