// One-time lexical backfill (U6). Builds search chunks + FTS rows for sessions
// already in the DB that predate the search index, so existing databases gain
// search without a manual re-index.
//
// Safety (KTD10 / RISK11): each session is (re)built in a SINGLE transaction
// (delete-existing + insert-all + mark done) so an interruption leaves a session
// fully done or untouched — never half. Work is detected via the positive
// search_backfill_state marker, not a check-then-act "has chunks" predicate. The
// caller must run this STRICTLY after indexAll resolves (never concurrently with
// the live indexer over the same session) and checkpoint WAL between batches.

import {
  deleteSessionSearchChunks,
  insertSearchChunk,
  type TracebenchDb,
} from './db.js';
import { getSessionEvents } from './query.js';
import { extractSearchChunksForEvents } from './search-chunks.js';

const MARK_SQL = `
  INSERT INTO search_backfill_state (session_id, mtime_ms, lexical_done)
  VALUES (?, ?, 1)
  ON CONFLICT(session_id) DO UPDATE SET mtime_ms = excluded.mtime_ms, lexical_done = 1
`;

const PENDING_SQL = `
  FROM sessions s
  LEFT JOIN search_backfill_state b ON b.session_id = s.session_id
  WHERE b.session_id IS NULL OR b.lexical_done = 0 OR b.mtime_ms <> s.mtime_ms
`;

export function countPendingLexicalBackfill(db: TracebenchDb): number {
  return (db.raw.prepare(`SELECT count(*) AS n ${PENDING_SQL}`).get() as { n: number }).n;
}

/**
 * Process up to `limit` sessions needing the lexical backfill. Returns how many
 * were processed and how many remain, so a caller can loop (with inter-batch
 * yields + WAL checkpoints) until `remaining` is 0.
 */
export function backfillSearchChunks(
  db: TracebenchDb,
  opts: { limit?: number } = {},
): { processed: number; remaining: number } {
  const limit = opts.limit ?? 50;
  const pending = db.raw
    .prepare(`SELECT s.session_id AS session_id, s.mtime_ms AS mtime_ms ${PENDING_SQL} ORDER BY s.started_at DESC LIMIT ?`)
    .all(limit) as { session_id: string; mtime_ms: number }[];

  let processed = 0;
  for (const row of pending) {
    // Read fully-hydrated events (resolvePayloadRef decompresses externalized
    // payloads). Same pure chunker as the index path → byte-identical chunks.
    const events = getSessionEvents(db, row.session_id);
    const chunks = extractSearchChunksForEvents(events);
    const tx = db.raw.transaction(() => {
      deleteSessionSearchChunks(db, row.session_id);
      for (const c of chunks) insertSearchChunk(db, c);
      db.raw.prepare(MARK_SQL).run(row.session_id, row.mtime_ms);
    });
    tx();
    processed++;
  }

  return { processed, remaining: countPendingLexicalBackfill(db) };
}
