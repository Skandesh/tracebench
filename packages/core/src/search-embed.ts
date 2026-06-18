// Embedding drain (U8). Embeds `vector-pending` chunks and writes their vectors,
// off the publish path. The embedder is injected (an EmbedFn) so this logic is
// testable without a model download; the server passes the real local embedder.
//
// Safety (KTD6/KTD7): embedding is async and happens BEFORE the synchronous
// insert transaction; a per-batch embed failure leaves chunks `vector-pending`
// (recoverable, never silently "done"); the maxVectorChunks budget caps scale.

import { insertVector, countVectors, type TracebenchDb } from './db.js';
import type { EmbedFn } from './embeddings.js';

export const DEFAULT_MAX_VECTOR_CHUNKS = 150_000;
const DEFAULT_BATCH = 32;

const PENDING = "FROM search_chunks WHERE embed_state = 'vector-pending'";

export function countPendingEmbeddings(db: TracebenchDb): number {
  if (!db.vectorsAvailable) return 0;
  return (db.raw.prepare(`SELECT count(*) AS n ${PENDING}`).get() as { n: number }).n;
}

export interface EmbedDrainResult {
  processed: number;
  remaining: number;
  budgetReached: boolean;
}

/**
 * Embed one bounded batch of pending chunks. Returns counts so a caller can
 * loop (with inter-batch yields + checkpoints) until `remaining` is 0.
 */
export async function runEmbedDrainBatch(
  db: TracebenchDb,
  embed: EmbedFn,
  opts: { limit?: number; maxVectorChunks?: number } = {},
): Promise<EmbedDrainResult> {
  if (!db.vectorsAvailable) return { processed: 0, remaining: 0, budgetReached: false };

  const budget = opts.maxVectorChunks ?? DEFAULT_MAX_VECTOR_CHUNKS;
  if (countVectors(db) >= budget) {
    return { processed: 0, remaining: countPendingEmbeddings(db), budgetReached: true };
  }

  const limit = opts.limit ?? DEFAULT_BATCH;
  const rows = db.raw
    .prepare(`SELECT chunk_id, harness, text ${PENDING} LIMIT ?`)
    .all(limit) as { chunk_id: number; harness: string; text: string }[];
  if (rows.length === 0) return { processed: 0, remaining: 0, budgetReached: false };

  let vectors: number[][];
  try {
    // Async embed happens OUTSIDE the synchronous insert transaction.
    vectors = await embed(rows.map((r) => r.text));
  } catch {
    // Leave chunks vector-pending — recoverable on a later pass.
    return { processed: 0, remaining: countPendingEmbeddings(db), budgetReached: false };
  }

  const mark = db.raw.prepare("UPDATE search_chunks SET embed_state = 'embedded' WHERE chunk_id = ?");
  const tx = db.raw.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v || v.length === 0) continue; // missing vector → stays pending
      insertVector(db, rows[i]!.chunk_id, rows[i]!.harness, v);
      mark.run(rows[i]!.chunk_id);
    }
  });
  tx();

  return {
    processed: rows.length,
    remaining: countPendingEmbeddings(db),
    budgetReached: false,
  };
}
