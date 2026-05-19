# @tracebench/adapter-cursor

Tracebench adapter for **Cursor Agent** session transcripts (JSONL).

## Phase 1 (shipped): agent-transcripts JSONL

Cursor writes supplementary agent logs under:

```
~/.cursor/projects/<sanitized-project-path>/agent-transcripts/
  <session-uuid>/<session-uuid>.jsonl     # nested layout
  <session-uuid>.jsonl                   # flat layout
  <parent-uuid>/subagents/<subagent-uuid>.jsonl
```

- **Default root:** `~/.cursor/projects` (override with `tracebench --cursor-dir <path>`)
- **Format version:** `2026-q1`
- **Harness id:** `cursor`

### Limitations (JSONL only)

Cursor's JSONL export does not include:

- `tool_result` lines (tool outputs are not separate events)
- per-line timestamps (synthetic timestamps from file mtime)
- token usage / model id (cost analytics show zeros)

The UI still renders `tool_call` events (Read, Write, Bash, Task, etc.) with **input only**.

## Phase 2 (planned): Composer SQLite (`state.vscdb`)

Full Composer / Ask history lives in Cursor's VS Code–style SQLite DBs. Paths by OS:

| OS | Global DB (`bubbleId`, `composerData`, …) |
|----|-------------------------------------------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |

Per-workspace index (Cursor ≤2.6): `<User>/workspaceStorage/<id>/state.vscdb` + `workspace.json`.

**Read WAL consistently:** copy `state.vscdb`, `state.vscdb-wal`, and `state.vscdb-shm` together.

Phase 2 will:

1. List composers via `composer.composerHeaders` (3.0+) or workspace `composer.composerData` (≤2.6).
2. Load `cursorDiskKV` keys `composerData:{id}` and `bubbleId:{id}:{bubbleId}`.
3. Normalize bubbles into `CanonicalEvent` (including tool results where present).
4. Dedupe with JSONL sessions when `composerId` matches the transcript folder UUID.

Helpers exported for Phase 2: `defaultCursorUserDataDir()`, `defaultCursorGlobalDbPath()` in `src/paths.ts`.

## SSH / WSL

Chat data stays on the machine running the Cursor UI (not the remote SSH host). Use the data dir for whichever Cursor install you actually run.
