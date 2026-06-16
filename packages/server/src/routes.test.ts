import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.js';
import type { BuiltServer } from './server.js';

// Point each adapter at its fixtures dir so this test doesn't depend on
// whatever's in the user's real ~/.claude/projects or ~/.codex.
const CC_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'adapter-claude-code',
  'fixtures',
);
const CODEX_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'adapter-codex',
  'fixtures',
);
const CURSOR_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'adapter-cursor',
  'fixtures',
);

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createMinimalOpencodeDb } from '../../adapter-opencode/src/db-fixture.js';

let server: BuiltServer;
let ccRoot: string;
let codexRoot: string;
let cursorRoot: string;
let opencodeRoot: string;
let cursorUserDataDir: string;

beforeAll(async () => {
  // Claude Code root layout: <root>/<encoded-project>/<session>.jsonl
  ccRoot = mkdtempSync(join(tmpdir(), 'tracebench-cc-'));
  const ccProj = join(ccRoot, '-fixtures');
  mkdirSync(ccProj, { recursive: true });
  for (const f of readdirSync(CC_FIXTURES)) {
    if (!f.endsWith('.jsonl')) continue;
    writeFileSync(join(ccProj, f), readFileSync(join(CC_FIXTURES, f)));
  }

  // Codex root layout: <root>/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
  // We rename our test fixtures into the expected pattern.
  codexRoot = mkdtempSync(join(tmpdir(), 'tracebench-codex-'));
  const codexDay = join(codexRoot, 'sessions', '2026', '05', '17');
  mkdirSync(codexDay, { recursive: true });
  const codexUuids = [
    '019cab12-0001-7000-0000-000000000001',
    '019cab12-0002-7000-0000-000000000002',
    '019cab12-0003-7000-0000-000000000003',
  ];
  const codexFiles = readdirSync(CODEX_FIXTURES).filter((f) => f.endsWith('.jsonl')).sort();
  codexFiles.forEach((f, i) => {
    const uuid = codexUuids[i] ?? `019cab12-9000-7000-0000-${String(i).padStart(12, '0')}`;
    const target = `rollout-2026-05-17T${String(14 + i).padStart(2, '0')}-22-08-${uuid}.jsonl`;
    writeFileSync(join(codexDay, target), readFileSync(join(CODEX_FIXTURES, f)));
  });

  cursorRoot = mkdtempSync(join(tmpdir(), 'tracebench-cursor-'));
  cursorUserDataDir = mkdtempSync(join(tmpdir(), 'tracebench-cursor-user-'));
  const cursorProj = join(cursorRoot, 'Users-fixtures');
  const mainTranscript = join(
    cursorProj,
    'agent-transcripts',
    'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
  );
  const subTranscript = join(
    cursorProj,
    'agent-transcripts',
    'parent-uuid',
    'subagents',
    'child-uuid.jsonl',
  );
  mkdirSync(dirname(mainTranscript), { recursive: true });
  mkdirSync(dirname(subTranscript), { recursive: true });
  writeFileSync(mainTranscript, readFileSync(join(CURSOR_FIXTURES, '01-simple.jsonl')));
  writeFileSync(subTranscript, readFileSync(join(CURSOR_FIXTURES, '02-subagent.jsonl')));

  opencodeRoot = mkdtempSync(join(tmpdir(), 'tracebench-opencode-'));
  createMinimalOpencodeDb(join(opencodeRoot, 'opencode.db'));

  server = await buildServer({
    dbPath: ':memory:',
    projectsRoot: ccRoot,
    codexRoot,
    cursorRoot,
    opencodeRoot,
    cursorUserDataDir,
    verbose: false,
  });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('GET /api/sessions', () => {
  it('lists indexed sessions with aggregates (both harnesses)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ session_id: string; harness: string; aggregates: { tool_call_count: number } }> };
    expect(body.sessions.length).toBe(9); // three CC + three Codex + two Cursor + one OpenCode
    expect(body.sessions.every((s) => 'aggregates' in s)).toBe(true);
    const byHarness: Record<string, number> = {};
    for (const s of body.sessions) byHarness[s.harness] = (byHarness[s.harness] ?? 0) + 1;
    expect(byHarness.claude_code).toBe(3);
    expect(byHarness.codex).toBe(3);
    expect(byHarness.cursor).toBe(2);
    expect(byHarness.opencode).toBe(1);
  });

  it('filters by harness=claude_code', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?harness=claude_code',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(3);
  });

  it('filters by harness=codex', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?harness=codex',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(3);
  });

  it('searches by query', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?q=race',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ title: string }> };
    expect(body.sessions.some((s) => /race/i.test(s.title))).toBe(true);
  });

  it('filters by harness=cursor', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?harness=cursor',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(2);
  });

  it('filters by harness=opencode', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?harness=opencode',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(1);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns 404 for unknown', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(res.statusCode).toBe(404);
  });

  it('returns session + tool_counts', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions/fix-sess-01',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session: { title: string }; tool_counts: { tool_name: string }[] };
    expect(body.session.title).toMatch(/Read the README/);
    expect(body.tool_counts.some((t) => t.tool_name === 'Read')).toBe(true);
  });
});

describe('GET /api/sessions/:id/turns', () => {
  it('groups events into turns', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions/fix-sess-02/turns',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { turns: { events: unknown[] }[] };
    expect(body.turns.length).toBeGreaterThanOrEqual(2);
    expect(body.turns.every((t) => Array.isArray(t.events))).toBe(true);
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('returns events in order', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/sessions/fix-sess-01/events',
    });
    const body = res.json() as { events: Array<{ timestamp: string; event_type: string; raw: Record<string, unknown> }> };
    expect(body.events.length).toBeGreaterThan(0);
    for (let i = 1; i < body.events.length; i++) {
      // timestamps are monotonically non-decreasing
      expect(body.events[i]!.timestamp >= body.events[i - 1]!.timestamp).toBe(true);
    }
    expect(body.events[0]!.raw._tracebench_raw).toBe('source_ref');
  });
});

describe('GET /api/pricing', () => {
  it('returns the pricing table', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/pricing' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: Record<string, unknown>; _meta: unknown };
    expect(body.models['claude-sonnet-4-5']).toBeDefined();
  });
});

describe('GET /api/storage', () => {
  it('explains discovered, indexed, manifest, and payload storage', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/storage' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      discovery: {
        total_sessions: number;
        indexed_sessions: number;
        manifest_sessions: number;
        per_harness: Record<string, { discovered: number; indexed: number; states: Record<string, number> }>;
      };
      payload_bytes: { raw_json: number; total_json: number; external_payload_count: number };
      largest_sources: unknown[];
    };
    expect(body.discovery.total_sessions).toBe(9);
    expect(body.discovery.indexed_sessions).toBe(9);
    expect(body.discovery.manifest_sessions).toBe(9);
    expect(body.discovery.per_harness.claude_code?.states.hot).toBe(3);
    expect(body.largest_sources.length).toBeGreaterThan(0);
    expect(body.payload_bytes.total_json).toBeGreaterThan(0);
  });
});

describe('GET /api/discovered-sessions', () => {
  it('lists manifest rows separately from indexed session rows', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/discovered-sessions?harness=codex' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ harness: string; index_state: string }> };
    expect(body.sessions.length).toBe(3);
    expect(body.sessions.every((s) => s.harness === 'codex')).toBe(true);
    expect(body.sessions.every((s) => s.index_state === 'hot')).toBe(true);
  });
});

describe('POST /api/reindex', () => {
  it('runs a re-index and returns counts', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/reindex' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scanned: number;
      indexed: number;
      skipped: number;
      deferred: number;
      per_harness: Record<string, { scanned: number; skipped: number; indexed: number; deferred: number }>;
    };
    expect(body.scanned).toBe(9);
    // After the initial index, mtimes haven't changed → all skipped
    expect(body.skipped).toBe(9);
    expect(body.indexed).toBe(0);
    expect(body.deferred).toBe(0);
    expect(body.per_harness.claude_code).toEqual({ scanned: 3, indexed: 0, skipped: 3, deferred: 0 });
    expect(body.per_harness.codex).toEqual({ scanned: 3, indexed: 0, skipped: 3, deferred: 0 });
    expect(body.per_harness.cursor).toEqual({ scanned: 2, indexed: 0, skipped: 2, deferred: 0 });
    expect(body.per_harness.opencode).toEqual({ scanned: 1, indexed: 0, skipped: 1, deferred: 0 });
  });
});

describe('bounded startup freshness', () => {
  it('indexes a bounded latest subset, exposes discovered rows, and backfills explicitly', async () => {
    const boundedCcRoot = mkdtempSync(join(tmpdir(), 'tracebench-bounded-cc-'));
    const ccProj = join(boundedCcRoot, '-fixtures');
    mkdirSync(ccProj, { recursive: true });
    for (const f of readdirSync(CC_FIXTURES)) {
      if (!f.endsWith('.jsonl')) continue;
      writeFileSync(join(ccProj, f), readFileSync(join(CC_FIXTURES, f)));
    }
    const empty = mkdtempSync(join(tmpdir(), 'tracebench-bounded-empty-'));
    const bounded = await buildServer({
      dbPath: ':memory:',
      projectsRoot: boundedCcRoot,
      codexRoot: join(empty, 'codex'),
      cursorRoot: join(empty, 'cursor'),
      opencodeRoot: join(empty, 'opencode'),
      cursorUserDataDir: join(empty, 'cursor-user'),
      maxSessionsPerHarness: 1,
      verbose: false,
    });
    await bounded.app.ready();
    try {
      let res = await bounded.app.inject({ method: 'GET', url: '/api/sessions?harness=claude_code' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(1);

      res = await bounded.app.inject({ method: 'GET', url: '/api/discovered-sessions?harness=claude_code' });
      const manifest = res.json() as { sessions: Array<{ session_id: string; index_state: string }> };
      expect(manifest.sessions.length).toBe(3);
      expect(manifest.sessions.filter((s) => s.index_state === 'hot')).toHaveLength(1);
      expect(manifest.sessions.filter((s) => s.index_state === 'discovered')).toHaveLength(2);

      const deferred = manifest.sessions.find((s) => s.index_state === 'discovered')!;
      res = await bounded.app.inject({
        method: 'POST',
        url: `/api/sessions/${encodeURIComponent(deferred.session_id)}/index`,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { indexed: number }).indexed).toBe(1);

      res = await bounded.app.inject({ method: 'GET', url: '/api/sessions?harness=claude_code' });
      expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(2);

      res = await bounded.app.inject({
        method: 'POST',
        url: '/api/reindex?harness=claude_code&indexAll=1&full=1',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { indexed: number }).indexed).toBe(3);

      res = await bounded.app.inject({ method: 'GET', url: '/api/sessions?harness=claude_code' });
      expect((res.json() as { sessions: unknown[] }).sessions.length).toBe(3);
    } finally {
      await bounded.app.close();
    }
  });
});

describe('non-API routes', () => {
  it('serves a landing page at /', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
