// SQLite storage layer. better-sqlite3 chosen for sync API + zero setup.
//
// Schema notes:
// - events.* columns mirror the canonical event shape; complex fields
//   (tokens, tool, metadata, raw, content-if-object) are stored as JSON text
// - context_snapshots stores per-turn snapshots from PRD §8. v0.1 will not
//   populate this table; it exists so v0.3's context analyzer can land without
//   a migration.

import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  CanonicalEvent,
  ContextSnapshot,
  Session,
} from './schema.js';

export interface OpenDbOptions {
  /** Path to the SQLite file. Use ':memory:' for tests. */
  path: string;
  /** Skip migrations (advanced; for tests only). */
  skipMigrations?: boolean;
}

export interface TracebenchDb {
  raw: DB;
  close(): void;
}

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE sessions (
        session_id      TEXT PRIMARY KEY,
        harness         TEXT NOT NULL,
        project_path    TEXT NOT NULL,
        title           TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        model           TEXT,
        raw_path        TEXT NOT NULL,
        format_version  TEXT NOT NULL,
        mtime_ms        INTEGER NOT NULL
      );

      CREATE INDEX sessions_by_harness    ON sessions(harness);
      CREATE INDEX sessions_by_project    ON sessions(project_path);
      CREATE INDEX sessions_by_started_at ON sessions(started_at DESC);

      CREATE TABLE events (
        event_id         TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        turn_id          TEXT NOT NULL,
        parent_event_id  TEXT,
        timestamp        TEXT NOT NULL,
        seq              INTEGER NOT NULL,    -- insertion order within session, for stable sort
        role             TEXT NOT NULL,
        event_type       TEXT NOT NULL,
        model            TEXT,
        cost_usd         REAL,
        cost_method      TEXT,
        duration_ms      INTEGER,
        -- denormalized token fields for cheap aggregation
        tok_input        INTEGER,
        tok_output       INTEGER,
        tok_cache_read   INTEGER,
        tok_cache_create INTEGER,
        tok_reasoning    INTEGER,
        -- denormalized tool fields for filtering / aggregates
        tool_name        TEXT,
        tool_status      TEXT,
        -- JSON blobs
        source_json      TEXT NOT NULL,
        tokens_json      TEXT NOT NULL,
        tool_json        TEXT NOT NULL,
        content_json     TEXT,        -- string content stored as JSON string for uniformity
        metadata_json    TEXT NOT NULL,
        raw_json         TEXT NOT NULL
      );

      CREATE INDEX events_by_session_seq    ON events(session_id, seq);
      CREATE INDEX events_by_session_turn   ON events(session_id, turn_id, seq);
      CREATE INDEX events_by_timestamp      ON events(timestamp);
      CREATE INDEX events_by_tool_name      ON events(tool_name);
      CREATE INDEX events_by_parent         ON events(parent_event_id);

      CREATE TABLE context_snapshots (
        turn_id            TEXT NOT NULL,
        session_id         TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        model              TEXT NOT NULL,
        max_context_tokens INTEGER NOT NULL,
        components_json    TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );

      CREATE INDEX context_snapshots_by_session ON context_snapshots(session_id);
    `,
  },
];

function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function runMigrations(db: DB): void {
  ensureMigrationsTable(db);
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  );
  const insert = db.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name);
    })();
  }
}

export function openDb(opts: OpenDbOptions): TracebenchDb {
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  if (!opts.skipMigrations) runMigrations(db);
  return {
    raw: db,
    close: () => db.close(),
  };
}

// ── Session writes ──────────────────────────────────────────────────────────

export function upsertSession(db: TracebenchDb, s: Session): void {
  db.raw
    .prepare(
      `INSERT INTO sessions (
         session_id, harness, project_path, title, started_at, ended_at,
         model, raw_path, format_version, mtime_ms
       ) VALUES (
         @session_id, @harness, @project_path, @title, @started_at, @ended_at,
         @model, @raw_path, @format_version, @mtime_ms
       )
       ON CONFLICT(session_id) DO UPDATE SET
         harness         = excluded.harness,
         project_path    = excluded.project_path,
         title           = excluded.title,
         started_at      = excluded.started_at,
         ended_at        = excluded.ended_at,
         model           = excluded.model,
         raw_path        = excluded.raw_path,
         format_version  = excluded.format_version,
         mtime_ms        = excluded.mtime_ms`,
    )
    .run({
      ...s,
      title: s.title ?? null,
      ended_at: s.ended_at ?? null,
      model: s.model ?? null,
    });
}

export function deleteSessionEvents(db: TracebenchDb, sessionId: string): void {
  db.raw.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  db.raw
    .prepare('DELETE FROM context_snapshots WHERE session_id = ?')
    .run(sessionId);
}

// ── Event writes ────────────────────────────────────────────────────────────

const INSERT_EVENT_SQL = `
  INSERT INTO events (
    event_id, session_id, turn_id, parent_event_id, timestamp, seq,
    role, event_type, model, cost_usd, cost_method, duration_ms,
    tok_input, tok_output, tok_cache_read, tok_cache_create, tok_reasoning,
    tool_name, tool_status,
    source_json, tokens_json, tool_json, content_json, metadata_json, raw_json
  ) VALUES (
    @event_id, @session_id, @turn_id, @parent_event_id, @timestamp, @seq,
    @role, @event_type, @model, @cost_usd, @cost_method, @duration_ms,
    @tok_input, @tok_output, @tok_cache_read, @tok_cache_create, @tok_reasoning,
    @tool_name, @tool_status,
    @source_json, @tokens_json, @tool_json, @content_json, @metadata_json, @raw_json
  )
  ON CONFLICT(event_id) DO NOTHING
`;

export function insertEvents(
  db: TracebenchDb,
  events: CanonicalEvent[],
  startSeq = 0,
): number {
  if (events.length === 0) return startSeq;
  const stmt = db.raw.prepare(INSERT_EVENT_SQL);
  const tx = db.raw.transaction((batch: CanonicalEvent[], seq0: number) => {
    let seq = seq0;
    for (const e of batch) {
      stmt.run({
        event_id: e.event_id,
        session_id: e.session_id,
        turn_id: e.turn_id,
        parent_event_id: e.parent_event_id,
        timestamp: e.timestamp,
        seq: seq++,
        role: e.role,
        event_type: e.event_type,
        model: e.model,
        cost_usd: e.cost_usd,
        cost_method: e.cost_method,
        duration_ms: e.duration_ms,
        tok_input: e.tokens.input,
        tok_output: e.tokens.output,
        tok_cache_read: e.tokens.cache_read,
        tok_cache_create: e.tokens.cache_creation,
        tok_reasoning: e.tokens.reasoning,
        tool_name: e.tool.name,
        tool_status: e.tool.status,
        source_json: JSON.stringify(e.source),
        tokens_json: JSON.stringify(e.tokens),
        tool_json: JSON.stringify(e.tool),
        content_json: e.content == null ? null : JSON.stringify(e.content),
        metadata_json: JSON.stringify(e.metadata),
        raw_json: JSON.stringify(e.raw),
      });
    }
    return seq;
  });
  return tx(events, startSeq);
}

// ── Context snapshot writes ─────────────────────────────────────────────────

export function upsertContextSnapshot(
  db: TracebenchDb,
  sessionId: string,
  snap: ContextSnapshot,
): void {
  db.raw
    .prepare(
      `INSERT INTO context_snapshots (turn_id, session_id, model, max_context_tokens, components_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET
         model              = excluded.model,
         max_context_tokens = excluded.max_context_tokens,
         components_json    = excluded.components_json`,
    )
    .run(
      snap.turn_id,
      sessionId,
      snap.model,
      snap.max_context_tokens,
      JSON.stringify(snap.components),
    );
}
