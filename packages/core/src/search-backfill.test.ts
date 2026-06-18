import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  upsertSession,
  insertEvents,
  type TracebenchDb,
} from './db.js';
import { backfillSearchChunks, countPendingLexicalBackfill } from './search-backfill.js';
import { searchEvents } from './search.js';
import type { CanonicalEvent, Session } from './schema.js';

function makeSession(id: string, mtime = 1700000000000): Session {
  return {
    session_id: id,
    harness: 'claude_code',
    project_path: `/Users/me/${id}`,
    title: `${id}`,
    started_at: '2026-06-18T00:00:00.000Z',
    ended_at: null,
    model: null,
    raw_path: `/x/${id}.jsonl`,
    format_version: '1',
    mtime_ms: mtime,
  };
}

let n = 0;
function makeEvent(sessionId: string, overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  n++;
  return {
    event_id: `evt-${n}`,
    session_id: sessionId,
    turn_id: 'turn-1',
    parent_event_id: null,
    timestamp: '2026-06-18T00:00:00.000Z',
    source: { harness: 'claude_code', format_version: '1', raw_path: `/x/${sessionId}.jsonl` },
    role: 'assistant',
    event_type: 'message',
    model: null,
    tokens: { input: null, output: null, cache_read: null, cache_creation: null, reasoning: null },
    cost_usd: null,
    cost_method: null,
    duration_ms: null,
    content: 'hello world',
    tool: { name: null, input: null, output: null, status: null, error_message: null },
    metadata: {},
    raw: {},
    ...overrides,
  };
}

let db: TracebenchDb;
beforeEach(() => {
  n = 0;
  db = openDb({ path: ':memory:' });
});

describe('backfillSearchChunks (U6)', () => {
  it('makes an events-only session searchable, then is idempotent', async () => {
    upsertSession(db, makeSession('sess-a'));
    insertEvents(db, [makeEvent('sess-a', { content: 'investigate the parser regression' })]);
    expect(countPendingLexicalBackfill(db)).toBe(1);

    const r1 = backfillSearchChunks(db);
    expect(r1).toEqual({ processed: 1, remaining: 0 });
    expect((await searchEvents(db, { q: 'parser regression' })).results.map((g) => g.session.session_id)).toContain('sess-a');

    // Idempotent — already marked done.
    expect(backfillSearchChunks(db)).toEqual({ processed: 0, remaining: 0 });
    expect((db.raw.prepare('SELECT count(*) c FROM search_chunks WHERE session_id = ?').get('sess-a') as { c: number }).c).toBe(1);
  });

  it('decompresses externalized payloads and indexes their text', async () => {
    upsertSession(db, makeSession('sess-x'));
    insertEvents(
      db,
      [
        makeEvent('sess-x', {
          content: null,
          event_type: 'tool_result',
          tool: { name: 'Read', input: { file: 'big.txt' }, output: 'zzcompressed needle here', status: 'success', error_message: null },
        }),
      ],
      0,
      { payloadMode: 'external', payloadThresholdBytes: 5 }, // force externalization
    );
    backfillSearchChunks(db);
    // The needle lives only inside an externalized (gzipped) tool output.
    expect((await searchEvents(db, { q: 'zzcompressed' })).results.map((g) => g.session.session_id)).toContain('sess-x');
  });

  it('re-detects a session whose mtime advanced', () => {
    upsertSession(db, makeSession('sess-m', 1000));
    insertEvents(db, [makeEvent('sess-m', { content: 'first body' })]);
    backfillSearchChunks(db);
    expect(countPendingLexicalBackfill(db)).toBe(0);

    upsertSession(db, makeSession('sess-m', 2000)); // mtime advanced
    expect(countPendingLexicalBackfill(db)).toBe(1);
    expect(backfillSearchChunks(db).processed).toBe(1);
    // deterministic chunk_id keeps the count stable across the rebuild
    expect((db.raw.prepare('SELECT count(*) c FROM search_chunks WHERE session_id = ?').get('sess-m') as { c: number }).c).toBe(1);
  });

  it('resumes across bounded batches (limit)', () => {
    for (const id of ['s1', 's2', 's3']) {
      upsertSession(db, makeSession(id));
      insertEvents(db, [makeEvent(id, { content: `content for ${id}` })]);
    }
    expect(backfillSearchChunks(db, { limit: 2 })).toEqual({ processed: 2, remaining: 1 });
    expect(backfillSearchChunks(db, { limit: 2 })).toEqual({ processed: 1, remaining: 0 });
  });
});
