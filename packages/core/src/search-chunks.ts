// Pure chunk extraction for the lexical/semantic search index.
//
// Turns a CanonicalEvent into 0..n SearchChunkRow records. Pure and
// input-path-agnostic (KTD13): the same event produces byte-identical chunks
// whether fed in-memory at index time (U2) or decompressed from storage during
// backfill (U6). No DB access — only chunkIdFor (a pure hash) is imported.

import { createHash } from 'node:crypto';
import { chunkIdFor, type SearchChunkRow } from './db.js';
import type { CanonicalEvent } from './schema.js';

// Char budget as a proxy for the embedding model's ~256 word-piece window
// (~4 chars/word-piece). Sized for the embedding window from the start (KTD8)
// so the semantic phase embeds these chunks 1:1 with no re-chunk.
export const MAX_CHUNK_CHARS = 1000;
export const CHUNK_OVERLAP_CHARS = 150;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Assemble the human-meaningful searchable text for one event. */
function eventText(e: CanonicalEvent): string {
  const parts: string[] = [];
  if (e.content != null) {
    parts.push(typeof e.content === 'string' ? e.content : JSON.stringify(e.content));
  }
  const tool = e.tool;
  if (tool) {
    if (tool.name) parts.push(`tool: ${tool.name}`);
    if (tool.input != null) {
      parts.push(typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input));
    }
    if (tool.output != null) {
      parts.push(typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output));
    }
    if (tool.error_message) parts.push(tool.error_message);
  }
  return parts.join('\n').trim();
}

/** Split into overlapping windows; the final window always reaches the end, so
 *  no tiny trailing fragment is emitted. */
function splitText(text: string, max: number, overlap: number): string[] {
  if (text.length <= max) return [text];
  const step = Math.max(1, max - overlap);
  const out: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + max));
    if (start + max >= text.length) break;
  }
  return out;
}

/**
 * Extract chunks for a single event. Events with no meaningful text (empty /
 * meta-only) yield zero chunks. Long events split into ordered, overlapping
 * chunks sized to the embedding window. `chunk_seq` is the chunk's ordinal
 * within the event — NOT events.seq — and feeds the deterministic chunk_id.
 *
 * v1 simplification: one chunk per non-empty event (plus splits for long ones);
 * no cross-event merging of tiny events, since a merged chunk would have no
 * single owning event_id for the deterministic key.
 */
export function extractSearchChunks(e: CanonicalEvent): SearchChunkRow[] {
  const text = eventText(e);
  if (!text) return [];
  const pieces = splitText(text, MAX_CHUNK_CHARS, CHUNK_OVERLAP_CHARS);
  return pieces.map((piece, chunkSeq) => ({
    chunk_id: chunkIdFor(e.event_id, chunkSeq),
    event_id: e.event_id,
    session_id: e.session_id,
    turn_id: e.turn_id ?? null,
    harness: e.source.harness,
    chunk_seq: chunkSeq,
    text: piece,
    content_hash: sha256(piece),
    embed_state: 'vector-pending',
  }));
}

/** Flatten chunks across a batch of events (the indexer's per-batch hook). */
export function extractSearchChunksForEvents(
  events: readonly CanonicalEvent[],
): SearchChunkRow[] {
  return events.flatMap((e) => extractSearchChunks(e));
}
