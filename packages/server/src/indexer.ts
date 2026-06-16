// Multi-adapter incremental indexer.
//
// For each registered adapter, walk its root, compare each session's mtime
// against the DB, and re-index any that are new or changed. Per-session
// updates are atomic (delete then insert).
//
// The indexer accepts an optional per-harness root override so a user can
// point at a non-default Codex / Claude Code dir.

import {
  beginIndexRun,
  stageSession,
  stageEvents,
  publishIndexRun,
  failIndexRun,
  upsertDiscoveredSession,
  markDiscoveredSessionIndexing,
  markDiscoveredSessionError,
} from '@tracebench/core';
import type {
  CanonicalEvent,
  Harness,
  Session,
  SessionAggregateRow,
  TracebenchDb,
} from '@tracebench/core';
import { ADAPTERS, type AdapterModule, type AdapterDiscovered } from './adapters.js';

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  deferred: number;
  per_harness: Record<string, { scanned: number; indexed: number; skipped: number; deferred: number }>;
  errors: { file: string; harness: Harness; message: string }[];
  duration_ms: number;
}

export interface IndexOptions {
  /** Override the default discovery root for a specific harness. */
  roots?: Partial<Record<Harness, string>>;
  /** Override Cursor global state.vscdb (Composer history). */
  cursorGlobalDbPath?: string;
  /** Force re-index ignoring mtime. */
  full?: boolean;
  /** Keep startup freshness bounded while preserving full-index escape hatches. */
  maxSessionsPerHarness?: number;
  maxSourceBytesPerHarness?: number;
  sinceMs?: number;
  sessionIds?: string[];
  /** Preserve full raw JSON in hot rows only when explicitly requested. */
  rawMode?: 'full' | 'reference';
  /** Move large content/tool/raw blobs out of hot event rows by default. */
  payloadMode?: 'inline' | 'external';
  payloadThresholdBytes?: number;
  indexBatchSize?: number;
  /** Log per-session progress to stderr. */
  verbose?: boolean;
  /** Only run the adapters whose harness names are listed. */
  only?: Harness[];
}

interface KnownRow {
  raw_path: string;
  mtime_ms: number;
}

export async function indexSessions(
  db: TracebenchDb,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const t0 = Date.now();
  const result: IndexResult = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    deferred: 0,
    per_harness: {},
    errors: [],
    duration_ms: 0,
  };

  const targets = opts.only
    ? ADAPTERS.filter((a) => opts.only!.includes(a.harness))
    : ADAPTERS;

  for (const adapter of targets) {
    const root = opts.roots?.[adapter.harness];
    const stats = { scanned: 0, indexed: 0, skipped: 0, deferred: 0 };

    adapter.beginIndexPass?.(root);
    try {
      // Load known sessions for this adapter
      const knownRows = db.raw
        .prepare(
          'SELECT raw_path, mtime_ms FROM sessions WHERE harness = ? AND format_version = ?',
        )
        .all(adapter.harness, adapter.formatVersion) as KnownRow[];
      const known = new Map(knownRows.map((r) => [r.raw_path, r.mtime_ms]));

      let discovered: AdapterDiscovered[];
      try {
        discovered = adapter.discover(root, {
          cursorGlobalDbPath: opts.cursorGlobalDbPath,
        });
      } catch (e) {
        // Adapter root may not exist (e.g. user doesn't have Codex installed).
        // Treat as zero sessions, not an error.
        if (opts.verbose) {
          process.stderr.write(`[${adapter.harness}] discover failed: ${e}\n`);
        }
        discovered = [];
      }

      stats.scanned = discovered.length;

      for (const d of discovered) {
        upsertDiscoveredSession(db, {
          harness: adapter.harness,
          session_id: d.session_id,
          raw_path: d.file_path,
          format_version: adapter.formatVersion,
          source_size: d.size,
          mtime_ms: d.mtime_ms,
        });
      }

      let indexedThisHarness = 0;
      let selectedBytesThisHarness = 0;
      const sessionFilter = opts.sessionIds ? new Set(opts.sessionIds) : null;
      for (const d of discovered) {
        if (sessionFilter && !sessionFilter.has(d.session_id)) {
          stats.deferred++;
          continue;
        }
        if (opts.sinceMs != null && d.mtime_ms < opts.sinceMs) {
          stats.deferred++;
          continue;
        }
        if (!opts.full) {
          const prev = known.get(d.file_path);
          if (prev != null && prev >= d.mtime_ms) {
            stats.skipped++;
            continue;
          }
        }
        if (
          opts.maxSessionsPerHarness != null &&
          indexedThisHarness >= opts.maxSessionsPerHarness
        ) {
          stats.deferred++;
          continue;
        }
        if (
          opts.maxSourceBytesPerHarness != null &&
          selectedBytesThisHarness + d.size > opts.maxSourceBytesPerHarness &&
          indexedThisHarness > 0
        ) {
          stats.deferred++;
          continue;
        }
        try {
          await indexOne(db, adapter, d, opts);
          stats.indexed++;
          indexedThisHarness++;
          selectedBytesThisHarness += d.size;
          if (opts.verbose) {
            process.stderr.write(`[${adapter.harness}] indexed ${d.session_id}\n`);
          }
        } catch (e) {
          markDiscoveredSessionError(
            db,
            adapter.harness,
            d.file_path,
            e instanceof Error ? e.message : String(e),
          );
          result.errors.push({
            file: d.file_path,
            harness: adapter.harness,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      result.per_harness[adapter.harness] = stats;
      result.scanned += stats.scanned;
      result.indexed += stats.indexed;
      result.skipped += stats.skipped;
      result.deferred += stats.deferred;
    } finally {
      adapter.endIndexPass?.();
    }
  }

  result.duration_ms = Date.now() - t0;
  if (result.indexed > 0) {
    checkpointWal(db);
  }
  return result;
}

async function indexOne(
  db: TracebenchDb,
  adapter: AdapterModule,
  d: AdapterDiscovered,
  opts: IndexOptions,
): Promise<void> {
  markDiscoveredSessionIndexing(db, adapter.harness, d.file_path);
  const runId = beginIndexRun(db, {
    harness: adapter.harness,
    session_id: d.session_id,
    raw_path: d.file_path,
  });
  try {
    const aggregate = createAggregateAccumulator();
    let session: Session | null = null;
    let seq = 0;

    if (adapter.streamLoad) {
      for await (const chunk of adapter.streamLoad(d.file_path, {
        batchSize: opts.indexBatchSize,
      })) {
        if (chunk.type === 'session') {
          session = { ...chunk.session, mtime_ms: d.mtime_ms };
          continue;
        }
        aggregate.add(chunk.events);
        seq = stageEvents(db, runId, chunk.events, seq, {
          rawMode: opts.rawMode ?? 'reference',
          payloadMode: opts.payloadMode ?? 'external',
          payloadThresholdBytes: opts.payloadThresholdBytes,
        });
      }
    } else {
      const loaded = await adapter.load(d.file_path);
      session = { ...loaded.session, mtime_ms: d.mtime_ms };
      aggregate.add(loaded.events);
      seq = stageEvents(db, runId, loaded.events, seq, {
        rawMode: opts.rawMode ?? 'reference',
        payloadMode: opts.payloadMode ?? 'external',
        payloadThresholdBytes: opts.payloadThresholdBytes,
      });
    }

    if (!session) {
      throw new Error(`adapter ${adapter.harness} did not produce a session header`);
    }
    stageSession(db, runId, session, aggregate.value());
    publishIndexRun(db, runId, {
      harness: adapter.harness,
      rawPath: d.file_path,
      state: 'hot',
    });
  } catch (e) {
    failIndexRun(db, runId, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

interface AggregateAccumulator {
  add(events: readonly CanonicalEvent[]): void;
  value(): SessionAggregateRow;
}

function createAggregateAccumulator(): AggregateAccumulator {
  let total_cost_usd = 0;
  let total_input_tokens = 0;
  let total_output_tokens = 0;
  let total_cache_read_tokens = 0;
  let total_cache_create_tokens = 0;
  let total_reasoning_tokens = 0;
  let duration_ms = 0;
  let tool_call_count = 0;
  let tool_error_count = 0;
  let message_count = 0;
  const turnIds = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  return {
    add(events) {
      for (const e of events) {
        if (e.cost_usd != null) total_cost_usd += e.cost_usd;
        if (e.tokens.input != null) total_input_tokens += e.tokens.input;
        if (e.tokens.output != null) total_output_tokens += e.tokens.output;
        if (e.tokens.cache_read != null) total_cache_read_tokens += e.tokens.cache_read;
        if (e.tokens.cache_creation != null) {
          total_cache_create_tokens += e.tokens.cache_creation;
        }
        if (e.tokens.reasoning != null) total_reasoning_tokens += e.tokens.reasoning;
        if (e.duration_ms != null) duration_ms += e.duration_ms;
        if (e.event_type === 'tool_call') tool_call_count++;
        if (e.tool.status === 'error') tool_error_count++;
        if (e.event_type === 'message') message_count++;
        if (e.turn_id) turnIds.add(e.turn_id);
        if (e.timestamp) {
          if (!firstTs || e.timestamp < firstTs) firstTs = e.timestamp;
          if (!lastTs || e.timestamp > lastTs) lastTs = e.timestamp;
        }
      }
    },
    value() {
      let resolvedDurationMs = duration_ms;
      if (resolvedDurationMs === 0 && firstTs && lastTs) {
        resolvedDurationMs = Math.max(
          0,
          new Date(lastTs).getTime() - new Date(firstTs).getTime(),
        );
      }
      return {
        total_cost_usd,
        total_input_tokens,
        total_output_tokens,
        total_cache_read_tokens,
        total_cache_create_tokens,
        total_reasoning_tokens,
        duration_ms: resolvedDurationMs,
        turn_count: turnIds.size,
        tool_call_count,
        tool_error_count,
        message_count,
      };
    },
  };
}

function checkpointWal(db: TracebenchDb): void {
  try {
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Checkpointing is best-effort; never fail an otherwise successful index.
  }
}
