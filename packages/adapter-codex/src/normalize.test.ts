import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, normalizeSession } from './normalize.js';
import { parseSession } from './parse.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('fixture 01 — simple exec_command flow', () => {
  it('extracts session metadata from session_meta', async () => {
    const { session } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    expect(session.session_id).toBe('019cab12-0001-7000-0000-000000000001');
    expect(session.harness).toBe('codex');
    expect(session.project_path).toBe('/Users/me/code/proj');
    expect(session.model).toBe('gpt-5-codex');
    expect(session.title).toMatch(/Read the README/);
  });

  it('uses event_msg.user_message for the user prompt, not response_item.message role=user', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const userMessages = events.filter((e) => e.role === 'user' && e.event_type === 'message');
    expect(userMessages.length).toBe(1);
    expect(userMessages[0]!.content).toBe('Read the README and tell me what this project is');
    // The response_item.message role=user with the preamble should NOT appear
    expect(userMessages.every((e) => !String(e.content).includes('AGENTS.md preamble'))).toBe(true);
  });

  it('emits assistant messages from response_item.message role=assistant', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const assistantMessages = events.filter((e) => e.role === 'assistant' && e.event_type === 'message');
    expect(assistantMessages.length).toBe(2);
    expect(assistantMessages[0]!.content).toMatch(/I'll read the README/);
  });

  it('emits tool_call with event_id = call_id', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const calls = events.filter((e) => e.event_type === 'tool_call');
    expect(calls.length).toBe(1);
    expect(calls[0]!.event_id).toBe('call_001');
    expect(calls[0]!.tool.name).toBe('exec_command');
    expect((calls[0]!.tool.input as { cmd?: string }).cmd).toBe('cat README.md');
  });

  it('links function_call_output to its function_call via parent_event_id', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const result = events.find((e) => e.event_type === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.parent_event_id).toBe('call_001');
    expect(result!.tool.status).toBe('success');
    expect(result!.tool.output).toMatch(/Tracebench/);
  });

  it('attaches token_count to the preceding assistant/function_call', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const withTokens = events.filter((e) => e.tokens.input != null);
    expect(withTokens.length).toBeGreaterThan(0);
    // The token_count comes after the function_call; should land on the
    // most recent attribution target.
    const target = withTokens[0]!;
    expect(target.tokens.input).toBe(1500);
    expect(target.tokens.output).toBe(40);
    expect(target.tokens.cache_read).toBe(1000);
    expect(target.tokens.reasoning).toBe(20);
  });

  it('computes cost on token-bearing events', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const withCost = events.filter((e) => e.cost_usd != null);
    expect(withCost.length).toBeGreaterThan(0);
    expect(withCost[0]!.cost_method).toBe('estimated');
  });
});

describe('fixture 02 — reasoning + apply_patch', () => {
  it('emits thinking events from reasoning when summary text exists', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    const thinking = events.filter((e) => e.event_type === 'thinking');
    expect(thinking.length).toBe(1);
    expect(thinking[0]!.content).toMatch(/pool implementation/);
  });

  it('handles custom_tool_call (apply_patch) with string input', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    const patchCall = events.find((e) => e.event_type === 'tool_call' && e.tool.name === 'apply_patch');
    expect(patchCall).toBeDefined();
    expect((patchCall!.tool.input as { _raw?: string })._raw).toMatch(/Begin Patch/);
  });

  it('links custom_tool_call_output to its call via parent_event_id', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    const patchResult = events.find((e) => e.event_type === 'tool_result' && e.parent_event_id === 'call_patch');
    expect(patchResult).toBeDefined();
    expect(patchResult!.tool.output).toBe('Patched src/pool.ts');
  });

  it('uses gpt-5.3-codex from the most recent turn_context', async () => {
    const { session } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    expect(session.model).toBe('gpt-5.3-codex');
  });

  it('billing includes reasoning tokens as output', async () => {
    const { events } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    const withTokens = events.find((e) => e.tokens.input != null);
    expect(withTokens).toBeDefined();
    expect(withTokens!.tokens.reasoning).toBe(600);
    // gpt-5.3-codex (LiteLLM 2026-05): in 1.75e-6, out 1.4e-5, cache_read 1.75e-7
    // We pass tokens.input=2200, cache_read=1800; we don't auto-subtract.
    // Reasoning is billed as output (740 = 140 + 600).
    // cost = 2200*1.75e-6 + 740*1.4e-5 + 1800*1.75e-7
    //      = 0.00385 + 0.01036 + 0.000315 = 0.014525
    expect(withTokens!.cost_usd!).toBeCloseTo(0.014525, 5);
  });
});

describe('fixture 03 — compaction, orphans, unknown types, malformed lines', () => {
  it('parses despite an invalid JSON line', async () => {
    const raws = await parseSession(join(FIXTURES, '03-compacted-and-edge-cases.jsonl'));
    // 9 lines, 1 malformed → 8 raws
    expect(raws.length).toBe(8);
  });

  it('emits compaction events for both context_compacted and compacted', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-compacted-and-edge-cases.jsonl'));
    const compactions = events.filter((e) => e.event_type === 'compaction');
    expect(compactions.length).toBe(2);
  });

  it('marks function_call_output as orphan when its call is missing', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-compacted-and-edge-cases.jsonl'));
    const orphan = events.find((e) => e.event_type === 'tool_result');
    expect(orphan).toBeDefined();
    expect(orphan!.parent_event_id).toBeNull();
    expect(orphan!.metadata.orphan).toBe(true);
  });

  it('emits WebSearch tool_call', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-compacted-and-edge-cases.jsonl'));
    const ws = events.find((e) => e.event_type === 'tool_call' && e.tool.name === 'WebSearch');
    expect(ws).toBeDefined();
    expect((ws!.tool.input as { query?: string }).query).toMatch(/better-sqlite3/);
  });

  it('unknown event_msg subtype becomes meta without dropping it', async () => {
    const { events } = await loadSession(join(FIXTURES, '03-compacted-and-edge-cases.jsonl'));
    const weird = events.find((e) => e.metadata.kind === 'event_msg:weird_future_event_type');
    expect(weird).toBeDefined();
    expect(weird!.event_type).toBe('meta');
  });
});

describe('discovery + edge cases', () => {
  it('falls back to filename when sessionId is missing', () => {
    const r = normalizeSession([], {
      rawPath: '/tmp/rollout-2026-01-01-abc.jsonl',
      formatVersion: 'test',
    });
    expect(r.session.session_id).toBe('rollout-2026-01-01-abc');
    expect(r.events.length).toBe(0);
  });

  it('skips reasoning events with only encrypted content (no plaintext)', async () => {
    // In fixture 02 there's a reasoning event with summary text — that one
    // should appear. A reasoning with encrypted_content only would be skipped.
    const { events } = await loadSession(join(FIXTURES, '02-reasoning-and-apply-patch.jsonl'));
    const thinking = events.filter((e) => e.event_type === 'thinking');
    expect(thinking.every((t) => typeof t.content === 'string' && t.content!.length > 0)).toBe(true);
  });
});
