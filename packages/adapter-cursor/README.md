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

## Phase 2 (shipped): Composer SQLite (`state.vscdb`)

Full Composer / Ask history lives in Cursor's VS Code–style SQLite DBs. Paths by OS:

| OS | Global DB (`bubbleId`, `composerData`, …) |
|----|-------------------------------------------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |

Per-workspace index (Cursor ≤2.6): `<User>/workspaceStorage/<id>/state.vscdb` + `workspace.json`.

**Read WAL consistently:** copy `state.vscdb`, `state.vscdb-wal`, and `state.vscdb-shm` together.

Phase 2:

1. Snapshots `state.vscdb` (+ `-wal`/`-shm`) for consistent reads while Cursor is open.
2. Lists composers with stored bubbles; loads `composerData:{id}` and ordered `bubbleId:{id}:{bubbleId}` rows.
3. Normalizes bubbles into `CanonicalEvent` — `tool_call` + `tool_result` (via `toolFormerData`), thinking (`capabilityType` 30), real timestamps, model id.
4. Dedupes with JSONL: when `composerId` matches an agent-transcript folder UUID, the DB entry replaces JSONL.

Discovery merges both sources automatically. DB sessions use virtual paths `cursor-db:{composerId}@{globalDbPath}`.

CLI: `tracebench --cursor-user-data-dir <path>` overrides the OS-default Cursor `User/` directory (see `defaultCursorUserDataDir()` in `src/paths.ts`).

## SSH / WSL

Chat data stays on the machine running the Cursor UI (not the remote SSH host). Use the data dir for whichever Cursor install you actually run.
