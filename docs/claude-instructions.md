# Working with a paper's notes in Claude Code

The instructions for Claude Code and other agents now live in `src/main/agentGuide.ts`. When a library is
opened, the app writes them to its root:

- `AGENTS.md`: where things are, how to read the notes, how to write side notes, and the links side notes
  understand (`note:<id>`, `mark:<id>`, `page:<n>` and web links).
- `CLAUDE.md`: only `@AGENTS.md`, so Claude Code picks the guide up.

Both start with a marker line. The app replaces a file that has the marker when the guide changes, and never
touches one without it, so deleting that line keeps a hand-edited version.
