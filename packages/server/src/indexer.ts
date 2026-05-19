// Multi-adapter incremental indexer.
//
// For each registered adapter, walk its root, compare each session's mtime
// against the DB, and re-index any that are new or changed. Per-session
// updates are atomic (delete then insert).
//
// The indexer accepts an optional per-harness root override so a user can
// point at a non-default Codex / Claude Code dir.

import { upsertSession, insertEvents, deleteSessionEvents, summarizeEvents } from '@tracebench/core';
import type { Harness, TracebenchDb } from '@tracebench/core';
import { ADAPTERS, type AdapterModule, type AdapterDiscovered } from './adapters.js';

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  per_harness: Record<string, { scanned: number; indexed: number; skipped: number }>;
  errors: { file: string; harness: Harness; message: string }[];
  duration_ms: number;
}

export interface IndexOptions {
  /** Override the default discovery root for a specific harness. */
  roots?: Partial<Record<Harness, string>>;
  /** Force re-index ignoring mtime. */
  full?: boolean;
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
    per_harness: {},
    errors: [],
    duration_ms: 0,
  };

  const targets = opts.only
    ? ADAPTERS.filter((a) => opts.only!.includes(a.harness))
    : ADAPTERS;

  for (const adapter of targets) {
    const root = opts.roots?.[adapter.harness];
    const stats = { scanned: 0, indexed: 0, skipped: 0 };

    // Load known sessions for this adapter
    const knownRows = db.raw
      .prepare(
        'SELECT raw_path, mtime_ms FROM sessions WHERE harness = ? AND format_version = ?',
      )
      .all(adapter.harness, adapter.formatVersion) as KnownRow[];
    const known = new Map(knownRows.map((r) => [r.raw_path, r.mtime_ms]));

    let discovered: AdapterDiscovered[];
    try {
      discovered = adapter.discover(root);
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
      if (!opts.full) {
        const prev = known.get(d.file_path);
        if (prev != null && prev >= d.mtime_ms) {
          stats.skipped++;
          continue;
        }
      }
      try {
        await indexOne(db, adapter, d);
        stats.indexed++;
        if (opts.verbose) {
          process.stderr.write(`[${adapter.harness}] indexed ${d.session_id}\n`);
        }
      } catch (e) {
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
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

async function indexOne(
  db: TracebenchDb,
  adapter: AdapterModule,
  d: AdapterDiscovered,
): Promise<void> {
  const { session, events } = await adapter.load(d.file_path);
  session.mtime_ms = d.mtime_ms;
  // Summarize once, in-memory, while we already have all the events. Stored
  // on the sessions row so /api/sessions is a pure SELECT — no GROUP BY.
  const aggregates = summarizeEvents(events);
  const tx = db.raw.transaction(() => {
    deleteSessionEvents(db, session.session_id);
    upsertSession(db, session, aggregates);
    insertEvents(db, events);
  });
  tx();
}
