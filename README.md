<p align="center">
  <img src="resources/obelus-icon.svg" alt="Obelus logo" width="110">
</p>

<h1 align="center">Obelus</h1>

<p align="center">
  <b>Read research papers the way you read on paper: write in the margins.</b><br>
  Your notes stay linked to the exact sentence, equation or figure they are about,<br>
  and everything is kept as plain files that you, your tools and AI agents can read.
</p>

<p align="center">
  <a href="https://github.com/Pawcharz/obelus-paper-reader/releases/latest"><img alt="Download for Windows and Linux" src="https://img.shields.io/github/v/release/Pawcharz/obelus-paper-reader?label=Download&style=for-the-badge&color=FF7A2F"></a>
  &nbsp;
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1B2440?style=for-the-badge"></a>
  &nbsp;
  <img alt="Windows and Linux" src="https://img.shields.io/badge/Windows%20%C2%B7%20Linux-1B2440?style=for-the-badge">
</p>

<p align="center">
  <a href="https://github.com/Pawcharz/obelus-paper-reader/releases/latest"><b>⬇ Download the latest version</b></a>
  &nbsp;·&nbsp; <a href="#install-in-two-minutes">How to install</a>
  &nbsp;·&nbsp; <a href="https://github.com/Pawcharz/obelus-paper-reader/discussions">Say what you think</a>
</p>

https://github.com/user-attachments/assets/2dd16f64-3886-4478-8a1e-a4566ecec201

<p align="center"><i>Two minutes: reading with a pen first, then with a mouse and keyboard.</i></p>

---

## Why I made it

When I read a paper on paper, I underline a line, write *"why?"* next to it, and move on. In a PDF reader, notes go into separate comment boxes, or into a notebook that knows nothing about where they came from. Obelus keeps the first habit and fixes the second: **you write where you are reading, and the note knows what it is about.**

An obelus (÷) is the mark ancient editors put beside a passage to say *"look at this again"*. That is what the app is for.

## What it feels like

**✍️ Write in the margins, with a pen or a keyboard.**
On a tablet, write anywhere around the page; your handwriting stays as ink and becomes text in the background (on Windows with Windows Ink, in any language you install, Polish included; on Linux with a model that runs on your computer). Maths written inside a note is found by itself and turned into LaTeX by a small model that also runs on your computer (Windows). On a laptop or desktop, **PC mode** lets you select a sentence, press `N` and type: the note appears in the margin next to it.

**🔗 Notes point at exactly what they mean.**
Underline or circle a sentence, an equation or a figure (or select it with the mouse), and the note you write next is linked to it, with a dashed line you can always follow back. Displayed equations become one box, with the maths kept as LaTeX.

**📚 Citations without losing your place.**
Tap `[12]` to preview the cited paper right away, add it to your library, or drop it on a reading map. Links to equations and figures inside the paper take you there and back.

**🗺️ Reading maps.** Lay papers out as boxes with arrows between them, in groups, with read and unread at a glance.

**📄 Not only PDFs.** Add an HTML report and it becomes a PDF you can write on, with its tabs, scroll boxes and folded parts opened out. Closing the app keeps your place: the papers you had open come back, each at the page where you left it.

**🤖 Works with AI agents.** Your library is a folder of plain files: PDFs, notes as JSON and Markdown, maps as JSON. The app writes a guide for agents into it, so you can open the folder in Claude Code and ask, *"answer the questions in my margin notes"*. The answers appear as a side note in the app, linked to the very notes and equations they answer.

**🔒 Yours.** No cloud, no tracking, and no account needed. Signing in with Google is optional: it only lets all your computers show the same notes when the library folder is synced (OneDrive or similar). Paper details are looked up on arXiv and Semantic Scholar, and the reading models are downloaded only when you say so; nothing else leaves your computer.

## Install in two minutes

1. Open the **[latest release](https://github.com/Pawcharz/obelus-paper-reader/releases/latest)** and download the file for your system:

   | System | File | Then |
   |---|---|---|
   | **Windows 10 / 11** | `Obelus-Setup-<version>.exe` | Run it. The installer isn't signed (signing costs money), so Windows shows a blue SmartScreen box once: click **More info** → **Run anyway**. |
   | **Linux** (x64) | `Obelus-<version>-x86_64.AppImage` | `chmod +x Obelus-*.AppImage`, then run it. |

2. On first start, choose a folder for your library (any folder; a OneDrive one syncs between computers).
3. Click **Add** and paste an arXiv ID, such as `1706.03762`, or a DOI, or pick a PDF. Open it and start reading.

**Pen or mouse?** The app picks by itself: **Pen mode** on a touchscreen, **PC mode** on a computer without one. Switch any time with the button at the bottom of the left rail.

**For handwriting on Windows**, make sure a handwriting language is installed: *Settings → Time & language → Language & region → your language → Language options → Handwriting*. Without one, your ink is still saved, just not turned into text.

**Models that run on your computer.** Two readers are too big for the installer, so the app offers to download them the first time a note needs one: on Windows, the maths reader (2.7 GB); on Linux, the handwriting reader (3.4 GB). Choose **Not now** and your ink stays as ink (on Windows, the maths is left as Windows Ink read it). You can download, cancel, resume or remove them later in **Settings → Reading on this computer**, where you can also stop the app from looking for maths at all. They run on the processor, need no graphics card, and stop after 15 minutes without use to free the memory.

> **Early days.** Obelus is young: I use it every day, but it has been tested mostly on one tablet, by one person. If something breaks or feels clumsy, please [open an issue](https://github.com/Pawcharz/obelus-paper-reader/issues/new/choose) or [start a discussion](https://github.com/Pawcharz/obelus-paper-reader/discussions). Every report helps.

## A closer look

<details>
<summary><b>Pen mode</b>: writing, marking, linking</summary>

- Write anywhere on the page or in the wide margins beside it. Ink keeps up with the pen at any zoom up to 600%.
- Words written next to each other become one note; a new line under a note continues it. A "?" or "!" at the end of a line is read from the ink itself.
- Pick only the languages you write in (**Settings**, e.g. Polish and English); each note keeps the best reading, and the others are one tap away.
- Underline or circle text: the mark snaps to the words. Circle a displayed equation to mark it whole, or use **Region** for a figure or table; a picture of it is saved with your notes.
- Tap a note to edit its text, link it, move it, or resize it by its corners. **Select ink** loops round any ink to move, resize or delete it.
- A finger scrolls and zooms, and a resting palm is ignored. No pen? **Settings → Writing with** lets a finger or a simple stylus write.

</details>

<details>
<summary><b>PC mode</b>: mouse and keyboard</summary>

- Drag over text to select it, then **Mark**, **Note** or **Copy**. Drag over a figure or blank paper to draw a box round it.
- Notes are typed, sit in the margin beside what you selected, and are linked to it. Double-click a note to edit it, drag it to move it, drag its side to make it wider. Maths between dollar signs is typeset: `$x^2$`.
- Double-click the margin to write a note right there. **Tidy margin** (right-click) re-stacks a crowded page.
- Mostly keyboard: `H` marks the selection, `N` adds a note, `Ctrl+F` then `Ctrl+Enter` marks a search match, `Alt+↓` jumps between notes. Press `?` for every key, or right-click anything.
- Papers annotated by hand on a tablet open as they are; a handwritten note can be turned into a typed one, and back.

</details>

<details>
<summary><b>Side notes, Find and maps</b></summary>

- Each paper has a notes pane with **side notes**: Markdown with maths, written by you or by an AI agent. They can link to your notes, your marks, a page, words on a page (`[Eq. 3](<text:4:Training objective>)`), or another paper at a page.
- **Find** searches the paper's text, your margin notes and your side notes at once.
- **Maps** show papers as boxes with arrows, in groups. On a map, a tap opens a paper; with a mouse, a click selects it and a double-click opens it.

</details>

<details>
<summary><b>Your library is plain files</b></summary>

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
      annotations.json        notes (with their text), marks and links
      notes/*.md              side notes
      regions/*.png           pictures of marked figures and equations
```

Each person who opens a shared library writes only into their own `people/` folder, so a library can be shared through OneDrive or similar. Settings live in `%APPDATA%\paper-reader` (Linux: `~/.config/paper-reader`).

**With AI agents:** open the library folder in Claude Code or another agent. The app's `AGENTS.md` explains the files, how to read your notes, how to write side notes and which links the app understands. A guide you edit by hand is left alone once you remove its first line.

</details>

<details>
<summary><b>Privacy</b></summary>

Everything stays on your computer, apart from looking up papers:

- Adding a paper or previewing a citation asks **arXiv**, **Semantic Scholar** and **doi.org** about it, and downloads its open PDF.
- **Search the web** (offered when nothing is found) opens Google in your browser; the address can be changed in Settings.
- Handwriting is recognized on your computer: by Windows, or by the downloaded models, which run offline. The models come from **Hugging Face** and the program that runs them from **llama.cpp's GitHub releases**, each file checked against a fixed checksum.
- **Sign in with Google** (optional, the account button at the top of the left rail) opens Google's page in your browser. The app asks only who you are (name, email, account id), gets no access to your Google data, and keeps no token: the account is used to name the folder your notes go into.
- An optional **usage log** (the record button in the left rail, off by default) writes what you do to local files, for finding bugs. It is never sent anywhere.

</details>

<details>
<summary><b>Keyboard shortcuts</b></summary>

Press `?` in the app for the full list. The main ones:

| Where | Keys | Does |
|---|---|---|
| Anywhere | `Ctrl+W` / `Ctrl+Shift+T` | Close the paper tab / reopen the last closed one |
| | `Ctrl+Tab`, `Ctrl+1`, `Ctrl+2` | Next tab, Library, Maps |
| Reader | `H` / `N` | Mark the selection / new margin note |
| | `P` `R` `E` `S` | Pen, Region, Eraser, Select ink |
| | `T` / `L` | Typed text / links, on or off |
| | `Ctrl+=` `Ctrl+−` `Ctrl+0` | Zoom in, out, fit |
| | `Space`, `→` `←`, `Home` `End` | Move through the paper |
| | `Ctrl+F`, `Ctrl+Enter`, `Ctrl+G` | Find, mark the match, go to a page |
| | `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| | `Ctrl+K` / `Ctrl+N` | Link the selected note / new side note |
| Maps | `S`, `G`, `Delete` | Select mode, name a group, remove from the map |
| Library | `/` | Search |

</details>

## Known limits

- Handwritten maths and the Linux handwriting reader have been tuned and measured on **one person's handwriting**. They may do worse on yours; please tell me when they do.
- On Linux, handwriting is read by a downloaded model: it needs about 4 GB of free memory, takes around ten seconds or more per note, and hasn't been tried on many Linux machines yet. Handwritten maths on Linux comes out inside the text, as `$…$`.
- On Linux, a pen works in an X11 session; under Wayland some Electron apps ignore pen input.
- No macOS build yet, and the installers aren't signed.
- Typed maths (`$…$`) works everywhere, in both modes.

## For developers

You need **[Node.js](https://nodejs.org/)** (developed with Node.js 26) and **Git**.

```
git clone https://github.com/Pawcharz/obelus-paper-reader.git
cd obelus-paper-reader
npm ci
start.cmd        # Windows
./start.sh       # Linux
```

```
npm run dev          the app with hot reload
npm test             unit tests (Vitest)
npm run test:e2e     builds the app and drives it with Playwright (simulated pen, fake network)
npm run typecheck    TypeScript
npm run dist         an installer for this system, into dist/
```

GitHub Actions runs the checks and builds both installers on every push; a version tag (`v0.3.0`) builds them onto a draft release.

| Folder | What is in it |
|---|---|
| `src/main` | The Electron main process: library storage, paper lookups, the handwriting engine, settings |
| `src/main/recognition` | Handwriting recognition. `resources/ink-sidecar.ps1` talks to Windows Ink; `llamaServer.ts` runs the local models (maths on Windows, text on Linux) with llama.cpp; other engines can implement `RecognitionEngine` in `engine.ts` |
| `src/main/models` | The downloadable models: pinned files and checksums (`catalog.ts`), resumable downloads, where they are kept |
| `src/renderer` | The interface: library, reader, notes pane, maps |
| `src/shared` | Logic shared by both, mostly pure and unit tested: telling writing from underlines and circles, grouping strokes into notes, placing typed notes, maths from PDF text |
| `tests/unit`, `tests/e2e` | Unit and end-to-end tests |

Contributions are welcome. Open an issue first, so we can talk it through.

## License

[MIT](LICENSE). Free to use, change and share. The downloadable models and llama.cpp come under their own licenses (Apache-2.0 and MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
