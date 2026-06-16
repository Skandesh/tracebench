import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, upsertSession, insertEvents } from '@tracebench/core';
import type { CanonicalEvent, Session } from '@tracebench/core';
import {
  buildStorageReport,
  formatBytes,
  parseByteSize,
  parseSinceMs,
  renderStorageReport,
} from './storage.js';

function emptyRoots() {
  const root = mkdtempSync(join(tmpdir(), 'tracebench-storage-test-'));
  const codex = join(root, 'codex');
  mkdirSync(join(codex, 'sessions'), { recursive: true });
  return {
    claude_code: join(root, 'claude'),
    codex,
    cursor: join(root, 'cursor'),
    opencode: join(root, 'opencode'),
    cursorGlobalDbPath: join(root, 'cursor-user', 'globalStorage', 'state.vscdb'),
  };
}

function makeSession(): Session {
  return {
    session_id: 'sess-storage',
    harness: 'claude_code',
    project_path: '/tmp/proj',
    title: 'Storage test',
    started_at: '2026-05-17T14:22:08.000Z',
    ended_at: null,
    model: 'claude-sonnet-4-5',
    raw_path: '/tmp/source.jsonl',
    format_version: '1',
    mtime_ms: 1700000000000,
  };
}

function makeEvent(output = 'ok'): CanonicalEvent {
  return {
    event_id: 'evt-storage',
    session_id: 'sess-storage',
    turn_id: 'turn-storage',
    parent_event_id: null,
    timestamp: '2026-05-17T14:22:09.000Z',
    source: { harness: 'claude_code', format_version: '1', raw_path: '/tmp/source.jsonl' },
    role: 'tool',
    event_type: 'tool_result',
    model: null,
    tokens: { input: null, output: null, cache_read: null, cache_creation: null, reasoning: null },
    cost_usd: null,
    cost_method: null,
    duration_ms: null,
    content: null,
    tool: { name: 'Bash', input: null, output, status: 'success', error_message: null },
    metadata: {},
    raw: { output },
  };
}

describe('storage helpers', () => {
  it('parses byte sizes and relative since filters', () => {
    expect(parseByteSize('1gb').bytes).toBe(1024 ** 3);
    expect(parseByteSize('2.5 MiB').bytes).toBe(Math.floor(2.5 * 1024 ** 2));
    expect(parseSinceMs('2d', Date.UTC(2026, 5, 16))).toBe(Date.UTC(2026, 5, 14));
    expect(parseSinceMs('2026-06-16T00:00:00Z')).toBe(Date.UTC(2026, 5, 16));
  });

  it('formats bytes for the CLI report', () => {
    expect(formatBytes(42)).toBe('42 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
  });

  it('aggregates DB, source, manifest, and payload sizes without mutating sources', () => {
    const roots = emptyRoots();
    const ccProject = join(roots.claude_code, '-tmp-proj');
    mkdirSync(ccProject, { recursive: true });
    writeFileSync(join(ccProject, 'source-session.jsonl'), '{"type":"hello"}\n');

    const db = openDb({ path: ':memory:' });
    try {
      upsertSession(db, makeSession());
      insertEvents(db, [makeEvent('x'.repeat(1000))], 0, {
        rawMode: 'reference',
        payloadMode: 'external',
        payloadThresholdBytes: 100,
      });

      const report = buildStorageReport({
        db,
        dbPath: ':memory:',
        roots,
        cursorGlobalDbPath: roots.cursorGlobalDbPath,
        topN: 5,
      });
      expect(report.discovery.total_sessions).toBe(1);
      expect(report.discovery.per_harness.claude_code?.discovered).toBe(1);
      expect(report.discovery.indexed_sessions).toBe(1);
      expect(report.payload_bytes.raw_json).toBeLessThan(300);
      expect(report.payload_bytes.external_payload_count).toBe(1);
      expect(report.largest_sources[0]?.harness).toBe('claude_code');
      expect(renderStorageReport(report)).toContain('Tracebench storage report');
    } finally {
      db.close();
    }
  });
});
