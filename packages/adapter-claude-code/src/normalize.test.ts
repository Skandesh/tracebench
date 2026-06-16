import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, normalizeSession, streamLoadSession } from './normalize.js';
import { parseSession } from './parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('fixture 01 — simple Read tool flow', () => {
  it('emits a session + canonical events', async () => {
    const { session, events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    expect(session.session_id).toBe('fix-sess-01');
    expect(session.harness).toBe('claude_code');
    expect(session.project_path).toBe('/Users/me/code/proj');
    expect(session.title).toMatch(/Read the README/);
    expect(session.model).toBe('claude-sonnet-4-5');
    expect(session.started_at).toBe('2026-05-17T14:22:08.000Z');
    expect(session.ended_at).toBe('2026-05-17T14:22:12.000Z');
    expect(events.length).toBeGreaterThan(0);
  });

  it('splits assistant blocks into separate canonical events', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    // The first assistant message has text + tool_use → two events
    const assistantText = events.filter(
      (e) => e.role === 'assistant' && e.event_type === 'message',
    );
    const toolCalls = events.filter((e) => e.event_type === 'tool_call');
    expect(assistantText.length).toBeGreaterThanOrEqual(2); // both turns end with text
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]!.tool.name).toBe('Read');
    expect(toolCalls[0]!.event_id).toBe('toolu_001'); // event_id = tool_use id
  });

  it('attaches usage tokens to the first emitted event of each assistant message only', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const withTokens = events.filter((e) => e.tokens.input != null);
    // 2 assistant messages → 2 events with tokens
    expect(withTokens.length).toBe(2);
    // First one's tokens
    expect(withTokens[0]!.tokens.input).toBe(120);
    expect(withTokens[0]!.tokens.output).toBe(40);
    expect(withTokens[0]!.tokens.cache_creation).toBe(2000);
  });

  it('links tool_result to its tool_use via parent_event_id', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const toolResult = events.find((e) => e.event_type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult!.parent_event_id).toBe('toolu_001');
    expect(toolResult!.tool.status).toBe('success');
    expect(toolResult!.role).toBe('tool');
  });

  it('groups events into turns at user prompts', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const turns = new Set(events.filter((e) => e.role !== 'system').map((e) => e.turn_id));
    // One user prompt → one turn
    expect(turns.size).toBe(1);
  });

  it('computes cost on the token-bearing events', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const withCost = events.filter((e) => e.cost_usd != null);
    expect(withCost.length).toBe(2);
    expect(withCost.every((e) => e.cost_method === 'estimated')).toBe(true);
  });
});

describe('fixture 02 — thinking blocks + multiple tool_uses', () => {
  it('emits thinking events with event_type=thinking', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-multi-block-thinking.jsonl'));
    const thinking = events.filter((e) => e.event_type === 'thinking');
    expect(thinking.length).toBe(1);
    expect(thinking[0]!.content).toMatch(/pool implementation/);
  });

  it('emits 2 tool_calls + 2 tool_results that link properly', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-multi-block-thinking.jsonl'));
    const calls = events.filter((e) => e.event_type === 'tool_call');
    const results = events.filter((e) => e.event_type === 'tool_result');
    expect(calls.length).toBe(2);
    expect(results.length).toBe(2);
    expect(new Set(results.map((r) => r.parent_event_id))).toEqual(
      new Set(['toolu_a', 'toolu_b']),
    );
  });

  it('marks the failing tool_result as error', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-multi-block-thinking.jsonl'));
    const failing = events.find((e) => e.event_type === 'tool_result' && e.tool.status === 'error');
    expect(failing).toBeDefined();
    expect(failing!.parent_event_id).toBe('toolu_b');
  });

  it('starts a new turn when a user prompt arrives', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-multi-block-thinking.jsonl'));
    const turnIds = Array.from(
      new Set(events.filter((e) => e.role !== 'system').map((e) => e.turn_id)),
    );
    // p1 and p2 → 2 turns
    expect(turnIds.length).toBe(2);
  });

  it('uses the assistant message model when no session-level model is set yet', async () => {
    const { session } = await loadSession(join(FIXTURES, '02-multi-block-thinking.jsonl'));
    expect(session.model).toBe('claude-opus-4-7');
  });
});

describe('fixture 03 — orphans, compaction, unknown types, malformed lines', () => {
  it('parses despite an invalid JSON line', async () => {
    const raws = await parseSession(join(FIXTURES, '03-orphan-and-compaction.jsonl'));
    // 7 lines in the fixture, 1 is malformed → 6 raws
    expect(raws.length).toBe(6);
  });

  it('marks tool_result as orphan when its tool_use is missing', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-orphan-and-compaction.jsonl'));
    const orphan = events.find((e) => e.event_type === 'tool_result');
    expect(orphan).toBeDefined();
    expect(orphan!.parent_event_id).toBeNull();
    expect(orphan!.metadata.orphan).toBe(true);
  });

  it('emits compaction event_type', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-orphan-and-compaction.jsonl'));
    expect(events.some((e) => e.event_type === 'compaction')).toBe(true);
  });

  it('emits summary event_type', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-orphan-and-compaction.jsonl'));
    const summary = events.find((e) => e.event_type === 'summary');
    expect(summary).toBeDefined();
    expect(summary!.content).toMatch(/worker pool race/);
  });

  it('handles unknown event types as meta without dropping them', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-orphan-and-compaction.jsonl'));
    const weird = events.find((e) => e.metadata.kind === 'weird-unseen-future-event');
    expect(weird).toBeDefined();
    expect(weird!.event_type).toBe('meta');
  });
});

describe('normalizeSession unit-level', () => {
  it('falls back to filename-derived session_id when no sessionId in events', () => {
    const r = normalizeSession([], {
      rawPath: '/tmp/abc-123.jsonl',
      formatVersion: 'test',
    });
    expect(r.session.session_id).toBe('abc-123');
    expect(r.events.length).toBe(0);
  });
});

describe('streamLoadSession', () => {
  it('emits the same canonical event order in batches with source line locators', async () => {
    const path = join(FIXTURES, '01-simple.jsonl');
    const loaded = await loadSession(path);
    const streamedEvents = [];
    let streamedSession = null as null | typeof loaded.session;
    for await (const chunk of streamLoadSession(path, { batchSize: 2 })) {
      if (chunk.type === 'session') streamedSession = chunk.session;
      else streamedEvents.push(...chunk.events);
    }
    expect(streamedSession?.session_id).toBe(loaded.session.session_id);
    expect(streamedEvents.map((e) => e.event_id)).toEqual(loaded.events.map((e) => e.event_id));
    expect(streamedEvents.some((e) => typeof e.source.line === 'number')).toBe(true);
  });
});
