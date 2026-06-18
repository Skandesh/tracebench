import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb,
  upsertSession,
  insertSearchChunk,
  chunkIdFor,
  countVectors,
  type TracebenchDb,
} from './db.js';
import { runEmbedDrainBatch, countPendingEmbeddings } from './search-embed.js';
import type { EmbedFn } from './embeddings.js';
import type { Session } from './schema.js';

// Deterministic fake embedder — no model download.
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(384).fill(0);
    v[0] = t.length;
    v[1] = 1;
    return v;
  });

const throwingEmbed: EmbedFn = async () => {
  throw new Error('model unavailable');
};

function session(id: string): Session {
  return {
    session_id: id,
    harness: 'claude_code',
    project_path: `/Users/me/${id}`,
    title: id,
    started_at: '2026-06-18T00:00:00.000Z',
    ended_at: null,
    model: null,
    raw_path: `/x/${id}.jsonl`,
    format_version: '1',
    mtime_ms: 1700000000000,
  };
}

function seedChunk(db: TracebenchDb, eventId: string, sessionId: string): number {
  const chunk_id = chunkIdFor(eventId, 0);
  insertSearchChunk(db, {
    chunk_id,
    event_id: eventId,
    session_id: sessionId,
    turn_id: null,
    harness: 'claude_code',
    chunk_seq: 0,
    text: `text for ${eventId}`,
    content_hash: `h-${eventId}`,
  });
  return chunk_id;
}

describe('runEmbedDrainBatch (U8)', () => {
  let db: TracebenchDb;
  beforeEach(() => {
    db = openDb({ path: ':memory:', enableVectors: true });
    upsertSession(db, session('s'));
  });

  it('embeds pending chunks, writes vectors, marks embedded, and is idempotent', async () => {
    seedChunk(db, 'e1', 's');
    seedChunk(db, 'e2', 's');
    expect(countPendingEmbeddings(db)).toBe(2);

    const r = await runEmbedDrainBatch(db, fakeEmbed);
    expect(r.processed).toBe(2);
    expect(countVectors(db)).toBe(2);
    expect(countPendingEmbeddings(db)).toBe(0);

    expect((await runEmbedDrainBatch(db, fakeEmbed)).processed).toBe(0);
  });

  it('leaves chunks vector-pending when embedding throws (recoverable)', async () => {
    seedChunk(db, 'e1', 's');
    const r = await runEmbedDrainBatch(db, throwingEmbed);
    expect(r.processed).toBe(0);
    expect(countVectors(db)).toBe(0);
    expect(countPendingEmbeddings(db)).toBe(1);
    // a later pass with a working embedder recovers it
    expect((await runEmbedDrainBatch(db, fakeEmbed)).processed).toBe(1);
    expect(countVectors(db)).toBe(1);
  });

  it('respects the maxVectorChunks budget', async () => {
    seedChunk(db, 'e1', 's');
    const r = await runEmbedDrainBatch(db, fakeEmbed, { maxVectorChunks: 0 });
    expect(r.budgetReached).toBe(true);
    expect(r.processed).toBe(0);
    expect(countVectors(db)).toBe(0);
  });

  it('is a no-op when vectors are unavailable', async () => {
    const ldb = openDb({ path: ':memory:' }); // lexical-only
    upsertSession(ldb, session('s'));
    seedChunk(ldb, 'x', 's');
    expect(await runEmbedDrainBatch(ldb, fakeEmbed)).toEqual({
      processed: 0,
      remaining: 0,
      budgetReached: false,
    });
    ldb.close();
  });
});
