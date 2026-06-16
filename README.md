# tracebench

> Local-first DevTools / flight recorder for AI coding agent sessions.

```bash
npx tracebench
```

[![npm](https://img.shields.io/npm/v/tracebench.svg)](https://www.npmjs.com/package/tracebench)
[![license](https://img.shields.io/npm/l/tracebench.svg)](./LICENSE)

Tracebench reads session logs from supported agent harnesses — **Claude Code, OpenCode, Codex, and Cursor** — and renders them into one unified observability view. The wedge is harness-agnosticism: most people use more than one tool, and existing viewers each tie themselves to one harness.

This is local, no cloud, no telemetry. Apache 2.0.

![tracebench session viewer](./assets/screenshot.png)

## Status

Tracebench is useful today if you want a local, cross-harness way to inspect AI coding agent sessions, tool calls, token use, costs, and context pressure. It is still pre-1.0: the canonical schema and API can change, context analysis is reconstructed from logs rather than the exact model prompt, and features like plugin loading, live tail, export, annotations, and comparative views are not built yet.

## What's in the box

|  |  |
|---|---|
| Adapters live | `claude_code`, `codex`, `cursor`, `opencode` |
| Cursor sources | Agent transcript JSONL plus Composer SQLite (`state.vscdb`) |
| UI | Vite + React 18 — three-pane layout, tool-aware timeline, spend dashboard, context inspector, analytics rail, harness tabs |
| Backend | Fastify on `127.0.0.1`, SQLite via `better-sqlite3`, multi-adapter incremental indexer |
| Tests | 143 Vitest cases across 12 test files |

For per-release changes see **[CHANGELOG.md](./CHANGELOG.md)**.

## Install

```bash
npx tracebench
```

That's it. Opens at **http://127.0.0.1:3478**.

On first run it discovers everything under `~/.claude/projects`, `~/.codex/sessions`, `~/.cursor/projects/**/agent-transcripts`, Cursor Composer history from `state.vscdb`, and OpenCode history, then hot-indexes the freshest bounded working set into `~/.tracebench/tracebench.db`. Subsequent boots stay fresh by indexing changed/recent sessions automatically; full historical backfill is explicit with `--index-all` or scoped re-indexing. The UI also shows discovered-only sessions so bounded startup indexing does not look like missing data.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--port <n>` | `3478` | listen port |
| `--host <h>` | `127.0.0.1` | listen host |
| `--dir <path>` (alias `--claude-dir`) | `~/.claude/projects` | Claude Code projects root |
| `--codex-dir <path>` | `~/.codex` | Codex sessions root |
| `--cursor-dir <path>` | `~/.cursor/projects` | Cursor agent-transcripts root |
| `--cursor-user-data-dir <path>` | OS default | Cursor `User/` dir (Composer `state.vscdb`) |
| `--db-path <path>` | `~/.tracebench/tracebench.db` | SQLite location |
| `--index-all` | — | opt into full historical indexing on startup |
| `--max-startup-sessions <n>` | `200` | cap startup indexing per harness |
| `--max-startup-bytes <size>` | `1GB` | cap startup source bytes per harness |
| `--since <duration\|date>` | — | only index sessions newer than a duration/date, e.g. `30d` |
| `--harness <names>` | all | only index selected harnesses, comma-separated |
| `--preserve-raw <reference\|full>` | `reference` | keep raw fidelity by source reference unless full raw copying is requested |
| `doctor --storage` | — | non-mutating storage report with DB/WAL, source bytes, largest sessions, and payload split |
| `--no-open` | — | skip browser auto-launch |
| `--no-index` | — | skip the startup re-index pass |
| `-v` / `--verbose` | — | verbose stderr logging |

### From source (contributors only)

```bash
git clone https://github.com/Skandesh/tracebench
cd tracebench
pnpm install
pnpm -r build
node packages/server/dist/cli.js
```

## Architecture

Three layers with stable contracts in between.

```
packages/
├── core/                       schema, SQLite + migrations, pricing, query API
├── adapter-claude-code/        reads ~/.claude/projects/**/*.jsonl, normalizes
├── adapter-codex/              reads ~/.codex/sessions + archived_sessions, normalizes
├── adapter-cursor/             reads Cursor agent-transcripts + Composer state.vscdb
├── adapter-opencode/           reads ~/.local/share/opencode/opencode.db
├── server/                     Fastify routes + CLI entry + multi-adapter indexer
└── ui/                         Vite + React 18, ported from the prototype
```

The adapter registry lives at `packages/server/src/adapters.ts` — adding a new harness today means writing one adapter package and adding one entry there. Dynamic plugin loading is not implemented yet.

### Canonical event schema

Adapters produce, and the UI consumes, a single shape (`packages/core/src/schema.ts`). The shape is versioned; it becomes stable at v1.0.

### Cost methodology

Cost is computed from a vendored LiteLLM-style pricing table (`packages/core/pricing.json`). The formula is in `pricing.ts`:

```
cost_usd = input * input_per_token
        + (output + reasoning) * output_per_token
        + cache_read * cache_read_per_token
        + cache_creation * cache_creation_per_token
```

`cost_method` is `"logged"` when the harness reports a cost directly, `"estimated"` when we compute from the table, `null` for unknown models. The UI surfaces this — no silent guessing.

### Indexer

On startup, the server walks each adapter root (Claude Code, Codex, Cursor, OpenCode), records a lightweight discovery manifest for everything it sees, and hot-indexes changed/recent sessions within the startup budget. This preserves freshness without silently duplicating multi-GB history. Full history remains available through `--index-all`, `POST /api/reindex?indexAll=1`, or `POST /api/sessions/:id/index` for a discovered session.

Claude Code, Codex, and Cursor JSONL adapters expose a streaming index contract that yields session metadata plus bounded event batches. The indexer stages those batches first, then atomically publishes the complete session into the visible tables. If a large backfill fails halfway through, the previous indexed version stays visible and the manifest records the error.

Large raw payloads are no longer copied into every hot event row by default. Tracebench stores raw source references with JSONL line locators when available, and externalizes/deduplicates large content/tool payloads into a compressed payload archive while keeping the timeline API fidelity intact. `GET /api/sessions/:id/events/:eventId/raw` can retrieve the original raw record from the source file when that file is still present.

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/sessions?harness=&q=&limit=&offset=` | session list with aggregates |
| `GET /api/sessions/:id` | session + tool counts |
| `GET /api/sessions/:id/turns` | events grouped into turns |
| `GET /api/sessions/:id/events` | flat event list, seq order |
| `GET /api/sessions/:id/events/:eventId/raw` | raw/provenance lookup for a canonical event |
| `GET /api/pricing` | the vendored pricing table |
| `GET /api/storage` | storage diagnostics: source bytes, DB/WAL footprint, payload split, largest sessions, index-run state |
| `GET /api/discovered-sessions?harness=&session_id=` | manifest rows, including discovered-only sessions |
| `POST /api/reindex` | re-index pass; supports `harness`, `indexAll`, `full`, `maxSessions`, `maxSourceBytes`, `since`, `raw` |
| `POST /api/sessions/:id/index` | hot-index one discovered session on demand |

## Repo layout

```
tracebench/
├── packages/
│   ├── core/                          @tracebench/core
│   ├── adapter-claude-code/           @tracebench/adapter-claude-code
│   ├── adapter-codex/                 @tracebench/adapter-codex
│   ├── adapter-cursor/                @tracebench/adapter-cursor
│   ├── adapter-opencode/              @tracebench/adapter-opencode
│   ├── server/                        tracebench (npm bin)
│   └── ui/                            @tracebench/ui
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── LICENSE                            Apache 2.0
```

## Development

```bash
# install
pnpm install

# typecheck everything
pnpm -r typecheck

# test everything
pnpm -r test

# build everything
pnpm -r build

# UI dev server (proxies /api to localhost:3478, so run the server too)
pnpm --filter tracebench dev
pnpm --filter @tracebench/ui dev
```

## Releasing

Maintainers only. See [RELEASING.md](./RELEASING.md).

1. Add notes under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md).
2. Run `pnpm release patch --skip-publish` (or `minor` / `major` / an exact version).
3. The script bumps all six publishable packages, builds, tests, commits, tags `v*`, pushes, and opens a GitHub release.
4. [`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes all six publishable packages to npm on the tag (no local passkey).

One-time setup: npm **Trusted Publisher** on `tracebench` and each `@tracebench/*` package → workflow `release.yml`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## Roadmap

- **v0.3.x (current)** — four live adapters, spend dashboard, context inspector, context pressure indicators
- **v0.4** — Adapter authoring guide, Windows support, per-adapter fixture CI, plugin loader
- **v0.5+** — Plugin registry, comparative views, live tail, HTML export, annotations, sub-agent visualization
- **v1.0** — Stable schema/API, semver guarantees, all four adapters hardened against upstream log changes, second maintainer

## License

Apache 2.0. The explicit patent grant matters in tooling where contributors may work at AI labs.
