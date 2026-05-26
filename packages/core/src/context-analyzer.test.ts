import { describe, it, expect } from 'vitest';
import type { CanonicalEvent, Turn } from './schema.js';
import {
  analyzeSessionContext,
  guessContextMax,
  __testables,
} from './context-analyzer.js';
import { loadPricingTable } from './pricing.js';

const table = loadPricingTable();
const {
  classifyEvent,
  estimateTokens,
  toolInputFingerprint,
  computeAttentionZones,
  componentInValley,
  buildSnapshot,
} = __testables();

function baseEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    event_id: 'evt-1',
    session_id: 'sess-1',
    turn_id: 'turn-1',
    parent_event_id: null,
    timestamp: '2025-01-01T00:00:00.000Z',
    source: { harness: 'claude_code', format_version: '1', raw_path: '/tmp/x.jsonl' },
    role: 'user',
    event_type: 'message',
    model: 'claude-sonnet-4-5',
    tokens: {
      input: null,
      output: null,
      cache_read: null,
      cache_creation: null,
      reasoning: null,
    },
    cost_usd: null,
    cost_method: null,
    duration_ms: null,
    content: 'hello',
    tool: { name: null, input: null, output: null, status: null, error_message: null },
    metadata: {},
    raw: {},
    ...overrides,
  };
}

function turn(id: string, events: CanonicalEvent[]): Turn {
  return {
    turn_id: id,
    session_id: 'sess-1',
    started_at: '2025-01-01T00:00:00.000Z',
    ended_at: '2025-01-01T00:01:00.000Z',
    events,
  };
}

describe('guessContextMax', () => {
  it('uses pricing table max for known models', () => {
    expect(guessContextMax('claude-sonnet-4-5', table)).toBe(200_000);
  });

  it('returns 1M for opus-4-7', () => {
    expect(guessContextMax('claude-opus-4-7-20260416', table)).toBe(1_000_000);
  });

  it('falls back when model unknown', () => {
    expect(guessContextMax(null, table)).toBe(200_000);
  });
});

describe('estimateTokens', () => {
  it('prefers billed token fields when present', () => {
    const e = baseEvent({ tokens: { input: 500, output: null, cache_read: 100, cache_creation: null, reasoning: null } });
    expect(estimateTokens(e).tokenCount).toBe(600);
  });

  it('estimates from char count when tokens absent', () => {
    const e = baseEvent({ content: 'abcd', tokens: { input: null, output: null, cache_read: null, cache_creation: null, reasoning: null } });
    expect(estimateTokens(e).tokenCount).toBe(1);
    expect(estimateTokens(e).charCount).toBe(4);
  });

  it('estimates tool_result output size', () => {
    const e = baseEvent({
      event_type: 'tool_result',
      role: 'tool',
      content: null,
      tool: {
        name: 'Read',
        input: null,
        output: 'x'.repeat(400),
        status: 'success',
        error_message: null,
      },
    });
    expect(estimateTokens(e).tokenCount).toBe(100);
  });
});

describe('classifyEvent', () => {
  it('classifies system and user messages', () => {
    expect(classifyEvent(baseEvent({ role: 'system' }), 0, 0)).toBe('system');
    expect(classifyEvent(baseEvent({ role: 'user', event_type: 'message' }), 0, 0)).toBe('current_user');
    expect(classifyEvent(baseEvent({ role: 'user', event_type: 'message' }), 0, 1)).toBe('prior_user');
  });

  it('classifies tool results and thinking', () => {
    expect(classifyEvent(baseEvent({ event_type: 'tool_result', role: 'tool' }), 0, 0)).toBe('prior_tool_output');
    expect(classifyEvent(baseEvent({ event_type: 'thinking', role: 'assistant', content: 'hmm' }), 0, 0)).toBe('thinking');
  });
});

describe('buildSnapshot composition', () => {
  it('stacks position_start/end across components', () => {
    const turns = [
      turn('t1', [
        baseEvent({ event_id: 'u1', role: 'user', content: 'a'.repeat(40) }),
        baseEvent({
          event_id: 'a1',
          role: 'assistant',
          event_type: 'message',
          content: 'b'.repeat(40),
        }),
      ]),
    ];
    const snap = buildSnapshot(turns, 0, 'claude-sonnet-4-5', 200_000);
    expect(snap.components).toHaveLength(2);
    expect(snap.components[0]!.position_start).toBe(0);
    expect(snap.components[0]!.position_end).toBe(10);
    expect(snap.components[1]!.position_start).toBe(10);
    expect(snap.components[1]!.position_end).toBe(20);
  });

  it('accumulates prior turns in later snapshots', () => {
    const turns = [
      turn('t1', [baseEvent({ event_id: 'u1', role: 'user', content: 'first' })]),
      turn('t2', [baseEvent({ event_id: 'u2', role: 'user', content: 'second' })]),
    ];
    const snap = buildSnapshot(turns, 1, 'claude-sonnet-4-5', 200_000);
    const kinds = snap.components.map((c) => c.kind);
    expect(kinds).toContain('prior_user');
    expect(kinds).toContain('current_user');
  });
});

describe('attention zones', () => {
  it('splits context into 20/60/20 bands', () => {
    const zones = computeAttentionZones(1000);
    expect(zones.primacy_end).toBe(200);
    expect(zones.valley_start).toBe(200);
    expect(zones.valley_end).toBe(800);
    expect(zones.recency_start).toBe(800);
  });

  it('flags components whose midpoint lies in the valley', () => {
    const zones = computeAttentionZones(1000);
    const inValley = componentInValley(
      { kind: 'prior_tool_output', source_event_id: 'x', token_count: 100, char_count: 400, cached: null, position_start: 300, position_end: 400 },
      zones,
    );
    const notInValley = componentInValley(
      { kind: 'prior_tool_output', source_event_id: 'y', token_count: 100, char_count: 400, cached: null, position_start: 50, position_end: 150 },
      zones,
    );
    expect(inValley).toBe(true);
    expect(notInValley).toBe(false);
  });
});

describe('toolInputFingerprint', () => {
  it('fingerprints Read by file_path', () => {
    expect(toolInputFingerprint('Read', { file_path: '/src/foo.ts' })).toBe('Read:/src/foo.ts');
  });

  it('fingerprints Grep by pattern and path', () => {
    expect(toolInputFingerprint('Grep', { pattern: 'TODO', path: 'src/' })).toBe('Grep:TODO:src/');
  });
});

describe('waste detection', () => {
  it('detects duplicate Read calls', () => {
    const turns = [
      turn('t1', [
        baseEvent({
          event_id: 'c1',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Read', input: { file_path: '/a.ts' }, output: null, status: null, error_message: null },
        }),
        baseEvent({
          event_id: 'r1',
          event_type: 'tool_result',
          role: 'tool',
          parent_event_id: 'c1',
          content: null,
          tool: { name: 'Read', input: null, output: 'file contents here', status: 'success', error_message: null },
        }),
        baseEvent({
          event_id: 'c2',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Read', input: { file_path: '/a.ts' }, output: null, status: null, error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', { pricingTable: table });
    const dupes = analysis.wasteItems.filter((w) => w.kind === 'duplicate_tool_call');
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.related_event_id).toBe('c2');
    expect(analysis.suggestions.some((s) => s.kind === 'trim')).toBe(true);
  });

  it('detects stale reads after Edit', () => {
    const turns = [
      turn('t1', [
        baseEvent({
          event_id: 'read-call',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Read', input: { file_path: '/b.ts' }, output: null, status: null, error_message: null },
        }),
        baseEvent({
          event_id: 'read-result',
          event_type: 'tool_result',
          role: 'tool',
          parent_event_id: 'read-call',
          content: null,
          tool: { name: 'Read', input: null, output: 'y'.repeat(800), status: 'success', error_message: null },
        }),
        baseEvent({
          event_id: 'edit-call',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Edit', input: { file_path: '/b.ts' }, output: null, status: null, error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', { pricingTable: table });
    const stale = analysis.wasteItems.filter((w) => w.kind === 'stale_read');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.estimated_tokens).toBe(200);
    expect(stale[0]!.estimated_cost_usd).toBeGreaterThan(0);
  });
});

describe('analyzeSessionContext', () => {
  it('returns empty analysis for no turns', () => {
    const analysis = analyzeSessionContext([], 'claude-sonnet-4-5', { pricingTable: table });
    expect(analysis.snapshots).toHaveLength(0);
    expect(analysis.wasteItems).toHaveLength(0);
    expect(analysis.growthRate).toBeNull();
    expect(analysis.toolResultImpacts).toHaveLength(0);
    expect(analysis.missingLogs).toHaveLength(0);
  });

  it('computes growthRate across turns', () => {
    const turns = [
      turn('t1', [baseEvent({ event_id: 'u1', role: 'user', content: 'short' })]),
      turn('t2', [
        baseEvent({
          event_id: 'tr1',
          event_type: 'tool_result',
          role: 'tool',
          content: null,
          tool: { name: 'Read', input: null, output: 'z'.repeat(4000), status: 'success', error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', { pricingTable: table });
    expect(analysis.growthRate).toBe('prior_tool_output');
  });

  it('flags valley items for large mid-context blocks', () => {
    const longOutput = 'q'.repeat(40_000);
    const turns = [
      turn('t1', [
        baseEvent({ event_id: 'pad1', role: 'user', content: 'p'.repeat(4000) }),
        baseEvent({
          event_id: 'out1',
          event_type: 'tool_result',
          role: 'tool',
          content: null,
          tool: { name: 'Read', input: null, output: longOutput, status: 'success', error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', {
      pricingTable: table,
      valleyTokenThreshold: 1000,
    });
    expect(analysis.valleyFlags.length).toBeGreaterThan(0);
    expect(analysis.methodology).toContain('Liu');
  });

  it('ranks top offenders by tool result size', () => {
    const turns = [
      turn('t1', [
        baseEvent({
          event_id: 'c1',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Read', input: { file_path: '/small.ts' }, output: null, status: null, error_message: null },
        }),
        baseEvent({
          event_id: 'r1',
          event_type: 'tool_result',
          role: 'tool',
          parent_event_id: 'c1',
          content: null,
          tool: { name: 'Read', input: null, output: 'x'.repeat(400), status: 'success', error_message: null },
        }),
        baseEvent({
          event_id: 'c2',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Read', input: { file_path: '/big.ts' }, output: null, status: null, error_message: null },
        }),
        baseEvent({
          event_id: 'r2',
          event_type: 'tool_result',
          role: 'tool',
          parent_event_id: 'c2',
          content: null,
          tool: { name: 'Read', input: null, output: 'y'.repeat(40_000), status: 'success', error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', { pricingTable: table });
    expect(analysis.topOffenders[0]!.result_event_id).toBe('r2');
    expect(analysis.topOffenders[0]!.estimated_tokens).toBe(10_000);
  });

  it('flags missing tool results and orphans', () => {
    const turns = [
      turn('t1', [
        baseEvent({
          event_id: 'c-missing',
          event_type: 'tool_call',
          role: 'assistant',
          tool: { name: 'Bash', input: { command: 'ls' }, output: null, status: null, error_message: null },
        }),
        baseEvent({
          event_id: 'r-orphan',
          event_type: 'tool_result',
          role: 'tool',
          parent_event_id: null,
          content: null,
          tool: { name: null, input: null, output: 'lost output', status: 'success', error_message: null },
          metadata: { orphan: true },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', { pricingTable: table });
    expect(analysis.missingLogs.some((m) => m.kind === 'missing_tool_result')).toBe(true);
    expect(analysis.missingLogs.some((m) => m.kind === 'orphan_tool_result')).toBe(true);
    expect(analysis.toolResultImpacts.find((i) => i.log_status === 'missing')?.call_event_id).toBe('c-missing');
  });

  it('flags cursor sessions with no exported tool results', () => {
    const turns = [
      turn('t1', [
        baseEvent({
          event_id: 'c1',
          event_type: 'tool_call',
          role: 'assistant',
          source: { harness: 'cursor', format_version: '1', raw_path: '/tmp/x.jsonl' },
          tool: { name: 'Read', input: { file_path: '/a.ts' }, output: null, status: null, error_message: null },
        }),
      ]),
    ];
    const analysis = analyzeSessionContext(turns, 'claude-sonnet-4-5', {
      pricingTable: table,
      harness: 'cursor',
    });
    expect(analysis.missingLogs.some((m) => m.kind === 'harness_no_tool_results')).toBe(true);
  });
});
