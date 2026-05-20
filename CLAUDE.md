# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

tracebench is a local-first viewer for AI coding agent sessions. It reads JSONL session logs from Claude Code and Codex, normalizes them into a canonical event schema, and serves a three-pane web UI. Published to npm as `tracebench`; run with `npx tracebench`.

See `README.md` for the user-facing pitch and `CHANGELOG.md` for history.

## Repo shape (pnpm workspace)

```
packages/
├── core/                       schema, SQLite + migrations, pricing, query API
├── adapter-claude-code/        reads ~/.claude/projects/**/*.jsonl
├── adapter-codex/              reads ~/.codex/sessions + archived_sessions
├── adapter-cursor/             reads ~/.cursor/projects/**/agent-transcripts
├── server/                     Fastify + multi-adapter indexer + CLI (publishes as `tracebench`)
└── ui/                         Vite + React 18 (bundled into the server tarball at publish time)
```

All five publishable packages (`@tracebench/core`, `@tracebench/adapter-claude-code`, `@tracebench/adapter-codex`, `@tracebench/adapter-cursor`, `tracebench`) ship together at the same version. `@tracebench/ui` is private — it's bundled into the `tracebench` tarball via `packages/server/scripts/prepack.mjs`.

The adapter registry lives in `packages/server/src/adapters.ts`. To add a new harness, write an adapter package implementing the discover/parse/normalize trio and add one entry to that file. Dynamic plugin loading is a v0.5+ task — don't add it yet.

## Architecture you need to know before editing

### Canonical event schema is the contract

`packages/core/src/schema.ts` defines `CanonicalEvent`. **Every adapter must produce this shape; the UI consumes only this shape.** When adding a harness, fit its events into existing `event_type` values (`message`, `tool_call`, `tool_result`, `thinking`, `meta`, `summary`, `compaction`) — don't invent new ones without bumping the schema version.

Key invariants:
- `tool_call` events have `event_id = <upstream call_id>` so `tool_result.parent_event_id` can match.
- Usage tokens are attached to the **first** event emitted per assistant message (not duplicated across blocks).
- Unknown / unhandled raw events become `event_type: 'meta'` with `metadata.kind` set — never dropped.

### Aggregates are precomputed at index time

`/api/sessions` is a pure `SELECT` — there is no GROUP BY across the events table. The indexer calls `summarizeEvents(events)` (in `packages/core/src/aggregate.ts`) once during normalize and stores totals on the `sessions` row. Migration v2 adds those columns.

**If you change what aggregates are tracked, you must:**
1. Add columns via a new migration in `db.ts`.
2. Update `summarizeEvents()` to compute them.
3. Update `upsertSession()` and the `SessionAggregateRow` interface.
4. Update `listSessions()` to read them.

Don't re-introduce a GROUP BY at query time. It was 5.8s on a real DB.

### UI fetches once, filters client-side

`App.tsx` fetches the full session list on mount with no `?harness=` filter. Harness/text filtering happens in a `useMemo`. **Don't add server-side filter calls back** — they break tab counts and re-introduce the perceived sluggishness.

Session detail (`getSession` + `getSessionTurns`) is cached in a `useRef<Map>` keyed by `session_id`. Re-clicking a session pays zero network cost.

### Service-layer split

Per the `code-structure` skill: orchestration in `App.tsx` (when sessions load, when intents fire), mechanics in hooks/selectors:

- `packages/ui/src/selectors.ts` — pure data transforms (`indexToolResultsByCall`, `findErrorToolCallIds`). Both `App.tsx` and `Timeline.tsx` consume these. **Don't duplicate the `tool_result` lookup logic** — it lived in two places before and silently drifted.
- `packages/ui/src/hooks/useErrorNavigation.ts` — the entire error-nav capability.
- `packages/ui/src/hooks/useDisclosure.ts` — open/setOpen for tool-call bodies.
- `packages/ui/src/tools/ToolCall.tsx` — `ToolShell` wraps the cross-cutting concerns (highlight class, `data-event-id`, auto-clear timer); each renderer (Bash/Read/Edit/Write/Grep) is body-only.

When you find yourself copy-pasting the same `useEffect`/className/data-attr across renderers, the answer is "extend ToolShell" or "make a hook" — not another copy.

### Pricing

`packages/core/pricing.json` is the canonical pricing source, hand-vendored from BerriAI/litellm's `model_prices_and_context_window.json`. The `_meta.fetched_at` field shows when it was last refreshed. If you touch model pricing, update the file and re-index (`POST /api/reindex` or restart with a fresh DB).

Reasoning tokens bill as output. OpenAI rows have no `cache_creation` cost — we store `0` for that field.

## Common commands

```bash
pnpm install                # bootstrap
pnpm -r build               # build all packages
pnpm -r test                # run all tests (75 across 4 packages)
pnpm -r typecheck           # tsc --noEmit across all packages

# run a single test file
pnpm --filter @tracebench/core test src/pricing.test.ts

# dev: run server + UI dev server
pnpm --filter tracebench start            # backend on :3478
pnpm --filter @tracebench/ui dev          # UI on :5173 with /api proxy

# rebuild + restart server with a fresh DB
rm -f ~/.tracebench/tracebench.db
node packages/server/dist/cli.js --no-open --verbose
```

## Releasing

**Single command** — see `RELEASING.md` for the full doc. TL;DR:

```bash
pnpm release patch --skip-publish
```

This:
1. Refuses to run with a dirty working tree.
2. Promotes `## [Unreleased]` → `## [0.1.4] — YYYY-MM-DD` in `CHANGELOG.md`.
3. Bumps all 4 `package.json` files to the same version.
4. `pnpm install --lockfile-only` so workspace deps re-resolve.
5. `pnpm -r build && pnpm -r test`.
6. Publishes all 5 packages in dep order: core → adapter-claude-code → adapter-codex → adapter-cursor → tracebench.
7. Commits as `release: vX.Y.Z`, tags, pushes.
8. Creates the GitHub release using the new CHANGELOG section as the body.

**As you make changes, add lines under `## [Unreleased]` in `CHANGELOG.md`.** That's the release notes. The script reads from there and from nowhere else.

**Don't bump versions by hand.** Don't publish individual packages out of band — `tracebench` pins exact versions of the scoped deps; they have to ship together.

If a release half-fails after the changelog is promoted but before push, `git checkout -- .` and re-run. npm reserves the version for 24h, so a partial publish forces a bump on retry.

## Gotchas

- **`packages/server/ui/` shadowing `packages/ui/dist/`** — `pnpm pack` creates `packages/server/ui/` as a prepack artifact. The server's `findUiBuildDir()` prefers the workspace path now, but if you ever see stale UI in dev, delete `packages/server/ui/`.
- **Renamed package**: the server package was `@tracebench/server` originally; it's `tracebench` now so `npx tracebench` resolves. Use `pnpm --filter tracebench …` for that package, not `@tracebench/server`.
- **Docs that aren't committed**: `docs/` is gitignored — it holds planning artifacts (PRD, ROADMAP, BUILD plan) that are for the maintainer, not the repo.
- **better-sqlite3 native module**: the install builds it from source. The deprecation warnings for `prebuild-install` and `glob` are transitive — not from our code.

## What NOT to add

- Plugin loader / dynamic adapter loading (v0.5+, not now)
- Auth, multi-user, cloud sync — local-first is the wedge
- Real-time intervention in running agents — this is a viewer, not a harness
- Adapter for any harness not in {Claude Code, OpenCode, Codex, Cursor} — those four are the first-party scope; community adapters are welcome but live outside the core repo
