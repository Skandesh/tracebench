import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  upsertSession,
  insertSearchChunk,
  insertVector,
  chunkIdFor,
  type TracebenchDb,
} from './db.js';
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
  it('returns empty for an empty query without error', async () => {
    expect(await searchEvents(db, { q: '' })).toEqual({ results: [], total: 0, semanticAvailable: false });
  });

  it('does not throw on FTS operator characters or reserved words', async () => {
    await expect(searchEvents(db, { q: 'a + b (c) "x' })).resolves.toBeDefined();
    await expect(searchEvents(db, { q: 'AND OR NOT' })).resolves.toBeDefined();
    await expect(searchEvents(db, { q: 'foo* -bar ^baz' })).resolves.toBeDefined();
  });

  it('matches a code identifier as a substring (trigram leg)', async () => {
    const r = await searchEvents(db, { q: 'useMemo' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a');
  });

  it('matches a file path', async () => {
    const r = await searchEvents(db, { q: 'packages/core/src/db.ts' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a');
  });

  it('matches an error string inside an event body', async () => {
    const r = await searchEvents(db, { q: 'ENOENT' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-b');
  });

  it('filters by harness', async () => {
    const r = await searchEvents(db, { q: 'ENOENT', harness: 'claude_code' });
    expect(r.results).toHaveLength(0); // ENOENT lives in the codex session only
    const r2 = await searchEvents(db, { q: 'ENOENT', harness: 'codex' });
    expect(r2.results.map((g) => g.session.session_id)).toEqual(['sess-b']);
  });

  it('falls back to LIKE for sub-3-char substring queries (no FTS error)', async () => {
    const r = await searchEvents(db, { q: 'fs' });
    expect(r.results.map((g) => g.session.session_id)).toContain('sess-a'); // useFsModule
  });

  it('groups matches by session and returns the precomputed session row', async () => {
    const r = await searchEvents(db, { q: 'the' });
    const a = r.results.find((g) => g.session.session_id === 'sess-a');
    expect(a).toBeTruthy();
    expect(a!.session.title).toBe('sess-a title');
    expect(a!.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('returns snippets with sentinel-delimited highlights', async () => {
    const r = await searchEvents(db, { q: 'quick' });
    const a = r.results.find((g) => g.session.session_id === 'sess-a');
    expect(a).toBeTruthy();
    const snip = a!.matches.map((m) => m.snippet).join(' ');
    expect(snip).toContain(SNIPPET_OPEN);
  });

  it('paginates at the session level', async () => {
    const r = await searchEvents(db, { q: 'the', limit: 1, offset: 0 });
    expect(r.results).toHaveLength(1);
    expect(r.total).toBeGreaterThanOrEqual(1);
  });
});

describe('searchEvents hybrid semantic leg (U9)', () => {
  function vec384(prefix: number[]): number[] {
    const v = new Array(384).fill(0);
    for (let i = 0; i < prefix.length; i++) v[i] = prefix[i];
    return v;
  }

  it('surfaces a session via semantic recall that lexical misses, and marks the match', async () => {
    const vdb = openDb({ path: ':memory:', enableVectors: true });
    try {
      upsertSession(vdb, {
        session_id: 'sv',
        harness: 'claude_code',
        project_path: '/p',
        title: 'auth work',
        started_at: '2026-06-18T00:00:00.000Z',
        ended_at: null,
        model: null,
        raw_path: '/x',
        format_version: '1',
        mtime_ms: 1,
      });
      const c = { chunk_id: chunkIdFor('e', 0), event_id: 'e', session_id: 'sv', turn_id: null, harness: 'claude_code', chunk_seq: 0, text: 'refreshed the login token on expiry', content_hash: 'h' };
      insertSearchChunk(vdb, c);
      insertVector(vdb, c.chunk_id, 'claude_code', vec384([1, 0, 0]));

      // 'gamma' appears nowhere lexically; the query embedding is near the chunk's vector.
      const embedQuery = async (_q: string) => vec384([1, 0, 0]);
      const r = await searchEvents(vdb, { q: 'gamma' }, { embedQuery, maxVectorChunks: 100 });
      expect(r.semanticAvailable).toBe(true);
      expect(r.results.map((g) => g.session.session_id)).toContain('sv');
      expect(r.results[0].matches.some((m) => m.source === 'semantic')).toBe(true);
    } finally {
      vdb.close();
    }
  });

  it('without an embedder, behaves as lexical-only (semanticAvailable false)', async () => {
    const vdb = openDb({ path: ':memory:', enableVectors: true });
    try {
      const r = await searchEvents(vdb, { q: 'gamma' });
      expect(r.semanticAvailable).toBe(false);
    } finally {
      vdb.close();
    }
  });
});
