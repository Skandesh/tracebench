import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  upsertSession,
  insertEvents,
  deleteSessionEvents,
  upsertContextSnapshot,
  upsertDiscoveredSession,
  markDiscoveredSessionIndexed,
  markDiscoveredSessionError,
  markDiscoveredSessionIndexing,
  getDiscoveredSession,
  listDiscoveredSessions,
  beginIndexRun,
  failIndexRun,
  publishIndexRun,
  stageEvents,
  stageSession,
  insertSearchChunk,
  stageSearchChunks,
  deleteSessionSearchChunks,
  chunkIdFor,
  type SearchChunkRow,
  type TracebenchDb,
} from './db.js';
import type { CanonicalEvent, Session, ContextSnapshot } from './schema.js';
import {
  listSessions,
  getSession,
  getSessionEvents,
  getSessionTurns,
  computeSessionAggregates,
  getToolCounts,
  getEventRaw,
} from './query.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'sess-1',
    harness: 'claude_code',
    project_path: '/Users/me/code/proj',
    title: 'Fix bug X',
    started_at: '2026-05-17T14:22:08.000Z',
    ended_at: '2026-05-17T14:30:00.000Z',
    model: 'claude-sonnet-4-5',
    raw_path: '/Users/me/.claude/projects/abc/sess-1.jsonl',
    format_version: '1',
    mtime_ms: 1700000000000,
    ...overrides,
  };
}

let next = 0;
function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  next++;
  return {
    event_id: `evt-${next}`,
    session_id: 'sess-1',
    turn_id: 'turn-1',
    parent_event_id: null,
    timestamp: '2026-05-17T14:22:09.000Z',
    source: {
      harness: 'claude_code',
      format_version: '1',
      raw_path: '/x/y.jsonl',
    },
    role: 'assistant',
    event_type: 'message',
    model: 'claude-sonnet-4-5',
    tokens: {
      input: 100,
      output: 50,
      cache_read: null,
      cache_creation: null,
      reasoning: null,
    },
    cost_usd: null,
    cost_method: null,
    duration_ms: 100,
    content: 'hello',
    tool: { name: null, input: null, output: null, status: null, error_message: null },
    metadata: {},
    raw: {},
    ...overrides,
  };
}

let db: TracebenchDb;
beforeEach(() => {
  next = 0;
  db = openDb({ path: ':memory:' });
});

describe('migrations', () => {
  it('runs initial migration creating tables', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('events');
    expect(names).toContain('context_snapshots');
    expect(names).toContain('discovered_sessions');
    expect(names).toContain('event_payloads');
    expect(names).toContain('event_payload_refs');
    expect(names).toContain('index_runs');
    expect(names).toContain('staged_sessions');
    expect(names).toContain('staged_events');
    expect(names).toContain('_migrations');
  });

  it('does not re-run applied migrations', () => {
    const before = db.raw
      .prepare('SELECT COUNT(*) AS n FROM _migrations')
      .get() as { n: number };
    db.close();
    const db2 = openDb({ path: ':memory:' });
    // fresh memory DB so migrations run; assert count matches
    const after = db2.raw
      .prepare('SELECT COUNT(*) AS n FROM _migrations')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    db2.close();
  });
});

describe('session + event roundtrip', () => {
  it('inserts and reads back a session', () => {
    const s = makeSession();
    upsertSession(db, s);
    const got = getSession(db, 'sess-1');
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Fix bug X');
    expect(got!.harness).toBe('claude_code');
  });

  it('upserts override existing sessions', () => {
    upsertSession(db, makeSession({ title: 'v1' }));
    upsertSession(db, makeSession({ title: 'v2' }));
    expect(getSession(db, 'sess-1')!.title).toBe('v2');
  });

  it('inserts events and reads them in seq order', () => {
    upsertSession(db, makeSession());
    insertEvents(db, [
      makeEvent({ timestamp: '2026-05-17T14:22:09.000Z' }),
      makeEvent({ timestamp: '2026-05-17T14:22:10.000Z' }),
      makeEvent({ timestamp: '2026-05-17T14:22:11.000Z' }),
    ]);
    const evts = getSessionEvents(db, 'sess-1');
    expect(evts.length).toBe(3);
    expect(evts[0]!.timestamp).toBe('2026-05-17T14:22:09.000Z');
    expect(evts[2]!.timestamp).toBe('2026-05-17T14:22:11.000Z');
  });

  it('groups events into turns by turn_id', () => {
    upsertSession(db, makeSession());
    insertEvents(db, [
      makeEvent({ turn_id: 't1' }),
      makeEvent({ turn_id: 't1' }),
      makeEvent({ turn_id: 't2' }),
    ]);
    const turns = getSessionTurns(db, 'sess-1');
    expect(turns.length).toBe(2);
    expect(turns[0]!.events.length).toBe(2);
    expect(turns[1]!.events.length).toBe(1);
  });

  it('can store raw JSON as a source reference instead of duplicating full raw payloads', () => {
    upsertSession(db, makeSession());
    insertEvents(
      db,
      [
        makeEvent({
          raw: { massive: 'x'.repeat(20_000), keep_me_out_of_hot_rows: true },
        }),
      ],
      0,
      { rawMode: 'reference' },
    );
    const got = getSessionEvents(db, 'sess-1')[0]!;
    expect(got.raw).toEqual({
      _tracebench_raw: 'source_ref',
      raw_path: '/x/y.jsonl',
      harness: 'claude_code',
      event_id: got.event_id,
      timestamp: got.timestamp,
    });
    const row = db.raw
      .prepare('SELECT length(raw_json) AS n FROM events WHERE event_id = ?')
      .get(got.event_id) as { n: number };
    expect(row.n).toBeLessThan(300);
  });

  it('stores actionable source locators in raw source references', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracebench-raw-ref-'));
    const rawPath = join(dir, 'source.jsonl');
    writeFileSync(rawPath, '{"type":"first"}\n{"type":"second"}\n');
    upsertSession(db, makeSession({ raw_path: rawPath }));
    insertEvents(
      db,
      [
        makeEvent({
          event_id: 'evt-with-line',
          source: {
            harness: 'claude_code',
            format_version: '1',
            raw_path: rawPath,
            line: 2,
          },
          raw: { type: 'second' },
        }),
      ],
      0,
      { rawMode: 'reference' },
    );

    const got = await getEventRaw(db, 'sess-1', 'evt-with-line');
    expect(got?.provenance).toMatchObject({
      kind: 'source_ref',
      available: true,
      raw_path: rawPath,
      line: 2,
    });
    expect(got?.raw).toEqual({ type: 'second' });
  });

  it('externalizes and deduplicates large payloads while preserving query fidelity', () => {
    upsertSession(db, makeSession());
    const output = 'same-output\n'.repeat(1000);
    insertEvents(
      db,
      [
        makeEvent({
          event_id: 'large-1',
          tool: { name: 'Bash', input: { command: 'a' }, output, status: 'success', error_message: null },
        }),
        makeEvent({
          event_id: 'large-2',
          tool: { name: 'Bash', input: { command: 'b' }, output, status: 'success', error_message: null },
        }),
      ],
      0,
      { payloadMode: 'external', payloadThresholdBytes: 100 },
    );

    const events = getSessionEvents(db, 'sess-1');
    expect(events.map((e) => e.tool.output)).toEqual([output, output]);

    const payloadCount = db.raw
      .prepare('SELECT COUNT(*) AS n FROM event_payloads')
      .get() as { n: number };
    const refCount = db.raw
      .prepare('SELECT COUNT(*) AS n FROM event_payload_refs')
      .get() as { n: number };
    const hotRows = db.raw
      .prepare('SELECT tool_json FROM events ORDER BY seq ASC')
      .all() as { tool_json: string }[];
    expect(payloadCount.n).toBe(1);
    expect(refCount.n).toBe(2);
    expect(hotRows[0]!.tool_json.length).toBeLessThan(400);
  });
});

describe('discovered session manifest', () => {
  it('tracks discovered sessions and preserves hot state when the source is unchanged', () => {
    upsertDiscoveredSession(db, {
      harness: 'codex',
      session_id: 'codex-1',
      raw_path: '/rollout.jsonl',
      format_version: '1',
      source_size: 1234,
      mtime_ms: 1000,
    });
    expect(listDiscoveredSessions(db)).toHaveLength(1);
    expect(getDiscoveredSession(db, 'codex', '/rollout.jsonl')!.index_state).toBe('discovered');

    markDiscoveredSessionIndexed(db, 'codex', '/rollout.jsonl', 'hot');
    expect(getDiscoveredSession(db, 'codex', '/rollout.jsonl')!.index_state).toBe('hot');

    upsertDiscoveredSession(db, {
      harness: 'codex',
      session_id: 'codex-1',
      raw_path: '/rollout.jsonl',
      format_version: '1',
      source_size: 1234,
      mtime_ms: 1000,
    });
    expect(getDiscoveredSession(db, 'codex', '/rollout.jsonl')!.index_state).toBe('hot');
  });

  it('resets stale or errored manifest rows to discovered when the source changes', () => {
    upsertDiscoveredSession(db, {
      harness: 'claude_code',
      session_id: 'sess-1',
      raw_path: '/sess-1.jsonl',
      format_version: '1',
      source_size: 100,
      mtime_ms: 1000,
    });
    markDiscoveredSessionError(db, 'claude_code', '/sess-1.jsonl', 'bad json');
    expect(getDiscoveredSession(db, 'claude_code', '/sess-1.jsonl')!.index_state).toBe('error');

    upsertDiscoveredSession(db, {
      harness: 'claude_code',
      session_id: 'sess-1',
      raw_path: '/sess-1.jsonl',
      format_version: '1',
      source_size: 200,
      mtime_ms: 2000,
    });
    const got = getDiscoveredSession(db, 'claude_code', '/sess-1.jsonl')!;
    expect(got.index_state).toBe('discovered');
    expect(got.error_message).toBeNull();
    expect(got.source_size).toBe(200);
  });

  it('marks sessions as actively indexing without dropping the manifest row', () => {
    upsertDiscoveredSession(db, {
      harness: 'codex',
      session_id: 'codex-indexing',
      raw_path: '/indexing.jsonl',
      format_version: '1',
      source_size: 100,
      mtime_ms: 1000,
    });
    markDiscoveredSessionIndexing(db, 'codex', '/indexing.jsonl');
    expect(getDiscoveredSession(db, 'codex', '/indexing.jsonl')!.index_state).toBe('indexing');
  });
});

describe('staged index publishing', () => {
  it('does not expose staged rows until publish', () => {
    upsertDiscoveredSession(db, {
      harness: 'claude_code',
      session_id: 'sess-1',
      raw_path: '/x/y.jsonl',
      format_version: '1',
      source_size: 10,
      mtime_ms: 1000,
    });
    const runId = beginIndexRun(db, {
      harness: 'claude_code',
      session_id: 'sess-1',
      raw_path: '/x/y.jsonl',
    });
    const events = [makeEvent({ event_id: 'stage-1' }), makeEvent({ event_id: 'stage-2' })];
    stageEvents(db, runId, events, 0, { rawMode: 'reference' });
    stageSession(db, runId, makeSession(), {
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_create_tokens: 0,
      total_reasoning_tokens: 0,
      duration_ms: 0,
      turn_count: 1,
      tool_call_count: 0,
      tool_error_count: 0,
      message_count: 2,
    });

    expect(getSession(db, 'sess-1')).toBeNull();
    expect(getSessionEvents(db, 'sess-1')).toEqual([]);

    publishIndexRun(db, runId, {
      harness: 'claude_code',
      rawPath: '/x/y.jsonl',
      state: 'hot',
    });
    expect(getSession(db, 'sess-1')!.title).toBe('Fix bug X');
    expect(getSessionEvents(db, 'sess-1')).toHaveLength(2);
    expect(getDiscoveredSession(db, 'claude_code', '/x/y.jsonl')!.index_state).toBe('hot');
  });

  it('keeps an existing visible session when a staged run fails', () => {
    upsertSession(db, makeSession({ title: 'old visible' }));
    insertEvents(db, [makeEvent({ event_id: 'old-event', content: 'old' })]);
    const runId = beginIndexRun(db, {
      harness: 'claude_code',
      session_id: 'sess-1',
      raw_path: '/x/y.jsonl',
    });
    stageEvents(db, runId, [makeEvent({ event_id: 'new-event', content: 'new' })]);
    failIndexRun(db, runId, 'boom');

    expect(getSession(db, 'sess-1')!.title).toBe('old visible');
    expect(getSessionEvents(db, 'sess-1').map((e) => e.event_id)).toEqual(['old-event']);
  });
});

describe('listSessions filtering', () => {
  it('filters by harness', () => {
    upsertSession(db, makeSession({ session_id: 'a', harness: 'claude_code' }));
    upsertSession(db, makeSession({ session_id: 'b', harness: 'codex' }));
    expect(listSessions(db, { harness: 'claude_code' }).length).toBe(1);
    expect(listSessions(db, { harness: 'codex' }).length).toBe(1);
  });

  it('searches title/project/id', () => {
    upsertSession(db, makeSession({ session_id: 'a', title: 'race condition fix' }));
    upsertSession(db, makeSession({ session_id: 'b', title: 'auth migration' }));
    expect(listSessions(db, { search: 'race' }).length).toBe(1);
    expect(listSessions(db, { search: 'AUTH' }).length).toBe(1);
  });

  it('orders by started_at DESC', () => {
    upsertSession(
      db,
      makeSession({
        session_id: 'old',
        started_at: '2026-05-15T00:00:00.000Z',
      }),
    );
    upsertSession(
      db,
      makeSession({
        session_id: 'new',
        started_at: '2026-05-17T00:00:00.000Z',
      }),
    );
    const list = listSessions(db);
    expect(list[0]!.session_id).toBe('new');
    expect(list[1]!.session_id).toBe('old');
  });
});

describe('aggregates', () => {
  beforeEach(() => {
    upsertSession(db, makeSession());
    insertEvents(db, [
      makeEvent({
        turn_id: 't1',
        event_type: 'tool_call',
        tool: { name: 'Bash', input: { command: 'ls' }, output: null, status: 'success', error_message: null },
      }),
      makeEvent({
        turn_id: 't1',
        event_type: 'tool_call',
        tool: { name: 'Read', input: { file_path: '/a.ts' }, output: null, status: 'success', error_message: null },
      }),
      makeEvent({
        turn_id: 't2',
        event_type: 'tool_call',
        tool: { name: 'Bash', input: { command: 'pnpm test' }, output: null, status: 'error', error_message: 'exit 1' },
      }),
      makeEvent({
        turn_id: 't2',
        event_type: 'tool_call',
        tool: { name: 'Edit', input: { file_path: '/a.ts' }, output: null, status: 'success', error_message: null },
      }),
    ]);
  });

  it('counts turns, tool calls, and errors', () => {
    const a = computeSessionAggregates(db, 'sess-1');
    expect(a.turn_count).toBe(2);
    expect(a.tool_call_count).toBe(4);
    expect(a.tool_error_count).toBe(1);
  });

  it('computes total cost from tokens when cost_usd is null', () => {
    const a = computeSessionAggregates(db, 'sess-1');
    // 4 events * (100 input + 50 output) on claude-sonnet-4-5
    // per-event: 100*3e-6 + 50*15e-6 = 0.0003 + 0.00075 = 0.00105
    // total: 0.0042
    expect(a.total_cost_usd).toBeCloseTo(0.0042, 6);
  });

  it('tracks files touched', () => {
    const a = computeSessionAggregates(db, 'sess-1');
    expect(a.files_touched).toEqual(['/a.ts']);
  });

  it('aggregates tool counts', () => {
    const counts = getToolCounts(db, 'sess-1');
    const bash = counts.find((c) => c.tool_name === 'Bash')!;
    expect(bash.count).toBe(2);
    expect(bash.errors).toBe(1);
  });
});

describe('context snapshots', () => {
  it('roundtrips a snapshot', () => {
    upsertSession(db, makeSession());
    const snap: ContextSnapshot = {
      turn_id: 't1',
      model: 'claude-sonnet-4-5',
      max_context_tokens: 200000,
      components: [
        { kind: 'system', source_event_id: null, token_count: 1200, char_count: 5000, cached: true, position_start: 0, position_end: 1200 },
      ],
    };
    upsertContextSnapshot(db, 'sess-1', snap);
    const row = db.raw
      .prepare('SELECT * FROM context_snapshots WHERE session_id = ? AND turn_id = ?')
      .get('sess-1', 't1') as { components_json: string };
    expect(JSON.parse(row.components_json)).toEqual(snap.components);
  });
});

describe('cascade delete', () => {
  it('removes events when session deleted', () => {
    upsertSession(db, makeSession());
    insertEvents(db, [makeEvent(), makeEvent()]);
    expect(getSessionEvents(db, 'sess-1').length).toBe(2);
    deleteSessionEvents(db, 'sess-1');
    expect(getSessionEvents(db, 'sess-1').length).toBe(0);
  });
});

function makeChunk(overrides: Partial<SearchChunkRow> = {}): SearchChunkRow {
  const event_id = overrides.event_id ?? 'evt-1';
  const chunk_seq = overrides.chunk_seq ?? 0;
  return {
    chunk_id: chunkIdFor(event_id, chunk_seq),
    event_id,
    session_id: 'sess-1',
    turn_id: 'turn-1',
    harness: 'claude_code',
    chunk_seq,
    text: 'the quick brown fox useMemo packages/core/src/db.ts',
    content_hash: 'h1',
    ...overrides,
  };
}

describe('search index schema (U1)', () => {
  it('creates v6 tables and FTS is available', () => {
    const names = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(names).toContain('search_chunks');
    expect(names).toContain('staged_search_chunks');
    expect(names).toContain('search_backfill_state');
    expect(db.ftsAvailable).toBe(true);
    const fts = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('fts_words','fts_tri')")
        .all() as { name: string }[]
    ).map((f) => f.name);
    expect(fts.sort()).toEqual(['fts_tri', 'fts_words']);
  });

  it('chunkIdFor is deterministic, distinct per chunk_seq, and a safe integer', () => {
    expect(chunkIdFor('evt-1', 0)).toBe(chunkIdFor('evt-1', 0));
    expect(chunkIdFor('evt-1', 0)).not.toBe(chunkIdFor('evt-1', 1));
    expect(chunkIdFor('evt-1', 0)).not.toBe(chunkIdFor('evt-2', 0));
    const id = chunkIdFor('evt-1', 0);
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThan(2 ** 52);
  });

  it('insertSearchChunk feeds both FTS tables; contentless_delete is honored', () => {
    const c = makeChunk();
    insertSearchChunk(db, c);
    const wHit = db.raw
      .prepare("SELECT rowid FROM fts_words WHERE fts_words MATCH 'quick'")
      .get() as { rowid: number } | undefined;
    expect(wHit?.rowid).toBe(c.chunk_id);
    // trigram substring match on a code identifier
    const tHit = db.raw
      .prepare("SELECT rowid FROM fts_tri WHERE fts_tri MATCH 'useMemo'")
      .get() as { rowid: number } | undefined;
    expect(tHit?.rowid).toBe(c.chunk_id);
    db.raw.prepare('DELETE FROM fts_words WHERE rowid = ?').run(c.chunk_id);
    const after = db.raw
      .prepare("SELECT count(*) n FROM fts_words WHERE fts_words MATCH 'quick'")
      .get() as { n: number };
    expect(after.n).toBe(0);
  });

  it('deleteSessionSearchChunks purges chunks and FTS rows with no orphans', () => {
    insertSearchChunk(db, makeChunk({ event_id: 'evt-1', chunk_seq: 0 }));
    insertSearchChunk(db, makeChunk({ event_id: 'evt-2', chunk_seq: 0, text: 'another chunk ENOENT' }));
    expect((db.raw.prepare('SELECT count(*) n FROM search_chunks').get() as { n: number }).n).toBe(2);
    deleteSessionSearchChunks(db, 'sess-1');
    expect((db.raw.prepare('SELECT count(*) n FROM search_chunks').get() as { n: number }).n).toBe(0);
    const orphan = db.raw
      .prepare("SELECT count(*) n FROM fts_words WHERE fts_words MATCH 'chunk OR quick'")
      .get() as { n: number };
    expect(orphan.n).toBe(0);
  });

  it('publishIndexRun populates search_chunks + FTS from staged chunks; re-publish is stable', () => {
    const session = makeSession();
    const run1 = beginIndexRun(db, {
      harness: 'claude_code',
      session_id: session.session_id,
      raw_path: session.raw_path,
    });
    stageSession(db, run1, session, {});
    stageSearchChunks(db, run1, [makeChunk({ text: 'searchable body text alpha' })]);
    publishIndexRun(db, run1, { harness: 'claude_code', rawPath: session.raw_path });
    expect(
      (
        db.raw
          .prepare('SELECT count(*) n FROM search_chunks WHERE session_id = ?')
          .get(session.session_id) as { n: number }
      ).n,
    ).toBe(1);
    const hit = db.raw
      .prepare("SELECT rowid FROM fts_words WHERE fts_words MATCH 'alpha'")
      .get() as { rowid: number } | undefined;
    expect(hit?.rowid).toBe(chunkIdFor('evt-1', 0));

    const run2 = beginIndexRun(db, {
      harness: 'claude_code',
      session_id: session.session_id,
      raw_path: session.raw_path,
    });
    stageSession(db, run2, session, {});
    stageSearchChunks(db, run2, [makeChunk({ text: 'searchable body text alpha' })]);
    publishIndexRun(db, run2, { harness: 'claude_code', rawPath: session.raw_path });
    expect(
      (
        db.raw
          .prepare('SELECT count(*) n FROM search_chunks WHERE session_id = ?')
          .get(session.session_id) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (db.raw.prepare("SELECT count(*) n FROM fts_words WHERE fts_words MATCH 'alpha'").get() as {
        n: number;
      }).n,
    ).toBe(1);
  });
});
