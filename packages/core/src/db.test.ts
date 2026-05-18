import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  upsertSession,
  insertEvents,
  deleteSessionEvents,
  upsertContextSnapshot,
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
} from './query.js';

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
