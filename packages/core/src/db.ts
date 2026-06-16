// SQLite storage layer. better-sqlite3 chosen for sync API + zero setup.
//
// Schema notes:
// - events.* columns mirror the canonical event shape; complex fields
//   (tokens, tool, metadata, raw, content-if-object) are stored as JSON text
// - context_snapshots stores per-turn snapshots from PRD §8. v0.1 will not
//   populate this table; it exists so v0.3's context analyzer can land without
//   a migration.

import Database, { type Database as DB } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import type {
  CanonicalEvent,
  ContextSnapshot,
  DiscoveredSession,
  DiscoveredSessionIndexState,
  Harness,
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
  {
    version: 2,
    name: 'precomputed_session_aggregates',
    sql: `
      ALTER TABLE sessions ADD COLUMN total_cost_usd           REAL;
      ALTER TABLE sessions ADD COLUMN total_input_tokens       INTEGER;
      ALTER TABLE sessions ADD COLUMN total_output_tokens      INTEGER;
      ALTER TABLE sessions ADD COLUMN total_cache_read_tokens  INTEGER;
      ALTER TABLE sessions ADD COLUMN total_cache_create_tokens INTEGER;
      ALTER TABLE sessions ADD COLUMN total_reasoning_tokens   INTEGER;
      ALTER TABLE sessions ADD COLUMN duration_ms              INTEGER;
      ALTER TABLE sessions ADD COLUMN turn_count               INTEGER;
      ALTER TABLE sessions ADD COLUMN tool_call_count          INTEGER;
      ALTER TABLE sessions ADD COLUMN tool_error_count         INTEGER;
      ALTER TABLE sessions ADD COLUMN message_count            INTEGER;
    `,
  },
  {
    version: 3,
    name: 'discovered_sessions_manifest',
    sql: `
      CREATE TABLE discovered_sessions (
        harness        TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        raw_path       TEXT NOT NULL,
        format_version TEXT NOT NULL,
        source_size    INTEGER NOT NULL,
        mtime_ms       INTEGER NOT NULL,
        index_state    TEXT NOT NULL DEFAULT 'discovered',
        indexed_at     TEXT,
        error_message  TEXT,
        PRIMARY KEY (harness, raw_path)
      );

      CREATE INDEX discovered_sessions_by_harness
        ON discovered_sessions(harness);
      CREATE INDEX discovered_sessions_by_state
        ON discovered_sessions(index_state);
      CREATE INDEX discovered_sessions_by_mtime
        ON discovered_sessions(mtime_ms DESC);
      CREATE INDEX discovered_sessions_by_session
        ON discovered_sessions(harness, session_id);
    `,
  },
  {
    version: 4,
    name: 'external_event_payloads',
    sql: `
      CREATE TABLE event_payloads (
        payload_id  TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        codec       TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        hash        TEXT NOT NULL,
        body        BLOB NOT NULL
      );

      CREATE INDEX event_payloads_by_hash
        ON event_payloads(hash, byte_length);

      CREATE TABLE event_payload_refs (
        event_id   TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
        field      TEXT NOT NULL,
        payload_id TEXT NOT NULL REFERENCES event_payloads(payload_id),
        PRIMARY KEY (event_id, field)
      );

      CREATE INDEX event_payload_refs_by_payload
        ON event_payload_refs(payload_id);
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

/**
 * Pre-computed-aggregate fields the indexer can attach to a session row to
 * avoid a runtime GROUP BY over events. All fields are optional; null/missing
 * means "compute on demand."
 */
export interface SessionAggregateRow {
  total_cost_usd?: number | null;
  total_input_tokens?: number | null;
  total_output_tokens?: number | null;
  total_cache_read_tokens?: number | null;
  total_cache_create_tokens?: number | null;
  total_reasoning_tokens?: number | null;
  duration_ms?: number | null;
  turn_count?: number | null;
  tool_call_count?: number | null;
  tool_error_count?: number | null;
  message_count?: number | null;
}

export function upsertSession(
  db: TracebenchDb,
  s: Session,
  agg?: SessionAggregateRow,
): void {
  db.raw
    .prepare(
      `INSERT INTO sessions (
         session_id, harness, project_path, title, started_at, ended_at,
         model, raw_path, format_version, mtime_ms,
         total_cost_usd, total_input_tokens, total_output_tokens,
         total_cache_read_tokens, total_cache_create_tokens, total_reasoning_tokens,
         duration_ms, turn_count, tool_call_count, tool_error_count, message_count
       ) VALUES (
         @session_id, @harness, @project_path, @title, @started_at, @ended_at,
         @model, @raw_path, @format_version, @mtime_ms,
         @total_cost_usd, @total_input_tokens, @total_output_tokens,
         @total_cache_read_tokens, @total_cache_create_tokens, @total_reasoning_tokens,
         @duration_ms, @turn_count, @tool_call_count, @tool_error_count, @message_count
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
         mtime_ms        = excluded.mtime_ms,
         total_cost_usd          = excluded.total_cost_usd,
         total_input_tokens      = excluded.total_input_tokens,
         total_output_tokens     = excluded.total_output_tokens,
         total_cache_read_tokens = excluded.total_cache_read_tokens,
         total_cache_create_tokens = excluded.total_cache_create_tokens,
         total_reasoning_tokens  = excluded.total_reasoning_tokens,
         duration_ms             = excluded.duration_ms,
         turn_count              = excluded.turn_count,
         tool_call_count         = excluded.tool_call_count,
         tool_error_count        = excluded.tool_error_count,
         message_count           = excluded.message_count`,
    )
    .run({
      ...s,
      title: s.title ?? null,
      ended_at: s.ended_at ?? null,
      model: s.model ?? null,
      total_cost_usd: agg?.total_cost_usd ?? null,
      total_input_tokens: agg?.total_input_tokens ?? null,
      total_output_tokens: agg?.total_output_tokens ?? null,
      total_cache_read_tokens: agg?.total_cache_read_tokens ?? null,
      total_cache_create_tokens: agg?.total_cache_create_tokens ?? null,
      total_reasoning_tokens: agg?.total_reasoning_tokens ?? null,
      duration_ms: agg?.duration_ms ?? null,
      turn_count: agg?.turn_count ?? null,
      tool_call_count: agg?.tool_call_count ?? null,
      tool_error_count: agg?.tool_error_count ?? null,
      message_count: agg?.message_count ?? null,
    });
}

export function deleteSessionEvents(db: TracebenchDb, sessionId: string): void {
  db.raw.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  db.raw
    .prepare('DELETE FROM context_snapshots WHERE session_id = ?')
    .run(sessionId);
  db.raw
    .prepare(
      `DELETE FROM event_payloads
       WHERE NOT EXISTS (
         SELECT 1 FROM event_payload_refs
         WHERE event_payload_refs.payload_id = event_payloads.payload_id
       )`,
    )
    .run();
}

// ── Discovered session manifest ─────────────────────────────────────────────

export interface UpsertDiscoveredSessionInput {
  harness: Harness;
  session_id: string;
  raw_path: string;
  format_version: string;
  source_size: number;
  mtime_ms: number;
}

const UPSERT_DISCOVERED_SQL = `
  INSERT INTO discovered_sessions (
    harness, session_id, raw_path, format_version, source_size, mtime_ms,
    index_state, indexed_at, error_message
  ) VALUES (
    @harness, @session_id, @raw_path, @format_version, @source_size, @mtime_ms,
    'discovered', NULL, NULL
  )
  ON CONFLICT(harness, raw_path) DO UPDATE SET
    session_id     = excluded.session_id,
    format_version = excluded.format_version,
    source_size    = excluded.source_size,
    mtime_ms       = excluded.mtime_ms,
    index_state    = CASE
      WHEN discovered_sessions.mtime_ms = excluded.mtime_ms
       AND discovered_sessions.index_state IN ('hot', 'warm', 'raw_archived')
      THEN discovered_sessions.index_state
      ELSE 'discovered'
    END,
    indexed_at = CASE
      WHEN discovered_sessions.mtime_ms = excluded.mtime_ms
       AND discovered_sessions.index_state IN ('hot', 'warm', 'raw_archived')
      THEN discovered_sessions.indexed_at
      ELSE NULL
    END,
    error_message = NULL
`;

export function upsertDiscoveredSession(
  db: TracebenchDb,
  input: UpsertDiscoveredSessionInput,
): void {
  db.raw.prepare(UPSERT_DISCOVERED_SQL).run(input);
}

export function markDiscoveredSessionIndexed(
  db: TracebenchDb,
  harness: Harness,
  rawPath: string,
  state: DiscoveredSessionIndexState = 'hot',
): void {
  db.raw
    .prepare(
      `UPDATE discovered_sessions
       SET index_state = ?, indexed_at = datetime('now'), error_message = NULL
       WHERE harness = ? AND raw_path = ?`,
    )
    .run(state, harness, rawPath);
}

export function markDiscoveredSessionError(
  db: TracebenchDb,
  harness: Harness,
  rawPath: string,
  message: string,
): void {
  db.raw
    .prepare(
      `UPDATE discovered_sessions
       SET index_state = 'error', error_message = ?
       WHERE harness = ? AND raw_path = ?`,
    )
    .run(message, harness, rawPath);
}

export function getDiscoveredSession(
  db: TracebenchDb,
  harness: Harness,
  rawPath: string,
): DiscoveredSession | null {
  const row = db.raw
    .prepare('SELECT * FROM discovered_sessions WHERE harness = ? AND raw_path = ?')
    .get(harness, rawPath) as DiscoveredSession | undefined;
  return row ?? null;
}

export function listDiscoveredSessions(
  db: TracebenchDb,
  opts: { harness?: Harness; session_id?: string } = {},
): DiscoveredSession[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.harness) {
    where.push('harness = @harness');
    params.harness = opts.harness;
  }
  if (opts.session_id) {
    where.push('session_id = @session_id');
    params.session_id = opts.session_id;
  }
  const rows = db.raw
    .prepare(
      `SELECT * FROM discovered_sessions
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY mtime_ms DESC`,
    )
    .all(params) as DiscoveredSession[];
  return rows;
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
  options: {
    rawMode?: 'full' | 'reference';
    payloadMode?: 'inline' | 'external';
    payloadThresholdBytes?: number;
  } = {},
): number {
  if (events.length === 0) return startSeq;
  const stmt = db.raw.prepare(INSERT_EVENT_SQL);
  const payloadMode = options.payloadMode ?? 'inline';
  const payloadThresholdBytes = options.payloadThresholdBytes ?? 64 * 1024;
  const tx = db.raw.transaction((batch: CanonicalEvent[], seq0: number) => {
    let seq = seq0;
    for (const e of batch) {
      const content = maybeExternalizePayload(db, 'content', e.content, {
        payloadMode,
        payloadThresholdBytes,
      });
      const tool = maybeExternalizeTool(db, e, {
        payloadMode,
        payloadThresholdBytes,
      });
      const raw =
        options.rawMode === 'reference'
          ? rawReferenceForEvent(e)
          : maybeExternalizePayload(db, 'raw', e.raw, {
              payloadMode,
              payloadThresholdBytes,
            });
      const info = stmt.run({
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
        tool_json: JSON.stringify(tool),
        content_json: content == null ? null : JSON.stringify(content),
        metadata_json: JSON.stringify(e.metadata),
        raw_json: JSON.stringify(raw),
      });
      if (info.changes > 0) {
        insertPayloadRefsForEvent(db, e.event_id, content, tool, raw);
      }
    }
    return seq;
  });
  return tx(events, startSeq);
}

export interface EventPayloadReference {
  _tracebench_payload: 'ref';
  payload_id: string;
  kind: string;
  byte_length: number;
  codec: 'gzip';
}

interface PayloadExternalizeOptions {
  payloadMode: 'inline' | 'external';
  payloadThresholdBytes: number;
}

function maybeExternalizeTool(
  db: TracebenchDb,
  e: CanonicalEvent,
  opts: PayloadExternalizeOptions,
): CanonicalEvent['tool'] {
  const input = maybeExternalizePayload(db, 'tool_input', e.tool.input, opts);
  const output = maybeExternalizePayload(db, 'tool_output', e.tool.output, opts);
  if (input === e.tool.input && output === e.tool.output) return e.tool;
  return { ...e.tool, input, output } as CanonicalEvent['tool'];
}

function maybeExternalizePayload<T>(
  db: TracebenchDb,
  field: string,
  value: T,
  opts: PayloadExternalizeOptions,
): T | EventPayloadReference {
  if (opts.payloadMode !== 'external' || value == null) return value;
  const text = JSON.stringify(value);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= opts.payloadThresholdBytes) return value;

  const hash = createHash('sha256').update(text).digest('hex');
  const payloadId = createHash('sha256')
    .update(field)
    .update('\0')
    .update(hash)
    .digest('hex');
  const body = gzipSync(Buffer.from(text, 'utf8'));

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO event_payloads
         (payload_id, kind, codec, byte_length, hash, body)
       VALUES (?, ?, 'gzip', ?, ?, ?)`,
    )
    .run(payloadId, field, byteLength, hash, body);

  return {
    _tracebench_payload: 'ref',
    payload_id: payloadId,
    kind: field,
    byte_length: byteLength,
    codec: 'gzip',
  };
}

function insertPayloadRefsForEvent(
  db: TracebenchDb,
  eventId: string,
  content: unknown,
  tool: CanonicalEvent['tool'],
  raw: unknown,
): void {
  insertPayloadRef(db, eventId, 'content', content);
  insertPayloadRef(db, eventId, 'tool_input', tool.input);
  insertPayloadRef(db, eventId, 'tool_output', tool.output);
  insertPayloadRef(db, eventId, 'raw', raw);
}

function insertPayloadRef(
  db: TracebenchDb,
  eventId: string,
  field: string,
  value: unknown,
): void {
  if (!isEventPayloadReference(value)) return;
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO event_payload_refs
         (event_id, field, payload_id)
       VALUES (?, ?, ?)`,
    )
    .run(eventId, field, value.payload_id);
}

function isEventPayloadReference(value: unknown): value is EventPayloadReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tracebench_payload?: unknown })._tracebench_payload === 'ref' &&
    typeof (value as { payload_id?: unknown }).payload_id === 'string'
  );
}

function rawReferenceForEvent(e: CanonicalEvent): Record<string, unknown> {
  return {
    _tracebench_raw: 'source_ref',
    raw_path: e.source.raw_path,
    harness: e.source.harness,
    event_id: e.event_id,
    timestamp: e.timestamp,
  };
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
