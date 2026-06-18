import { existsSync, statSync } from 'node:fs';
import type { TracebenchDb, Harness } from '@tracebench/core';
import { ADAPTERS } from './adapters.js';

export interface ByteParseResult {
  bytes: number;
  normalized: string;
}

export function parseByteSize(input: string): ByteParseResult {
  const raw = input.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|bytes?)?$/i.exec(raw);
  if (!match) throw new Error(`invalid byte size: ${input}`);
  const n = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const multiplier = multipliers[unit];
  if (!multiplier) throw new Error(`invalid byte size unit: ${unit}`);
  return { bytes: Math.floor(n * multiplier), normalized: `${n}${unit}` };
}

export function parseSinceMs(input: string, now = Date.now()): number {
  const raw = input.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([hdwmy])$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const multipliers: Record<string, number> = {
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      m: 30 * 24 * 60 * 60 * 1000,
      y: 365 * 24 * 60 * 60 * 1000,
    };
    return now - n * multipliers[unit]!;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`invalid since value: ${input}`);
  return parsed;
}

export interface StorageReportOptions {
  db?: TracebenchDb;
  dbPath?: string;
  roots?: Partial<Record<Harness, string | undefined>>;
  cursorGlobalDbPath?: string;
  topN?: number;
}

export interface StorageReport {
  db: {
    path: string | null;
    exists: boolean;
    bytes: number;
    wal_bytes: number;
    shm_bytes: number;
    total_bytes: number;
  };
  discovery: {
    total_sessions: number;
    total_source_bytes: number;
    indexed_sessions: number;
    manifest_sessions: number;
    per_harness: Record<
      string,
      {
        discovered: number;
        source_bytes: number;
        indexed: number;
        manifest: number;
        states: Record<string, number>;
      }
    >;
  };
  largest_sources: Array<{
    harness: Harness;
    session_id: string;
    file_path: string;
    size: number;
    mtime_ms: number;
    index_state: string | null;
  }>;
  payload_bytes: {
    source_json: number;
    tokens_json: number;
    tool_json: number;
    content_json: number;
    metadata_json: number;
    raw_json: number;
    external_payload_bytes: number;
    external_payload_compressed_bytes: number;
    external_payload_count: number;
    total_json: number;
  };
  index_runs: {
    total: number;
    indexing: number;
    published: number;
    error: number;
  };
}

export function buildStorageReport(opts: StorageReportOptions): StorageReport {
  const topN = opts.topN ?? 20;
  const dbStats = dbFileStats(opts.dbPath);
  const manifest = readManifest(opts.db);
  const manifestBySource = new Map(
    manifest.map((m) => [manifestKey(m.harness, m.raw_path), m]),
  );
  const indexedByHarness = readIndexedCounts(opts.db);
  const payload = readPayloadBytes(opts.db);
  const indexRuns = readIndexRunCounts(opts.db);

  const perHarness: StorageReport['discovery']['per_harness'] = {};
  const largest: StorageReport['largest_sources'] = [];
  let totalSessions = 0;
  let totalSourceBytes = 0;

  for (const adapter of ADAPTERS) {
    let discovered: Array<{ session_id: string; file_path: string; size: number; mtime_ms: number }> = [];
    try {
      discovered = adapter.discover(opts.roots?.[adapter.harness], {
        cursorGlobalDbPath: opts.cursorGlobalDbPath,
      });
    } catch {
      discovered = [];
    }
    const states: Record<string, number> = {};
    const manifestRows = manifest.filter((m) => m.harness === adapter.harness);
    for (const row of manifestRows) {
      states[row.index_state] = (states[row.index_state] ?? 0) + 1;
    }
    const sourceBytes = discovered.reduce((sum, d) => sum + d.size, 0);
    totalSessions += discovered.length;
    totalSourceBytes += sourceBytes;
    perHarness[adapter.harness] = {
      discovered: discovered.length,
      source_bytes: sourceBytes,
      indexed: indexedByHarness[adapter.harness] ?? 0,
      manifest: manifestRows.length,
      states,
    };
    for (const d of discovered) {
      const manifestRow = manifestBySource.get(manifestKey(adapter.harness, d.file_path));
      largest.push({
        harness: adapter.harness,
        session_id: d.session_id,
        file_path: d.file_path,
        size: d.size,
        mtime_ms: d.mtime_ms,
        index_state: manifestRow?.index_state ?? null,
      });
    }
  }

  largest.sort((a, b) => b.size - a.size);

  return {
    db: dbStats,
    discovery: {
      total_sessions: totalSessions,
      total_source_bytes: totalSourceBytes,
      indexed_sessions: Object.values(indexedByHarness).reduce((a, b) => a + b, 0),
      manifest_sessions: manifest.length,
      per_harness: perHarness,
    },
    largest_sources: largest.slice(0, topN),
    payload_bytes: payload,
    index_runs: indexRuns,
  };
}

function manifestKey(harness: Harness, rawPath: string): string {
  return `${harness}\0${rawPath}`;
}

function dbFileStats(path?: string): StorageReport['db'] {
  if (!path || path === ':memory:') {
    return { path: path ?? null, exists: false, bytes: 0, wal_bytes: 0, shm_bytes: 0, total_bytes: 0 };
  }
  const bytes = fileSize(path);
  const wal = fileSize(`${path}-wal`);
  const shm = fileSize(`${path}-shm`);
  return {
    path,
    exists: existsSync(path),
    bytes,
    wal_bytes: wal,
    shm_bytes: shm,
    total_bytes: bytes + wal + shm,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface ManifestRow {
  harness: Harness;
  raw_path: string;
  index_state: string;
}

function readManifest(db?: TracebenchDb): ManifestRow[] {
  if (!db || !tableExists(db, 'discovered_sessions')) return [];
  return db.raw
    .prepare('SELECT harness, raw_path, index_state FROM discovered_sessions')
    .all() as ManifestRow[];
}

function readIndexedCounts(db?: TracebenchDb): Record<string, number> {
  if (!db || !tableExists(db, 'sessions')) return {};
  const rows = db.raw
    .prepare('SELECT harness, COUNT(*) AS count FROM sessions GROUP BY harness')
    .all() as { harness: string; count: number }[];
  return Object.fromEntries(rows.map((r) => [r.harness, r.count]));
}

function readPayloadBytes(db?: TracebenchDb): StorageReport['payload_bytes'] {
  const empty = {
    source_json: 0,
    tokens_json: 0,
    tool_json: 0,
    content_json: 0,
    metadata_json: 0,
    raw_json: 0,
    external_payload_bytes: 0,
    external_payload_compressed_bytes: 0,
    external_payload_count: 0,
    total_json: 0,
  };
  if (!db || !tableExists(db, 'events')) return empty;
  const row = db.raw
    .prepare(
      `SELECT
         COALESCE(SUM(length(source_json)), 0) AS source_json,
         COALESCE(SUM(length(tokens_json)), 0) AS tokens_json,
         COALESCE(SUM(length(tool_json)), 0) AS tool_json,
         COALESCE(SUM(length(content_json)), 0) AS content_json,
         COALESCE(SUM(length(metadata_json)), 0) AS metadata_json,
         COALESCE(SUM(length(raw_json)), 0) AS raw_json
       FROM events`,
    )
    .get() as Omit<StorageReport['payload_bytes'], 'total_json'>;
  const external = readExternalPayloadBytes(db);
  const total =
    row.source_json +
    row.tokens_json +
    row.tool_json +
    row.content_json +
    row.metadata_json +
    row.raw_json;
  return { ...row, ...external, total_json: total };
}

function readIndexRunCounts(db?: TracebenchDb): StorageReport['index_runs'] {
  const empty = { total: 0, indexing: 0, published: 0, error: 0 };
  if (!db || !tableExists(db, 'index_runs')) return empty;
  const rows = db.raw
    .prepare('SELECT state, COUNT(*) AS count FROM index_runs GROUP BY state')
    .all() as { state: 'indexing' | 'published' | 'error'; count: number }[];
  const out = { ...empty };
  for (const row of rows) {
    out.total += row.count;
    if (row.state in out) out[row.state] = row.count;
  }
  return out;
}

function readExternalPayloadBytes(
  db: TracebenchDb,
): Pick<
  StorageReport['payload_bytes'],
  'external_payload_bytes' | 'external_payload_compressed_bytes' | 'external_payload_count'
> {
  if (!tableExists(db, 'event_payloads')) {
    return {
      external_payload_bytes: 0,
      external_payload_compressed_bytes: 0,
      external_payload_count: 0,
    };
  }
  const row = db.raw
    .prepare(
      `SELECT
         COALESCE(SUM(byte_length), 0) AS external_payload_bytes,
         COALESCE(SUM(length(body)), 0) AS external_payload_compressed_bytes,
         COUNT(*) AS external_payload_count
       FROM event_payloads`,
    )
    .get() as Pick<
    StorageReport['payload_bytes'],
    'external_payload_bytes' | 'external_payload_compressed_bytes' | 'external_payload_count'
  >;
  return row;
}

function tableExists(db: TracebenchDb, table: string): boolean {
  const row = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return !!row;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function renderStorageReport(report: StorageReport): string {
  const lines: string[] = [];
  lines.push('Tracebench storage report');
  lines.push('=========================');
  lines.push('');
  lines.push(`DB: ${report.db.path ?? '(none)'}`);
  lines.push(`DB exists: ${report.db.exists ? 'yes' : 'no'}`);
  lines.push(`DB size: ${formatBytes(report.db.bytes)}`);
  lines.push(`WAL size: ${formatBytes(report.db.wal_bytes)}`);
  lines.push(`Total Tracebench DB footprint: ${formatBytes(report.db.total_bytes)}`);
  lines.push('');
  lines.push(`Discovered source sessions: ${report.discovery.total_sessions}`);
  lines.push(`Discovered source bytes: ${formatBytes(report.discovery.total_source_bytes)}`);
  lines.push(`Indexed sessions: ${report.discovery.indexed_sessions}`);
  lines.push(`Manifest sessions: ${report.discovery.manifest_sessions}`);
  if (report.index_runs.indexing > 0 || report.index_runs.error > 0) {
    lines.push(
      `Index runs: ${report.index_runs.indexing} active, ${report.index_runs.error} failed`,
    );
  }
  lines.push('');
  lines.push('By harness:');
  for (const [h, s] of Object.entries(report.discovery.per_harness)) {
    const states = Object.entries(s.states)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ') || 'none';
    lines.push(
      `- ${h}: discovered ${s.discovered}, indexed ${s.indexed}, source ${formatBytes(s.source_bytes)}, states ${states}`,
    );
  }
  lines.push('');
  lines.push('Stored JSON payload bytes:');
  lines.push(`- raw_json: ${formatBytes(report.payload_bytes.raw_json)}`);
  lines.push(`- content_json: ${formatBytes(report.payload_bytes.content_json)}`);
  lines.push(`- tool_json: ${formatBytes(report.payload_bytes.tool_json)}`);
  lines.push(`- metadata/source/tokens: ${formatBytes(
    report.payload_bytes.metadata_json +
      report.payload_bytes.source_json +
      report.payload_bytes.tokens_json,
  )}`);
  lines.push(`- total JSON blobs: ${formatBytes(report.payload_bytes.total_json)}`);
  lines.push(
    `- external payload archive: ${report.payload_bytes.external_payload_count} payloads, ${formatBytes(report.payload_bytes.external_payload_compressed_bytes)} compressed (${formatBytes(report.payload_bytes.external_payload_bytes)} original)`,
  );
  lines.push('');
  lines.push('Largest sources:');
  for (const row of report.largest_sources) {
    lines.push(
      `- ${formatBytes(row.size)} ${row.harness} ${row.session_id} ${row.index_state ?? 'not in manifest'} ${row.file_path}`,
    );
  }
  return lines.join('\n');
}
