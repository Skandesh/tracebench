// Cross-session search over the lexical index (U3). Phase A fuses the two FTS5
// legs (porter words + trigram) with Reciprocal Rank Fusion; U9 adds the
// semantic (vec_chunks) leg as a third list on the same fusion path.
//
// Invariants honored: never pass raw user input to MATCH (sanitize first);
// never a GROUP BY over events; the session row is joined in ONE batched
// `WHERE session_id IN (...)` query; snippets are computed only for the
// displayed page; highlights are emitted as sentinel-delimited spans (the UI
// renders them as text nodes — no HTML injection).

import { countVectors, type TracebenchDb } from './db.js';
import { DEFAULT_MAX_VECTOR_CHUNKS } from './search-embed.js';
import type { Harness, Session } from './schema.js';

const RRF_K = 60; // Cormack et al. RRF default (TREC-tuned); see plan KTD5.
const CANDIDATE_LIMIT = 50; // per-list candidate count (recall vs latency knob)
const WORD_WEIGHT = 1.0;
const TRIGRAM_WEIGHT = 1.5; // favor exact-substring/code matches
const VEC_WEIGHT = 1.0; // semantic leg weight in the fusion
const MIN_TRIGRAM_LEN = 3; // trigram tokenizer cannot match shorter tokens
const MAX_MATCHES_PER_SESSION = 3;
const DEFAULT_LIMIT = 25;
// Sentinel delimiters around matched spans. Control chars never occur in real
// transcript text, so the UI can split on them and render matches as <mark>
// text nodes without dangerouslySetInnerHTML.
export const SNIPPET_OPEN = '\u0001';
export const SNIPPET_CLOSE = '\u0002';

export interface SearchMatch {
  chunk_id: number;
  event_id: string;
  turn_id: string | null;
  snippet: string;
  source: 'lexical' | 'semantic';
}

export interface SearchResultGroup {
  session: Session;
  score: number;
  matches: SearchMatch[];
}

export interface SearchEventsResult {
  results: SearchResultGroup[];
  /** Number of matching sessions (for pagination). */
  total: number;
  /** Whether the semantic leg contributed (false in Phase A / when unavailable). */
  semanticAvailable: boolean;
}

export interface SearchEventsOptions {
  q: string;
  harness?: Harness;
  limit?: number;
  offset?: number;
}

interface ParsedQuery {
  /** FTS5-safe MATCH expression, or null for empty input. */
  match: string | null;
  /** Tokens with length >= MIN_TRIGRAM_LEN (eligible for the trigram leg). */
  longTokens: string[];
  /** All non-empty whitespace-split tokens. */
  tokens: string[];
}

function quoteToken(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: each token is
 * wrapped in double quotes (embedded quotes doubled), so every FTS5 operator
 * char (+ - * ( ) : ^ ") becomes a literal and reserved words (AND/OR/NOT) lose
 * operator meaning. The result is still bound as a parameter. Empty input → null.
 */
export function toFtsMatch(raw: string): ParsedQuery {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { match: null, longTokens: [], tokens: [] };
  const longTokens = tokens.filter((t) => [...t].length >= MIN_TRIGRAM_LEN);
  return { match: tokens.map(quoteToken).join(' '), longTokens, tokens };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Reciprocal Rank Fusion over ranked lists (single consumer; inlined per KTD5). */
function rrf(
  lists: { rows: { chunk_id: number }[]; weight: number }[],
  k = RRF_K,
): { chunk_id: number; score: number }[] {
  const score = new Map<number, number>();
  for (const { rows, weight } of lists) {
    rows.forEach((row, i) => {
      score.set(row.chunk_id, (score.get(row.chunk_id) ?? 0) + weight / (k + i + 1));
    });
  }
  return [...score.entries()]
    .map(([chunk_id, s]) => ({ chunk_id, score: s }))
    .sort((a, b) => b.score - a.score);
}

interface ChunkLookupRow {
  chunk_id: number;
  session_id: string;
  event_id: string;
  turn_id: string | null;
  harness: string;
  text: string;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a windowed, highlighted excerpt from the chunk text in JS — NOT via
 * FTS5 snippet(), which returns nothing on a contentless (content='') table
 * because the document text isn't stored there. We have the text in
 * search_chunks.text, so highlighting here is both correct and XSS-safe:
 * matched spans are wrapped in control-char sentinels that the UI renders as
 * text nodes (never innerHTML).
 */
function makeSnippet(text: string, tokens: string[], maxLen = 200): string {
  const usable = tokens.filter(Boolean);
  if (usable.length === 0) return text.slice(0, maxLen);
  const lower = text.toLowerCase();
  let firstPos = -1;
  for (const t of usable) {
    const p = lower.indexOf(t.toLowerCase());
    if (p !== -1 && (firstPos === -1 || p < firstPos)) firstPos = p;
  }
  const start = firstPos > 60 ? firstPos - 60 : 0;
  const slice = text.slice(start, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = start + maxLen < text.length ? '…' : '';
  // Single-pass highlight (longest tokens first) so sentinels never nest.
  const sorted = [...new Set(usable)].sort((a, b) => b.length - a.length);
  const re = new RegExp('(' + sorted.map(escapeRegExp).join('|') + ')', 'gi');
  const highlighted = slice.replace(re, (m) => `${SNIPPET_OPEN}${m}${SNIPPET_CLOSE}`);
  return prefix + highlighted + suffix;
}

export interface SearchDeps {
  /** Embed the query for the semantic leg; return null to skip semantics. */
  embedQuery?: (q: string) => Promise<number[] | null>;
  /** Vector budget; above the stored-vector count, the semantic leg is skipped. */
  maxVectorChunks?: number;
}

export async function searchEvents(
  db: TracebenchDb,
  opts: SearchEventsOptions,
  deps: SearchDeps = {},
): Promise<SearchEventsResult> {
  const budget = deps.maxVectorChunks ?? DEFAULT_MAX_VECTOR_CHUNKS;
  const vectorCount = db.vectorsAvailable ? countVectors(db) : 0;
  const semanticAvailable =
    db.vectorsAvailable && !!deps.embedQuery && vectorCount > 0 && vectorCount <= budget;
  const empty: SearchEventsResult = { results: [], total: 0, semanticAvailable };
  const { match, longTokens, tokens } = toFtsMatch(opts.q);
  if (match == null) return empty;

  // ── Lexical candidate lists ──
  const lists: { rows: { chunk_id: number }[]; weight: number }[] = [];
  if (db.ftsAvailable && longTokens.length > 0) {
    const wordRows = db.raw
      .prepare('SELECT rowid AS chunk_id FROM fts_words WHERE fts_words MATCH ? ORDER BY rank LIMIT ?')
      .all(match, CANDIDATE_LIMIT) as { chunk_id: number }[];
    const triMatch = longTokens.map(quoteToken).join(' ');
    const triRows = db.raw
      .prepare('SELECT rowid AS chunk_id FROM fts_tri WHERE fts_tri MATCH ? ORDER BY rank LIMIT ?')
      .all(triMatch, CANDIDATE_LIMIT) as { chunk_id: number }[];
    lists.push({ rows: wordRows, weight: WORD_WEIGHT }, { rows: triRows, weight: TRIGRAM_WEIGHT });
  } else {
    // Short-token-only query, or FTS unavailable → bounded LIKE substring scan.
    const like = `%${escapeLike(opts.q.trim())}%`;
    const likeRows = db.raw
      .prepare("SELECT chunk_id FROM search_chunks WHERE text LIKE ? ESCAPE '\\' LIMIT ?")
      .all(like, CANDIDATE_LIMIT) as { chunk_id: number }[];
    lists.push({ rows: likeRows, weight: WORD_WEIGHT });
  }

  // ── Semantic leg (U9): embed the query, KNN over vec_chunks, fuse as a third
  // list. Degrades to lexical on any failure. ──
  const semanticIds = new Set<number>();
  if (semanticAvailable) {
    try {
      const qv = await deps.embedQuery!(opts.q);
      if (qv && qv.length) {
        const buf = Buffer.from(Float32Array.from(qv).buffer);
        const knn = (
          opts.harness
            ? db.raw
                .prepare('SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? AND k = ? AND harness = ? ORDER BY distance')
                .all(buf, CANDIDATE_LIMIT, opts.harness)
            : db.raw
                .prepare('SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance')
                .all(buf, CANDIDATE_LIMIT)
        ) as { chunk_id: number | bigint }[];
        const vecRows = knn.map((r) => ({ chunk_id: Number(r.chunk_id) }));
        for (const r of vecRows) semanticIds.add(r.chunk_id);
        lists.push({ rows: vecRows, weight: VEC_WEIGHT });
      }
    } catch {
      // degrade to lexical for this query
    }
  }

  const fused = rrf(lists);
  if (fused.length === 0) return empty;

  // ── Map chunks → sessions (one batched lookup; preserve fused order) ──
  const ids = fused.map((f) => f.chunk_id);
  const chunkRows = db.raw
    .prepare(
      `SELECT chunk_id, session_id, event_id, turn_id, harness, text
       FROM search_chunks WHERE chunk_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids) as ChunkLookupRow[];
  const chunkById = new Map(chunkRows.map((c) => [c.chunk_id, c]));

  const bySession = new Map<
    string,
    { score: number; matches: ChunkLookupRow[] }
  >();
  for (const f of fused) {
    const c = chunkById.get(f.chunk_id);
    if (!c) continue;
    if (opts.harness && c.harness !== opts.harness) continue;
    let g = bySession.get(c.session_id);
    if (!g) {
      g = { score: 0, matches: [] };
      bySession.set(c.session_id, g);
    }
    g.score += f.score;
    if (g.matches.length < MAX_MATCHES_PER_SESSION) g.matches.push(c);
  }

  const sessionIds = [...bySession.keys()].sort(
    (a, b) => bySession.get(b)!.score - bySession.get(a)!.score,
  );
  const total = sessionIds.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const pageIds = sessionIds.slice(offset, offset + limit);
  if (pageIds.length === 0) return { results: [], total, semanticAvailable };

  // ── Batched session-row join — no GROUP BY over events, no N+1 ──
  const sessionRows = db.raw
    .prepare(
      `SELECT session_id, harness, project_path, title, started_at, ended_at, model, raw_path, format_version, mtime_ms
       FROM sessions WHERE session_id IN (${placeholders(pageIds.length)})`,
    )
    .all(...pageIds) as Session[];
  const sessionById = new Map(sessionRows.map((s) => [s.session_id, s]));

  const results: SearchResultGroup[] = [];
  for (const sid of pageIds) {
    const row = sessionById.get(sid);
    if (!row) continue; // chunk references a session no longer present
    const g = bySession.get(sid)!;
    results.push({
      session: { ...row, harness: row.harness as Harness },
      score: g.score,
      matches: g.matches.map((m) => ({
        chunk_id: m.chunk_id,
        event_id: m.event_id,
        turn_id: m.turn_id,
        snippet: makeSnippet(m.text, tokens),
        source: (semanticIds.has(m.chunk_id) ? 'semantic' : 'lexical') as 'lexical' | 'semantic',
      })),
    });
  }
  return { results, total, semanticAvailable };
}
