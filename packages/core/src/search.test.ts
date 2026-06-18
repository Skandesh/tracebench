import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, upsertSession, insertSearchChunk, chunkIdFor, type TracebenchDb } from './db.js';
import { searchEvents, toFtsMatch, SNIPPET_OPEN } from './search.js';
import type { Harness, Session } from './schema.js';

function makeSession(id: string, harness: Harness): Session {
  return {
    session_id: id,
    harness,
    project_path: `/Users/me/${id}`,
    title: `${id} title`,
    started_at: '2026-06-18T00:00:00.000Z',
    ended_at: null,
    model: null,
    raw_path: `/x/${id}.jsonl`,
    format_version: '1',
    mtime_ms: 1700000000000,
  };
}

let db: TracebenchDb;
let evt = 0;
function seedChunk(sessionId: string, harness: Harness, text: string): number {
  evt++;
  const event_id = `evt-${evt}`;
  const chunk_id = chunkIdFor(event_id, 0);
  insertSearchChunk(db, {
    chunk_id,
    event_id,
    session_id: sessionId,
    turn_id: 'turn-1',
    harness,
    chunk_seq: 0,
    text,
    content_hash: `h-${evt}`,
  });
  return chunk_id;
}

beforeEach(() => {
  evt = 0;
  db = openDb({ path: ':memory:' });
  upsertSession(db, makeSession('sess-a', 'claude_code'));
  upsertSession(db, makeSession('sess-b', 'codex'));
  seedChunk('sess-a', 'claude_code', 'the quick brown fox jumped over the lazy dog');
  seedChunk('sess-a', 'claude_code', 'calling useMemoValue inside the react component');
  seedChunk('sess-a', 'claude_code', 'edited packages/core/src/db.ts to fix the migration');
  seedChunk('sess-a', 'claude_code', 'the useFsModule helper wraps node fs');
  seedChunk('sess-b', 'codex', 'error: ENOENT no such file or directory');
  seedChunk('sess-b', 'codex', 'reasoning about the auth flow and login token expiry');
});

describe('toFtsMatch', () => {
  it('returns null for empty/whitespace input', () => {
    expect(toFtsMatch('').match).toBeNull();
    expect(toFtsMatch('   ').match).toBeNull();
  });
  it('quotes every token so operators and reserved words are literal', () => {
    expect(toFtsMatch('a + b').match).toBe('"a" "+" "b"');
    expect(toFtsMatch('AND OR NOT').match).toBe('"AND" "OR" "NOT"');
    expect(toFtsMatch('say "hi"').match).toBe('"say" """hi"""');
  });
  it('flags only tokens >= 3 chars as trigram-eligible', () => {
    expect(toFtsMatch('fs db useMemo').longTokens).toEqual(['useMemo']);
  });
});

describe('searchEvents (U3)', () => {
  it('returns empty for an empty query without error', () => {
    expect(searchEvents(db, { q: '' })).toEqual({ results: [], total: 0, semanticAvailable: false });
  });

  it('does not throw on FTS operator characters or reserved words', () => {
    expect(() => searchEvents(db, { q: 'a + b (c) "x' })).not.toThrow();
    expect(() => searchEvents(db, { q: 'AND OR NOT' })).not.toThrow();
    expect(() => searchEvents(db, { q: 'foo* -bar ^baz' })).not.toThrow();
  });

  it('matches a code identifier as a substring (trigram leg)', () => {
    const r = searchEvents(db, { q: 'useMemo' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a');
  });

  it('matches a file path', () => {
    const r = searchEvents(db, { q: 'packages/core/src/db.ts' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a');
  });

  it('matches an error string inside an event body', () => {
    const r = searchEvents(db, { q: 'ENOENT' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-b');
  });

  it('filters by harness', () => {
    const r = searchEvents(db, { q: 'ENOENT', harness: 'claude_code' });
    expect(r.results).toHaveLength(0); // ENOENT lives in the codex session only
    const r2 = searchEvents(db, { q: 'ENOENT', harness: 'codex' });
    expect(r2.results.map((g) => g.session.session_id)).toEqual(['sess-b']);
  });

  it('falls back to LIKE for sub-3-char substring queries (no FTS error)', () => {
    const r = searchEvents(db, { q: 'fs' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a'); // useFsModule
  });

  it('groups matches by session and returns the precomputed session row', () => {
    const r = searchEvents(db, { q: 'the' });
    const a = r.results.find((g) => g.session.session_id === 'sess-a');
    expect(a).toBeTruthy();
    expect(a!.session.title).toBe('sess-a title');
    expect(a!.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('returns snippets with sentinel-delimited highlights', () => {
    const r = searchEvents(db, { q: 'quick' });
    const a = r.results.find((g) => g.session.session_id === 'sess-a');
    expect(a).toBeTruthy();
    const snip = a!.matches.map((m) => m.snippet).join(' ');
    expect(snip).toContain(SNIPPET_OPEN);
  });

  it('paginates at the session level', () => {
    const r = searchEvents(db, { q: 'the', limit: 1, offset: 0 });
    expect(r.results).toHaveLength(1);
    expect(r.total).toBeGreaterThanOrEqual(1);
  });
});
