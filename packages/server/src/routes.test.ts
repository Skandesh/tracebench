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

let server: BuiltServer;
let ccRoot: string;
let codexRoot: string;
let cursorRoot: string;

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

  server = await buildServer({
    dbPath: ':memory:',
    projectsRoot: ccRoot,
    codexRoot,
    cursorRoot,
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
    expect(body.sessions.length).toBe(8); // three CC + three Codex + two Cursor fixtures
    expect(body.sessions.every((s) => 'aggregates' in s)).toBe(true);
    const byHarness: Record<string, number> = {};
    for (const s of body.sessions) byHarness[s.harness] = (byHarness[s.harness] ?? 0) + 1;
    expect(byHarness.claude_code).toBe(3);
    expect(byHarness.codex).toBe(3);
    expect(byHarness.cursor).toBe(2);
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
    const body = res.json() as { events: Array<{ timestamp: string; event_type: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    for (let i = 1; i < body.events.length; i++) {
      // timestamps are monotonically non-decreasing
      expect(body.events[i]!.timestamp >= body.events[i - 1]!.timestamp).toBe(true);
    }
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

describe('POST /api/reindex', () => {
  it('runs a re-index and returns counts', async () => {
    const res = await server.app.inject({ method: 'POST', url: '/api/reindex' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scanned: number;
      indexed: number;
      skipped: number;
      per_harness: Record<string, { scanned: number; skipped: number; indexed: number }>;
    };
    expect(body.scanned).toBe(8);
    // After the initial index, mtimes haven't changed → all skipped
    expect(body.skipped).toBe(8);
    expect(body.indexed).toBe(0);
    expect(body.per_harness.claude_code).toEqual({ scanned: 3, indexed: 0, skipped: 3 });
    expect(body.per_harness.codex).toEqual({ scanned: 3, indexed: 0, skipped: 3 });
    expect(body.per_harness.cursor).toEqual({ scanned: 2, indexed: 0, skipped: 2 });
  });
});

describe('non-API routes', () => {
  it('serves a landing page at /', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
