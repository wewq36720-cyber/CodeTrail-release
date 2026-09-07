# Project Introduction · CodeTrail 码途

> **🌐 Language: [中文](INTRO.md) · [English](INTRO.en.md) · [日本語](INTRO.ja.md)**

## One-line positioning

**CodeTrail 码途** is a "code learning platform" that runs in your local browser — turn any code directory on your
machine into a course with **a learning roadmap, an AI teaching assistant, and progress tracking**, helping you
systematically read source code, practice with tests, and take notes.

## Why it exists

The most common pain points when learning code:

- You open an open-source repo and **don't know where to start** — path guidance is pure guesswork
- You read halfway and **forget where you are and what's next**, with no review mechanism
- To ask questions or verify exercises, you keep switching between tools (editor / terminal / notes / browser)

CodeTrail converges "scan → roadmap → read → ask → practice → progress" into a single local single-port app:
**your data always stays on your own machine**, no cloud dependency, and fully usable without an AI key.

## Core capabilities

| Capability | Description |
|---|---|
| Auto course generation | Register a learning directory → source repos / tutorial docs are detected and classified into courses |
| Code index | Symbol extraction (Python AST / JS·Go regex) → internal dependency graph → PageRank importance → role classification, generated locally with zero tokens |
| Learning roadmaps | Smart Route / Markdown guide import / AI draft — three sources produce steps with line ranges |
| Built-in IDE | Monaco three-pane workspace: file tree + chat + editor/step card, with symbol outline, bookmarks, and line-range linking |
| AI assistant | Multi-session Q&A carrying course context; supports Anthropic / OpenAI-compatible endpoints; on-demand tutorial translation |
| Practice & verification | Static checks (py_compile / node --check / go vet) + test challenges (M1 output comparison / M2 assertion scripts), sandboxed execution |
| Progress management | State machine + self-rating (1–5) + review queue + dashboard heatmap, real-time sync across tabs |
| Personalized appearance | Five semantic-token themes, one-click switching, remembered locally |

## Three iron rules

1. **All data stays local**: progress, notes, tests, and backups live only in the platform data directory (LDD) — never written into learner repos.
2. **Learning repos are read-only**: test temp files and bytecode are redirected to the platform directory.
3. **Works without a key**: AI is an optional enhancement — without an API key, scanning, roadmaps, reading, testing, and progress tracking all still work fully.

## Architecture

```
┌────────────────────────────┐     single port 127.0.0.1:8787
│  client/  React 18 + TS    │
│  Vite + Monaco + tokens    │──WS──▶  server/  Express + ws
└────────────────────────────┘        node:sqlite + file service + exec sandbox
                                      │
                                      ▼
                              <workspace root>\.learndesk\   (platform data · SQLite + files)
```

- **Frontend**: React 18 · TypeScript · Vite · Monaco Editor · react-markdown · custom theme system
- **Backend**: Express · ws (streaming progress/logs) · node:sqlite (Node ≥ 22.5) · tsx
- **Indexing & execution**: custom code indexer (AST + dependency graph + PageRank); multi-language toolchain sandbox (uv/go/node)

## Requirements

- **Node.js ≥ 20** (22.5+ recommended for built-in `node:sqlite`)
- Optional: Python (uv) · Go — for tests / static checks of the corresponding courses
- Optional: Docker — one-command containerized startup
- Optional: AI API key — chat / route drafts / translation enhancements

## Getting started

```
1. Launch with start.bat → add a learning root path in Settings → scan courses
2. Pick a course → Smart Route → a learning roadmap appears on the workbench
3. Click a leaf → read code in the AI view → ask AI / run tests / mark done
4. Dashboard & review queue remind you → keep iterating
```

## Boundaries & known limitations

- Single directories with >800 entries are truncated, search caps at 300 results, files >2MB decode only the first 256KB — for very large monorepos register subdirectories instead
- Test execution requires the matching runtime locally; buttons show install hints when missing
- AI features need your own API key; browser state like theme/sessions lives in localStorage and resets when switching browsers (data itself is unaffected)

## License

MIT License (replace with your LICENSE file as needed).