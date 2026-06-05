# Changelog

All notable changes to tracebench are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

> **How releases work:** edit `[Unreleased]` below as you work. Running `pnpm release <version> --skip-publish` (see `scripts/release.mjs`) promotes it to a dated `[X.Y.Z]` section, bumps all package versions, commits, tags, and pushes.

## [Unreleased]

### Added
- **Context pressure indicator** — 80% window threshold marker, fill-ratio sparkline with active turn, and elevated/critical banners when reconstructed context nears the model limit.

## [0.3.0] — 2026-06-04
### Added
- **OpenCode adapter** — reads sessions from `~/.local/share/opencode/opencode.db` (messages, parts, tools, reasoning, compaction).
- **Context window analyzer** — session-mode composition bar, attention zones, waste detection, and advisory suggestions in the analytics rail (`analyzeSessionContext` in `@tracebench/core`).
- **Context inspector** — per-category totals, top tool-result offenders, turn deltas on the timeline, token badges on tool rows, and a **Missing or incomplete logs** panel (missing results, orphans, empty outputs, Cursor JSONL gaps). Click any item to jump to the timeline.
- **Analytics rail UX** — Overview / Context tabs, collapsible secondary sections, wider rail, and less duplicate context metrics.

## [0.2.7] — 2026-05-23
### Fixed
- **Session tool filter** — pill switching stays responsive on large sessions; filtered view renders in batches with load-more instead of mounting thousands of rows at once.
- **CLI port conflict** — starting tracebench while port 3478 is taken auto-bumps to the next free port instead of failing with EADDRINUSE.

## [0.2.6] — 2026-05-22
### Added
- **Spend Dashboard** — aggregated spend view across all sessions: totals, token breakdown, spend by provider, and top projects. Toggle from the TopBar chart button or press `d`.

### Changed
- **Shared UI constants** — `HARNESS_LABELS` and `HARNESS_COLORS` moved to `constants.ts`; `ViewMode` type shared via `types.ts`.

## [0.2.5] — 2026-05-20
### Fixed
- **Release CI** — pin npm 11.5.2 for OIDC trusted publishing (fixes npm 404 on publish).

## [0.2.4] — 2026-05-20
### Fixed
- **Release CI** — `@fastify/static` v8 for Fastify 5 (fixes publish workflow build).

## [0.2.3] — 2026-05-20
### Added
- **Cursor adapter Phase 2** — indexes Composer sessions from Cursor's global `state.vscdb` (bubbles with tool results, thinking, timestamps, model). Merges with JSONL agent-transcripts; DB wins when `composerId` matches. CLI: `--cursor-user-data-dir <path>`.

### Fixed
- **Project filter in sessions sidebar** — clicking a project filters the session list; click again to clear.

### Changed
- Release docs describe CI publish with `pnpm release --skip-publish`.

## [0.2.2] — 2026-05-20
### Changed
- Releases publish to npm via GitHub Actions on version tags (`pnpm release --skip-publish`).

## [0.2.1] — 2026-05-20
### Fixed
- Coordinated npm publish ships `@tracebench/adapter-cursor` with `tracebench` so `npx tracebench` resolves all scoped dependencies.

## [0.2.0] — 2026-05-19
### Added
- **`@tracebench/adapter-cursor`** — indexes Cursor Agent transcripts from `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` (nested sessions and `subagents/` as separate sessions). Cursor harness tab is live.
- **`--cursor-dir <path>`** CLI flag (default `~/.cursor/projects`).
- **Collapsible sessions sidebar** — chevron toggle; preference persisted in `localStorage`.
- **Collapsible Projects list** in the sessions sidebar — chevron on the Projects header; preference in `tracebench.projectsCollapsed`.

### Changed
- **Responsive layout** — trace timeline stays primary on narrow windows; analytics rail hides below ~1080px; harness tabs scroll instead of clipping.
- **Session header / messages** — truncation and grid `min-width` fixes so titles and user text no longer blow out the layout.

### Notes
- Cursor JSONL exports have no `tool_result` lines or token usage yet; tool calls show input only. Composer SQLite (`state.vscdb`) is planned for richer metadata.

## [0.1.3] — 2026-05-19
### Changed
- README dropped the version-pinned "Status" section; the changelog is now the source of truth for what shipped.

### Added
- `CHANGELOG.md` is bundled into the published `tracebench` tarball so the npm page can link to it.
- `scripts/release.mjs` orchestrates releases: version bump → changelog promotion → build → test → commit → tag → GitHub release; npm publish via CI on tag.

## [0.1.2] — 2026-05-19

The "made it fast" release. `/api/sessions` went from ~5.8 s to ~3 ms on a 321-session directory.

### Changed
- **Precomputed session aggregates.** The indexer now summarizes each session's events once at write time (cost, tokens, duration, turn count, tool calls, errors) and stores the totals on the `sessions` row. `/api/sessions` is a pure `SELECT` — no GROUP BY across the events table.
- **Filter + search now client-side.** The UI fetches all sessions once on mount and applies harness/text filtering in memory. Switching harness tabs is instant — no refetch.
- **Default API limit 200 → 5000.** A normal user's whole directory comes back in one request.
- **Highlight pulse 2 s → 1.2 s** on click-to-navigate; matched between CSS and the JS auto-clear.
- **Server prefers the workspace UI bundle over a stale prepack artifact** when both exist (was the other way around).

### Added
- **Click-to-navigate tool-call errors.** Click "N err" on any session card (active or inactive) or "N errors" at the timeline end — the timeline scrolls to the next errored tool call and pulses a highlight. Cycles through all errors on repeat clicks.
- **Tokens/turn and Tokens/tool metrics** in the Analytics rail (compact format: `12.3k`, `1.5M`).
- **`@tracebench/core` exports** `summarizeEvents()` for downstream consumers.
- **Database migration v2** adds the aggregate columns: `total_cost_usd`, `total_input_tokens`, `total_output_tokens`, `total_cache_read_tokens`, `total_cache_create_tokens`, `total_reasoning_tokens`, `duration_ms`, `turn_count`, `tool_call_count`, `tool_error_count`, `message_count`. Existing DBs migrate on next boot.
- **In-memory session-detail cache** in the UI. Re-clicking a session you've already viewed skips the network entirely.
- **`prefers-reduced-motion` guard** on the tool-call highlight animation.
- **`useDisclosure` hook** for tool-call open/close state (was duplicated across 6 renderers).
- **`useErrorNavigation` hook** owning the find-errors / cycle / scroll-with-retry / cross-session "switch + jump" capability.
- **`selectors.ts`** with pure `indexToolResultsByCall` and `findErrorToolCallIds` — single source of truth for tool-result pairing.

### Fixed
- **Harness tab counts no longer go to 0** for inactive harnesses when a filter is active. They're computed from the unfiltered list now.
- **"N err" badge on inactive session cards** is now clickable and switches the active session **and** jumps to errors. Previously it was a no-op and also blocked the card's own click via `stopPropagation`.
- **Tokens-per-* labeling.** What used to be "Tokens/request" was actually tokens-per-turn (one turn can trigger many API calls) and excluded cache reads (~90% of input on Claude Code). Renamed to "Tokens/turn" and includes cache tokens.
- **Scroll-to-error race condition.** When clicking a session for the first time, the target element may not exist on the first paint. The scroll now retries via `requestAnimationFrame` for up to 10 frames.
- **Session-card layout** — error badge no longer overlaps the timestamp; stats row wraps cleanly on narrow widths.

### Refactored
- **`ToolShell` wrapper component + `useHighlightAutoClear` hook** absorb the cross-cutting concerns from the six tool renderers (Bash, Read, Edit, Write, Grep, Generic). Each renderer is now body-only.
- **CSS `--color-error` / `--color-error-hover` custom properties** replace 5 inline `oklch()` literals.
- **`App.tsx` shrunk 245 → 149 lines.** All error-nav mechanics moved into `useErrorNavigation`.

### Performance (measured against 321 real sessions / 175k events)
| | before | after |
|---|---|---|
| `GET /api/sessions` (cold) | 5.8 s | 3 ms |
| `GET /api/sessions` (warm) | 5.5 s | 3–7 ms |
| Re-click cached session | full refetch (~500 ms+) | 39–192 ms (render only) |
| Sessions visible in UI | 200 (capped) | all 321 |

## [0.1.1] — 2026-05-18

First public npm release.

### Added
- `npx tracebench` works from a clean machine. Single command install, runs the local web app.
- Published to npm:
  - [`tracebench`](https://www.npmjs.com/package/tracebench) — the CLI
  - [`@tracebench/core`](https://www.npmjs.com/package/@tracebench/core)
  - [`@tracebench/adapter-claude-code`](https://www.npmjs.com/package/@tracebench/adapter-claude-code)
  - [`@tracebench/adapter-codex`](https://www.npmjs.com/package/@tracebench/adapter-codex)
- Prepack script bundles the UI dist into the `tracebench` tarball so the published package is fully self-contained.

### Changed
- Internal `@tracebench/server` package renamed to **`tracebench`** so `npx tracebench` resolves directly.

### Fixed
- Pricing data refreshed from the upstream [LiteLLM JSON](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json). Notable corrections: claude-opus-4.x was using Claude 3 Opus prices (off by 3×), gpt-5.5 was at half the real rate. Added gpt-5-mini/nano/pro, gpt-5.1.x, gpt-5.2.x, gpt-5.4.x, claude-opus-4-1, claude-3-7-sonnet.
- Session-card error badge no longer overlaps the timestamp (was absolute-positioned at the same coordinates).
- Right rail layout no longer clips at common viewport widths (`minmax(0, 1fr)` on the grid columns).

## [0.1.0] — 2026-05-18 (un-published, version reserved on npm)

Initial implementation. Bundled into 0.1.1 for the first public release.

### Added
- **`@tracebench/core`** — canonical event schema, SQLite + migrations, pricing engine, query API.
- **`@tracebench/adapter-claude-code`** — discovers and normalizes `~/.claude/projects/**/*.jsonl`. Handles multi-block assistant messages, tool_use ↔ tool_result linkage, orphan results, compaction, malformed lines.
- **`@tracebench/adapter-codex`** — discovers and normalizes `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/`. Maps `function_call` / `function_call_output` / `custom_tool_call` / `web_search_call` / `reasoning` to canonical events.
- **`@tracebench/server`** — Fastify routes (`/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/turns`, `/api/sessions/:id/events`, `/api/pricing`, `POST /api/reindex`), multi-adapter indexer (`packages/server/src/adapters.ts`), incremental re-index by mtime, CLI entry with `--port`, `--dir`/`--claude-dir`, `--codex-dir`, `--db-path`, `--no-open`, `--no-index`, `-v`.
- **`@tracebench/ui`** — Vite + React 18, three-pane layout, harness tabs, tool-aware timeline (Bash/Read/Edit/Write/Grep + Codex `exec_command` and `apply_patch` aliases), analytics rail (cost / duration / tokens / cache / context-window sparkline / tool mix / file churn), `j`/`k` nav, `/` to focus search.
- **Pricing engine** — vendored LiteLLM-style JSON, `computeCost`, alias resolution with dated-suffix fallback.
- **75 tests** across the four packages.

[0.1.2]: https://github.com/Skandesh/tracebench/releases/tag/v0.1.2
[0.1.1]: https://github.com/Skandesh/tracebench/releases/tag/v0.1.1
[0.1.0]: https://github.com/Skandesh/tracebench/releases/tag/v0.1.1
