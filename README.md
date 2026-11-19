<img src="resources/obelus-icon.svg" alt="Obelus logo" width="96" align="right">

# Obelus

*Formerly the working title "Paper Reader".* An obelus is the mark ancient editors put beside a passage to say "look again". The app's underline works the same way.

A pen-first reader for research papers, for tablets and 2-in-1 laptops running Windows or Linux.

https://github.com/user-attachments/assets/f3120f36-1567-4658-9d77-3fa9004a6ce5

*A 90-second demo.*

Write in the margins as you would on paper. Your handwriting stays as ink and is turned into text in the background. Underline or circle what a note is about, and the note is linked to those exact words, equation or figure. Everything is saved as plain files in a folder you choose: PDFs, ink, notes in Markdown and reading maps in JSON. Other tools, and AI agents such as Claude Code, can read and write them too.

> **Status:** a working personal tool, used daily, but young. It runs on **Windows and Linux**, but handwriting becomes text **on Windows only** for now, because recognition uses the Windows Ink recognizers built into Windows. On Linux your ink is kept as drawn. Expect rough edges.

## What it does

**Reading and writing**
- Write anywhere on the page or in the wide margins beside it. The ink appears as you write, at any zoom up to 600%, and stays sharp.
- Notes are recognized in any handwriting language installed in Windows. In **Settings** you can pick only the ones you write in (for example Polish and English); each note keeps the best reading, and the other readings are one tap away.
- Words written next to each other become one note; a new line under a note continues it. A "?" or "!" at the end of a line is read from the ink itself, which the built-in recognizers often miss.
- Tap a note to edit its text, link it, move it with its grip, or resize it, ink and all, by its corners.
- Three pen sizes, an eraser, undo and redo, and **Select ink** to loop round any ink and move, resize or delete it.
- **Typed text** shows the recognized text next to each note.

**Marks and links**
- Underline or circle words with the pen: the mark snaps to the words. A note written right after it is linked to it, with a dashed line showing the link.
- Circle a displayed equation to mark the whole equation, or use the **Region** tool for a figure or table. A picture of the region is saved next to your notes.
- Link a note to any mark later, or to a whole page or paper.

**Papers and references**
- Add papers by arXiv ID, DOI or PDF file. Titles, authors and years are looked up on arXiv and Semantic Scholar.
- Tap a citation such as `[12]` to preview the cited paper without leaving the one you are reading, add it to your library, or jump to it in the reference list. Links inside the paper (equations, figures, sections) are followed with a way back.
- **Find** searches the paper text, your margin notes and your side notes.

**Side notes and maps**
- Each paper has a notes pane with **side notes**: Markdown with maths, written by you or by an AI agent. They can link to your notes, your marks, a page, words on a page (`[Eq. 3](<text:4:Training objective>)`), or another paper at a page. Long equations wrap onto new lines, or scroll sideways if you prefer (**Settings**).
- **Maps** lay out papers as boxes with arrows between them, in groups, with read and unread shown at a glance.

**Pen, finger and mouse**
- With an active pen, the pen writes and a finger scrolls and zooms. A resting palm is ignored.
- Without one, set **Settings → Writing with** to a finger, the mouse or a simple stylus: one finger writes, two fingers scroll and zoom.
- **Lock scrollbar** hides the scrollbar, so a hand resting on the screen edge can't jump pages.
- Every action works with pen and finger alone; keyboard shortcuts are extras.

## Install

Download the installer from the [latest release](https://github.com/Pawcharz/paper-reader/releases/latest):

- **Windows 10 or 11:** `Obelus-Setup-<version>.exe`. It is not signed, so Windows SmartScreen warns once: choose **More info**, then **Run anyway**.
- **Linux (x64):** `Obelus-<version>-x86_64.AppImage`. Make it executable (`chmod +x Obelus-*.AppImage`) and run it.

For handwriting to become text on Windows, install at least one handwriting language: Windows → Settings → Time & language → Language & region → your language → Language options → install **Handwriting**. Without one, ink is still saved but not turned into text.

A pen is not required, but the app is designed for one. On Linux, a pen works in an X11 session; under Wayland some Electron apps ignore pen input.

### Build from source

You need **[Node.js](https://nodejs.org/)** with npm (developed with Node.js 26) and **Git**.

```
git clone https://github.com/Pawcharz/paper-reader.git
cd paper-reader
npm ci
start.cmd        on Windows
./start.sh       on Linux
```

`npm ci` downloads the dependencies, including Electron (a few hundred MB). The start script builds the app and starts it. `npm run dist` builds an installer for the system you are on, into `dist/`.

## Getting started

On first start, the app asks where to keep your library. It suggests `OneDrive\Paper Library`, but any folder works. Then add a paper with **Add** in the Library: paste an arXiv ID such as `1706.03762`, a DOI, or choose a PDF.

To work on the code with hot reload instead, run `npm run dev`.

## Your library is plain files

```
Paper Library/
  AGENTS.md, CLAUDE.md        a guide for AI agents, written by the app
  workspace.json
  maps/<map>.json             reading maps
  papers/<paper-id>/
    paper.pdf
    paper.md                  title, authors, year, tags, status
    people/<your id>/
      ink.json                every pen stroke
      annotations.json        notes (with their recognized text), marks and links
      notes/*.md              side notes
      regions/*.png           pictures of marked figures and equations
```

Each person who opens a shared library writes only into their own `people/` folder, so a library can be shared through OneDrive or similar. Settings are kept in `%APPDATA%\paper-reader` (on Linux `~/.config/paper-reader`), and previews of cited papers in `%LOCALAPPDATA%\PaperReader\previews`, which are cleaned up automatically.

### Working with AI agents

When a library is opened, the app writes `AGENTS.md` (and a `CLAUDE.md` that points to it) at its root. It explains the file formats, how to read your notes, how to write side notes, and which links the app understands. Open the library folder in Claude Code or another agent and ask it, for example, to answer the questions in your margin notes: its answers appear as a side note, linked to the notes and marks they answer. A guide you edit by hand is left alone once you remove its first line.

## Privacy

Everything stays on your computer, apart from looking up papers:
- Adding a paper or previewing a citation asks **arXiv**, **Semantic Scholar** and **doi.org** about it, and downloads its open PDF.
- **Search the web** (offered when nothing is found) opens Google in your browser; the address can be changed in Settings.
- Handwriting is recognized locally by Windows.
- The app has an optional **usage log** (the record button in the side rail, off by default) that writes what you do to local files, for finding bugs. It is never sent anywhere.

## Keyboard shortcuts

| Where | Shortcut | Does |
|---|---|---|
| Anywhere | Ctrl+W / Ctrl+Shift+T | Close the paper tab / reopen the last closed one |
| | Ctrl+Tab, Ctrl+1, Ctrl+2 | Next tab, Library, Maps |
| Reader | P / R / E / S | Pen, Region, Eraser, Select ink |
| | T / L | Typed text / links between notes and marks, on or off |
| | Ctrl+= / Ctrl+− / Ctrl+0 | Zoom in, out, fit |
| | → ← PageDown PageUp Home End | Move through pages |
| | Ctrl+F, F3 / Shift+F3 | Find, next / previous match |
| | Ctrl+Z / Ctrl+Y | Undo / redo |
| | Delete | Delete the selected note, mark or ink |
| | Ctrl+E / Ctrl+K / Ctrl+N | Edit the note's text / link it / new side note |
| | Esc | Close Find, clear a selection, cancel linking |
| Maps | S, G, Delete | Select mode, name a group, remove from the map |
| Library | / | Search |

## Development

```
npm run dev          the app with hot reload
npm test             unit tests (Vitest)
npm run test:e2e     builds the app and drives it with Playwright, using simulated pen events and a fake network
npm run typecheck    TypeScript
npm run dist         an installer for this system, into dist/
```

GitHub Actions runs the checks and builds both installers on every push. Pushing a version tag (`v0.2.0`) builds them onto a draft release, which is published by hand.

The code is TypeScript, with Electron, React and PDF.js:

| Folder | What is in it |
|---|---|
| `src/main` | The Electron main process: library storage, paper lookups, the handwriting engine, settings |
| `src/main/recognition` | Handwriting recognition. `resources/ink-sidecar.ps1` talks to Windows Ink. Other engines can implement `RecognitionEngine` in `engine.ts`. |
| `src/renderer` | The interface: library, reader, notes pane, maps |
| `src/shared` | Logic shared by both, most of it pure and unit tested: telling writing from underlines and circles, grouping strokes into notes, splitting lines, maths from PDF text |
| `tests/unit`, `tests/e2e` | Unit and end-to-end tests |

`npx vitest run --config vitest.real.config.ts` runs extra checks against real PDFs (`REAL_PDF_DIR`) and the live lookup services (`REAL_NET=1`). A few unit tests use handwriting samples that are not part of this repository; they skip themselves.

## Known limits

- Handwriting recognition on Windows only, as it comes from Windows. A local recognizer for Linux is planned.
- No macOS build.
- The installers are not signed.
- Handwritten maths is read as text, often poorly.
- Tested mostly on one pen tablet, by one person.

## License

[MIT](LICENSE)
