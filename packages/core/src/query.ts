// Query API. The server in packages/server is a thin Fastify wrapper over
// these functions. Tests can hit the same functions directly.

import type { TracebenchDb } from './db.js';
import { gunzipSync } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  CanonicalEvent,
  EventTokens,
  EventTool,
  Harness,
  Role,
  EventType,
  Session,
  SessionAggregates,
  SessionWithAggregates,
  Turn,
} from './schema.js';
import { computeCost, loadPricingTable } from './pricing.js';

interface EventRow {
  event_id: string;
  session_id: string;
  turn_id: string;
  parent_event_id: string | null;
  timestamp: string;
  seq: number;
  role: string;
  event_type: string;
  model: string | null;
  cost_usd: number | null;
  cost_method: string | null;
  duration_ms: number | null;
  tok_input: number | null;
  tok_output: number | null;
  tok_cache_read: number | null;
  tok_cache_create: number | null;
  tok_reasoning: number | null;
  tool_name: string | null;
  tool_status: string | null;
  source_json: string;
  tokens_json: string;
  tool_json: string;
  content_json: string | null;
  metadata_json: string;
  raw_json: string;
}

function rowToEvent(db: TracebenchDb, r: EventRow): CanonicalEvent {
  const content = r.content_json == null ? null : resolvePayloadRef(db, JSON.parse(r.content_json));
  const tool = resolveToolPayloadRefs(db, JSON.parse(r.tool_json) as EventTool);
  const raw = resolvePayloadRef(db, JSON.parse(r.raw_json));
  return {
    event_id: r.event_id,
    session_id: r.session_id,
    turn_id: r.turn_id,
    parent_event_id: r.parent_event_id,
    timestamp: r.timestamp,
    source: JSON.parse(r.source_json),
    role: r.role as Role,
    event_type: r.event_type as EventType,
    model: r.model,
    tokens: JSON.parse(r.tokens_json) as EventTokens,
    cost_usd: r.cost_usd,
    cost_method: r.cost_method as CanonicalEvent['cost_method'],
    duration_ms: r.duration_ms,
    content: content as CanonicalEvent['content'],
    tool,
    metadata: JSON.parse(r.metadata_json),
    raw: raw as CanonicalEvent['raw'],
  };
}

interface PayloadRef {
  _tracebench_payload: 'ref';
  payload_id: string;
}

function isPayloadRef(value: unknown): value is PayloadRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tracebench_payload?: unknown })._tracebench_payload === 'ref' &&
    typeof (value as { payload_id?: unknown }).payload_id === 'string'
  );
}

function resolveToolPayloadRefs(db: TracebenchDb, tool: EventTool): EventTool {
  return {
    ...tool,
    input: resolvePayloadRef(db, tool.input) as EventTool['input'],
    output: resolvePayloadRef(db, tool.output) as EventTool['output'],
  };
}

function resolvePayloadRef(db: TracebenchDb, value: unknown): unknown {
  if (!isPayloadRef(value)) return value;
  const row = db.raw
    .prepare('SELECT codec, body FROM event_payloads WHERE payload_id = ?')
    .get(value.payload_id) as { codec: string; body: Buffer } | undefined;
  if (!row) {
    return { ...value, missing: true };
  }
  const body =
    row.codec === 'gzip'
      ? gunzipSync(row.body).toString('utf8')
      : Buffer.from(row.body).toString('utf8');
  return JSON.parse(body);
}

interface SessionRow {
  session_id: string;
  harness: string;
  project_path: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  raw_path: string;
  format_version: string;
  mtime_ms: number;
}

function rowToSession(r: SessionRow): Session {
  return {
    session_id: r.session_id,
    harness: r.harness as Harness,
    project_path: r.project_path,
    title: r.title,
    started_at: r.started_at,
    ended_at: r.ended_at,
    model: r.model,
    raw_path: r.raw_path,
    format_version: r.format_version,
    mtime_ms: r.mtime_ms,
  };
}

export interface ListSessionsOptions {
  harness?: Harness;
  project_path?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

interface SessionWithAggCols extends SessionRow {
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read_tokens: number | null;
  total_cache_create_tokens: number | null;
  total_reasoning_tokens: number | null;
  duration_ms: number | null;
  turn_count: number | null;
  tool_call_count: number | null;
  tool_error_count: number | null;
  message_count: number | null;
}

export function listSessions(
  db: TracebenchDb,
  opts: ListSessionsOptions = {},
): SessionWithAggregates[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.harness) {
    where.push('harness = @harness');
    params.harness = opts.harness;
  }
  if (opts.project_path) {
    where.push('project_path = @project_path');
    params.project_path = opts.project_path;
  }
  if (opts.search) {
    where.push('(title LIKE @q OR project_path LIKE @q OR session_id LIKE @q)');
    params.q = `%${opts.search}%`;
  }
  // Default high enough to cover a normal user's full directory in one request.
  // The UI fetches once and filters client-side, so the API caller wants the
  // full list, not paginated. External callers can still pass a smaller limit.
  const limit = opts.limit ?? 5000;
  const offset = opts.offset ?? 0;
  // Aggregates live on the sessions row (filled by the indexer via
  // summarizeEvents), so the list endpoint is a pure SELECT — no GROUP BY.
  const sql = `
    SELECT * FROM sessions
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = db.raw.prepare(sql).all(params) as SessionWithAggCols[];

  return rows.map((r) => {
    const session = rowToSession(r);
    const aggregates: SessionAggregates = {
      total_cost_usd: r.total_cost_usd ?? 0,
      total_input_tokens: r.total_input_tokens ?? 0,
      total_output_tokens: r.total_output_tokens ?? 0,
      total_cache_read_tokens: r.total_cache_read_tokens ?? 0,
      total_cache_creation_tokens: r.total_cache_create_tokens ?? 0,
      duration_ms: r.duration_ms ?? 0,
      turn_count: r.turn_count ?? 0,
      tool_call_count: r.tool_call_count ?? 0,
      tool_error_count: r.tool_error_count ?? 0,
      message_count: r.message_count ?? 0,
      // List view doesn't need these; getSession() returns them on detail.
      files_touched: [],
      models_used: session.model ? [session.model] : [],
    };
    return { ...session, aggregates };
  });
}

export function getSession(
  db: TracebenchDb,
  sessionId: string,
): SessionWithAggregates | null {
  const row = db.raw
    .prepare('SELECT * FROM sessions WHERE session_id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!row) return null;
  const session = rowToSession(row);
  return { ...session, aggregates: computeSessionAggregates(db, sessionId) };
}

export function getSessionEvents(
  db: TracebenchDb,
  sessionId: string,
): CanonicalEvent[] {
  const rows = db.raw
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as EventRow[];
  return rows.map((r) => rowToEvent(db, r));
}

export interface EventRawResult {
  event: CanonicalEvent;
  raw: unknown;
  provenance:
    | {
        kind: 'stored';
        available: true;
      }
    | {
        kind: 'source_ref';
        available: true;
        raw_path: string;
        line: number;
      }
    | {
        kind: 'source_ref';
        available: false;
        raw_path?: string;
        line?: number;
        reason: string;
      };
}

interface RawSourceRef {
  _tracebench_raw: 'source_ref';
  raw_path?: unknown;
  line?: unknown;
}

function isRawSourceRef(value: unknown): value is RawSourceRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _tracebench_raw?: unknown })._tracebench_raw === 'source_ref'
  );
}

export async function getEventRaw(
  db: TracebenchDb,
  sessionId: string,
  eventId: string,
): Promise<EventRawResult | null> {
  const row = db.raw
    .prepare('SELECT * FROM events WHERE session_id = ? AND event_id = ?')
    .get(sessionId, eventId) as EventRow | undefined;
  if (!row) return null;
  const event = rowToEvent(db, row);
  if (!isRawSourceRef(event.raw)) {
    return {
      event,
      raw: event.raw,
      provenance: { kind: 'stored', available: true },
    };
  }

  const rawPath = typeof event.raw.raw_path === 'string' ? event.raw.raw_path : undefined;
  const line =
    typeof event.raw.line === 'number' && Number.isFinite(event.raw.line)
      ? Math.floor(event.raw.line)
      : undefined;
  if (!rawPath || !line || line < 1) {
    return {
      event,
      raw: event.raw,
      provenance: {
        kind: 'source_ref',
        available: false,
        raw_path: rawPath,
        line,
        reason: 'source locator is not available for this event',
      },
    };
  }

  const sourceLine = await readJsonlLine(rawPath, line);
  if (sourceLine == null) {
    return {
      event,
      raw: event.raw,
      provenance: {
        kind: 'source_ref',
        available: false,
        raw_path: rawPath,
        line,
        reason: 'source file or line is no longer available',
      },
    };
  }

  let parsed: unknown = sourceLine;
  try {
    parsed = JSON.parse(sourceLine);
  } catch {
    // Keep the exact line text if it is not valid JSON.
  }
  return {
    event,
    raw: parsed,
    provenance: {
      kind: 'source_ref',
      available: true,
      raw_path: rawPath,
      line,
    },
  };
}

async function readJsonlLine(path: string, targetLine: number): Promise<string | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8' });
    stream.on('error', () => resolve(null));
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    rl.on('line', (line) => {
      lineNo++;
      if (lineNo === targetLine) {
        rl.close();
        stream.destroy();
        resolve(line);
      }
    });
    rl.on('close', () => {
      if (lineNo < targetLine) resolve(null);
    });
  });
}

export function getSessionTurns(db: TracebenchDb, sessionId: string): Turn[] {
  const events = getSessionEvents(db, sessionId);
  const byTurn = new Map<string, CanonicalEvent[]>();
  for (const e of events) {
    let arr = byTurn.get(e.turn_id);
    if (!arr) {
      arr = [];
      byTurn.set(e.turn_id, arr);
    }
    arr.push(e);
  }
  const turns: Turn[] = [];
  for (const [turn_id, arr] of byTurn) {
    turns.push({
      turn_id,
      session_id: sessionId,
      started_at: arr[0]!.timestamp,
      ended_at: arr[arr.length - 1]!.timestamp,
      events: arr,
    });
  }
  return turns;
}

// ── Aggregates ──────────────────────────────────────────────────────────────

interface AggregateRow {
  total_cost: number | null;
  tok_input: number | null;
  tok_output: number | null;
  tok_cache_read: number | null;
  tok_cache_create: number | null;
  tok_reasoning: number | null;
  duration_ms: number | null;
  turn_count: number;
  tool_call_count: number;
  tool_error_count: number;
  message_count: number;
  first_ts: string | null;
  last_ts: string | null;
}

export function computeSessionAggregates(
  db: TracebenchDb,
  sessionId: string,
): SessionAggregates {
  const row = db.raw
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0)            AS total_cost,
         COALESCE(SUM(tok_input), 0)           AS tok_input,
         COALESCE(SUM(tok_output), 0)          AS tok_output,
         COALESCE(SUM(tok_cache_read), 0)      AS tok_cache_read,
         COALESCE(SUM(tok_cache_create), 0)    AS tok_cache_create,
         COALESCE(SUM(tok_reasoning), 0)       AS tok_reasoning,
         COALESCE(SUM(duration_ms), 0)         AS duration_ms,
         COUNT(DISTINCT turn_id)               AS turn_count,
         SUM(CASE WHEN event_type = 'tool_call' THEN 1 ELSE 0 END) AS tool_call_count,
         SUM(CASE WHEN tool_status = 'error' THEN 1 ELSE 0 END)    AS tool_error_count,
         SUM(CASE WHEN event_type = 'message' THEN 1 ELSE 0 END)   AS message_count,
         MIN(timestamp) AS first_ts,
         MAX(timestamp) AS last_ts
       FROM events WHERE session_id = ?`,
    )
    .get(sessionId) as AggregateRow;

  // If costs weren't precomputed at insert time, fall back to recomputing
  // from token columns. Cheap because aggregates are small.
  let totalCost = row.total_cost ?? 0;
  if (totalCost === 0) {
    const tbl = loadPricingTable();
    const events = db.raw
      .prepare(
        'SELECT model, tok_input, tok_output, tok_cache_read, tok_cache_create, tok_reasoning FROM events WHERE session_id = ?',
      )
      .all(sessionId) as Array<{
      model: string | null;
      tok_input: number | null;
      tok_output: number | null;
      tok_cache_read: number | null;
      tok_cache_create: number | null;
      tok_reasoning: number | null;
    }>;
    for (const e of events) {
      const r = computeCost({
        model: e.model,
        tokens: {
          input: e.tok_input,
          output: e.tok_output,
          cache_read: e.tok_cache_read,
          cache_creation: e.tok_cache_create,
          reasoning: e.tok_reasoning,
        },
        table: tbl,
      });
      totalCost += r.usd;
    }
  }

  // distinct models + files touched
  const models = (
    db.raw
      .prepare(
        "SELECT DISTINCT model FROM events WHERE session_id = ? AND model IS NOT NULL",
      )
      .all(sessionId) as { model: string }[]
  ).map((r) => r.model);

  const fileRows = db.raw
    .prepare(
      `SELECT DISTINCT json_extract(tool_json, '$.input.file_path') AS f
         FROM events
         WHERE session_id = ?
           AND tool_name IN ('Edit', 'Write', 'Read')
           AND json_extract(tool_json, '$.input.file_path') IS NOT NULL`,
    )
    .all(sessionId) as { f: string | null }[];
  const filesTouched = fileRows.map((r) => r.f).filter((x): x is string => !!x);

  let durationMs = row.duration_ms ?? 0;
  if (durationMs === 0 && row.first_ts && row.last_ts) {
    durationMs = Math.max(
      0,
      new Date(row.last_ts).getTime() - new Date(row.first_ts).getTime(),
    );
  }

  return {
    total_cost_usd: totalCost,
    total_input_tokens: row.tok_input ?? 0,
    total_output_tokens: row.tok_output ?? 0,
    total_cache_read_tokens: row.tok_cache_read ?? 0,
    total_cache_creation_tokens: row.tok_cache_create ?? 0,
    duration_ms: durationMs,
    turn_count: row.turn_count,
    tool_call_count: row.tool_call_count,
    tool_error_count: row.tool_error_count,
    message_count: row.message_count,
    files_touched: filesTouched,
    models_used: models,
  };
}

export interface ToolCountRow {
  tool_name: string;
  count: number;
  errors: number;
}

export function getToolCounts(
  db: TracebenchDb,
  sessionId: string,
): ToolCountRow[] {
  return db.raw
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS count,
              SUM(CASE WHEN tool_status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM events
         WHERE session_id = ? AND tool_name IS NOT NULL
         GROUP BY tool_name
         ORDER BY count DESC`,
    )
    .all(sessionId) as ToolCountRow[];
}
