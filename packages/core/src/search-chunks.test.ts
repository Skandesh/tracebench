import { describe, it, expect } from 'vitest';
import {
  extractSearchChunks,
  extractSearchChunksForEvents,
  MAX_CHUNK_CHARS,
} from './search-chunks.js';
import {
  openDb,
  beginIndexRun,
  stageSession,
  stageSearchChunks,
  publishIndexRun,
  type TracebenchDb,
} from './db.js';
import type { CanonicalEvent, Session } from './schema.js';

let seq = 0;
function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  seq++;
  return {
    event_id: `evt-${seq}`,
    session_id: 'sess-1',
    turn_id: 'turn-1',
    parent_event_id: null,
    timestamp: '2026-06-18T00:00:00.000Z',
    source: { harness: 'claude_code', format_version: '1', raw_path: '/x/y.jsonl' },
    role: 'assistant',
    event_type: 'message',
    model: null,
    tokens: { input: null, output: null, cache_read: null, cache_creation: null, reasoning: null },
    cost_usd: null,
    cost_method: null,
    duration_ms: null,
    content: 'hello world',
    tool: { name: null, input: null, output: null, status: null, error_message: null },
    metadata: {},
    raw: {},
    ...overrides,
  };
}

function makeSession(): Session {
  return {
    session_id: 'sess-1',
    harness: 'claude_code',
    project_path: '/Users/me/proj',
    title: null,
    started_at: '2026-06-18T00:00:00.000Z',
    ended_at: null,
    model: null,
    raw_path: '/x/y.jsonl',
    format_version: '1',
    mtime_ms: 1700000000000,
  };
}

describe('extractSearchChunks (U2)', () => {
  it('emits one chunk for a short string-content event', () => {
    const chunks = extractSearchChunks(makeEvent({ event_id: 'e1', content: 'find the auth bug' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ event_id: 'e1', chunk_seq: 0, session_id: 'sess-1', harness: 'claude_code' });
    expect(chunks[0].text).toContain('find the auth bug');
    expect(chunks[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunks[0].embed_state).toBe('vector-pending');
  });

  it('serializes object content and includes tool name/input/output/error', () => {
    const chunks = extractSearchChunks(
      makeEvent({
        event_id: 'e2',
        content: null,
        event_type: 'tool_call',
        tool: {
          name: 'Bash',
          input: { command: 'pnpm test' },
          output: 'ENOENT: no such file',
          status: 'error',
          error_message: 'command failed',
        },
      }),
    );
    expect(chunks).toHaveLength(1);
    const text = chunks[0].text;
    expect(text).toContain('tool: Bash');
    expect(text).toContain('pnpm test');
    expect(text).toContain('ENOENT');
    expect(text).toContain('command failed');
  });

  it('yields zero chunks for empty / meta-only events', () => {
    expect(extractSearchChunks(makeEvent({ content: null }))).toHaveLength(0);
    expect(extractSearchChunks(makeEvent({ content: '   ' }))).toHaveLength(0);
    expect(extractSearchChunks(makeEvent({ event_type: 'meta', content: null }))).toHaveLength(0);
  });

  it('splits a long event into ordered, distinct-id chunks', () => {
    const long = 'lorem ipsum '.repeat(Math.ceil((MAX_CHUNK_CHARS * 3) / 12));
    const chunks = extractSearchChunks(makeEvent({ event_id: 'big', content: long }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunk_seq)).toEqual(chunks.map((_, i) => i));
    const ids = new Set(chunks.map((c) => c.chunk_id));
    expect(ids.size).toBe(chunks.length); // distinct ids per chunk_seq
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('is deterministic (same event -> identical chunks; input-path-agnostic)', () => {
    const e = makeEvent({ event_id: 'det', content: 'stable text' });
    expect(extractSearchChunks(e)).toEqual(extractSearchChunks(structuredClone(e)));
  });
});

describe('chunker -> stage -> publish -> searchable (U2 integration)', () => {
  it('makes a term that only appears in a tool output findable via FTS', () => {
    const db: TracebenchDb = openDb({ path: ':memory:' });
    const session = makeSession();
    const events = [
      makeEvent({ event_id: 'm1', content: 'lets work on the parser' }),
      makeEvent({
        event_id: 't1',
        content: null,
        event_type: 'tool_result',
        tool: { name: 'Read', input: { file: 'parser.ts' }, output: 'function xyzzyParse() {}', status: 'success', error_message: null },
      }),
    ];
    const runId = beginIndexRun(db, { harness: 'claude_code', session_id: session.session_id, raw_path: session.raw_path });
    stageSession(db, runId, session, {});
    stageSearchChunks(db, runId, extractSearchChunksForEvents(events));
    publishIndexRun(db, runId, { harness: 'claude_code', rawPath: session.raw_path });

    const n = (db.raw.prepare('SELECT count(*) n FROM search_chunks WHERE session_id = ?').get('sess-1') as { n: number }).n;
    expect(n).toBe(2);
    // 'xyzzyParse' only exists in the tool output — trigram finds it as a substring.
    const hit = db.raw.prepare("SELECT rowid FROM fts_tri WHERE fts_tri MATCH 'xyzzyParse'").get();
    expect(hit).toBeTruthy();
    db.close();
  });
});
