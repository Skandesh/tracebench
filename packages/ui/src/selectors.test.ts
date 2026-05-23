import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, Turn } from './types';
import { filterTurnsByTool, indexToolResultsByCall, listFilteredToolCalls } from './selectors';

const emptyTokens = {
  input: null,
  output: null,
  cache_read: null,
  cache_creation: null,
  reasoning: null,
};

const emptyTool = {
  name: null,
  input: null,
  output: null,
  status: null,
  error_message: null,
};

const source = {
  harness: 'codex' as const,
  format_version: 'test',
  raw_path: '/tmp/test.jsonl',
};

function evt(
  partial: Pick<CanonicalEvent, 'event_id' | 'event_type'> &
    Partial<CanonicalEvent>,
): CanonicalEvent {
  return {
    session_id: 'sess-1',
    turn_id: 'turn-1',
    parent_event_id: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    source,
    role: 'assistant',
    model: null,
    tokens: emptyTokens,
    cost_usd: null,
    cost_method: null,
    duration_ms: null,
    content: null,
    tool: emptyTool,
    metadata: {},
    raw: {},
    ...partial,
  };
}

function turn(turnId: string, events: CanonicalEvent[]): Turn {
  return {
    turn_id: turnId,
    session_id: 'sess-1',
    started_at: events[0]?.timestamp ?? '2026-01-01T00:00:00.000Z',
    ended_at: events.at(-1)?.timestamp ?? '2026-01-01T00:00:00.000Z',
    events,
  };
}

describe('filterTurnsByTool', () => {
  const turns: Turn[] = [
    turn('t1', [
      evt({
        event_id: 'msg-1',
        event_type: 'message',
        role: 'user',
        content: 'hello',
      }),
      evt({
        event_id: 'call-a',
        event_type: 'tool_call',
        tool: { ...emptyTool, name: 'ToolA', input: {} },
      }),
      evt({
        event_id: 'res-a',
        event_type: 'tool_result',
        role: 'tool',
        parent_event_id: 'call-a',
        tool: { ...emptyTool, name: 'ToolA', output: 'ok' },
      }),
      evt({
        event_id: 'call-b',
        event_type: 'tool_call',
        tool: { ...emptyTool, name: 'ToolB', input: {} },
      }),
      evt({
        event_id: 'res-b',
        event_type: 'tool_result',
        role: 'tool',
        parent_event_id: 'call-b',
        tool: { ...emptyTool, name: 'ToolB', output: 'done' },
      }),
    ]),
    turn('t2', [
      evt({
        event_id: 'msg-2',
        event_type: 'message',
        role: 'assistant',
        content: 'no tools here',
      }),
    ]),
    turn('t3', [
      evt({
        event_id: 'call-b2',
        event_type: 'tool_call',
        tool: { ...emptyTool, name: 'ToolB', input: {} },
      }),
      evt({
        event_id: 'res-b2',
        event_type: 'tool_result',
        role: 'tool',
        parent_event_id: 'call-b2',
        tool: { ...emptyTool, name: 'ToolB', output: 'again' },
      }),
    ]),
  ];

  it('returns input unchanged when filterTool is null', () => {
    expect(filterTurnsByTool(turns, null)).toBe(turns);
  });

  it('keeps only turns with matching tool calls and strips messages', () => {
    const filtered = filterTurnsByTool(turns, 'ToolA');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.turn_id).toBe('t1');
    expect(filtered[0]!.events.map((e) => e.event_id)).toEqual(['call-a', 'res-a']);
  });

  it('switches from tool A to tool B', () => {
    const a = filterTurnsByTool(turns, 'ToolA');
    const b = filterTurnsByTool(turns, 'ToolB');

    expect(a.flatMap((t) => t.events.map((e) => e.event_id))).toEqual(['call-a', 'res-a']);
    expect(b).toHaveLength(2);
    expect(b.flatMap((t) => t.events.map((e) => e.event_id))).toEqual([
      'call-b',
      'res-b',
      'call-b2',
      'res-b2',
    ]);
  });

  it('restores full turns when filter clears', () => {
    filterTurnsByTool(turns, 'ToolA');
    expect(filterTurnsByTool(turns, null)).toBe(turns);
  });

  it('returns empty when no tool matches', () => {
    expect(filterTurnsByTool(turns, 'MissingTool')).toEqual([]);
  });

  it('preserves tool_result pairing for visible calls', () => {
    const filtered = filterTurnsByTool(turns, 'ToolB');
    for (const t of filtered) {
      const byCall = indexToolResultsByCall(t.events);
      for (const e of t.events) {
        if (e.event_type !== 'tool_call') continue;
        expect(byCall.get(e.event_id)?.event_id).toMatch(/^res-/);
      }
    }
  });
});

describe('listFilteredToolCalls', () => {
  const turns: Turn[] = [
    turn('t1', [
      evt({
        event_id: 'call-a',
        event_type: 'tool_call',
        tool: { ...emptyTool, name: 'ToolA', input: {} },
      }),
      evt({
        event_id: 'res-a',
        event_type: 'tool_result',
        role: 'tool',
        parent_event_id: 'call-a',
        tool: { ...emptyTool, name: 'ToolA', output: 'ok' },
      }),
      evt({
        event_id: 'call-b',
        event_type: 'tool_call',
        tool: { ...emptyTool, name: 'ToolB', input: {} },
      }),
    ]),
  ];

  it('returns flat call/result pairs in order', () => {
    const pairs = listFilteredToolCalls(turns, 'ToolA');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.call.event_id).toBe('call-a');
    expect(pairs[0]!.result?.event_id).toBe('res-a');
  });

  it('switches cleanly between tool names', () => {
    expect(listFilteredToolCalls(turns, 'ToolA')).toHaveLength(1);
    expect(listFilteredToolCalls(turns, 'ToolB')).toHaveLength(1);
    expect(listFilteredToolCalls(turns, 'ToolB')[0]!.call.event_id).toBe('call-b');
  });
});
