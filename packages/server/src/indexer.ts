// Multi-adapter incremental indexer.
//
// For each registered adapter, walk its root, compare each session's mtime
// against the DB, and re-index any that are new or changed. Per-session
// updates are atomic (delete then insert).
//
// The indexer accepts an optional per-harness root override so a user can
// point at a non-default Codex / Claude Code dir.

import {
  upsertSession,
  insertEvents,
  deleteSessionEvents,
  summarizeEvents,
  upsertDiscoveredSession,
  markDiscoveredSessionIndexed,
  markDiscoveredSessionError,
} from '@tracebench/core';
import type { Harness, TracebenchDb } from '@tracebench/core';
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
  const { session, events } = await adapter.load(d.file_path);
  session.mtime_ms = d.mtime_ms;
  // Summarize once, in-memory, while we already have all the events. Stored
  // on the sessions row so /api/sessions is a pure SELECT — no GROUP BY.
  const aggregates = summarizeEvents(events);
  const tx = db.raw.transaction(() => {
    deleteSessionEvents(db, session.session_id);
    upsertSession(db, session, aggregates);
    insertEvents(db, events, 0, {
      rawMode: opts.rawMode ?? 'reference',
      payloadMode: opts.payloadMode ?? 'external',
      payloadThresholdBytes: opts.payloadThresholdBytes,
    });
    markDiscoveredSessionIndexed(db, adapter.harness, d.file_path, 'hot');
  });
  tx();
}

function checkpointWal(db: TracebenchDb): void {
  try {
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Checkpointing is best-effort; never fail an otherwise successful index.
  }
}
