// Codex rollout → canonical events.
//
// Mapping rules:
//   session_meta             → session header (id, cwd, originator → metadata)
//   turn_context             → metadata (model + effort), starts a fresh turn
//   event_msg.task_started   → starts a new turn (with turn_id from payload)
//   event_msg.task_complete  → meta marker
//   event_msg.user_message   → role=user, event_type=message (the clean human input)
//   event_msg.agent_message  → SKIPPED (duplicated by response_item.message assistant)
//   event_msg.token_count    → attached to the most recent assistant/function_call
//   event_msg.context_compacted / compacted → event_type=compaction
//   response_item.message (role=assistant) → role=assistant, event_type=message
//   response_item.message (role=user|developer) → SKIPPED (preamble / model-input)
//   response_item.reasoning  → event_type=thinking (content from `summary` if present)
//   response_item.function_call         → event_type=tool_call (event_id = call_id)
//   response_item.function_call_output  → event_type=tool_result (parent = call_id)
//   response_item.custom_tool_call      → event_type=tool_call (event_id = call_id)
//   response_item.custom_tool_call_output → event_type=tool_result (parent = call_id)
//   response_item.web_search_call       → event_type=tool_call (name=web_search)

import { computeCost, loadPricingTable } from '@tracebench/core';
import type {
  CanonicalEvent,
  EventTokens,
  EventTool,
  EventType,
  Session,
} from '@tracebench/core';
import type { RawCodexEvent } from './parse.js';

interface NormalizeOptions {
  rawPath: string;
  sessionId?: string;
  formatVersion: string;
}

export interface NormalizeResult {
  session: Session;
  events: CanonicalEvent[];
}

function emptyTokens(): EventTokens {
  return {
    input: null,
    output: null,
    cache_read: null,
    cache_creation: null,
    reasoning: null,
  };
}

function emptyTool(): EventTool {
  return { name: null, input: null, output: null, status: null, error_message: null };
}

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  base_instructions?: { text?: string };
  user_instructions?: string;
}

interface TurnContextPayload {
  turn_id?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  summary?: string;
}

interface ResponseMessage {
  type?: 'message';
  role?: 'user' | 'assistant' | 'developer' | 'system';
  content?: Array<{ type?: string; text?: string }>;
  phase?: string;
}

interface ResponseReasoning {
  type?: 'reasoning';
  summary?: Array<{ type?: string; text?: string }> | unknown;
  content?: string | null;
  encrypted_content?: string;
}

interface ResponseFunctionCall {
  type?: 'function_call';
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface ResponseFunctionCallOutput {
  type?: 'function_call_output';
  call_id?: string;
  output?: string;
  /** Some variants surface `is_error`/`status` explicitly. */
  is_error?: boolean;
  status?: string;
}

interface ResponseCustomToolCall {
  type?: 'custom_tool_call';
  name?: string;
  input?: string | Record<string, unknown>;
  call_id?: string;
  status?: string;
}

interface ResponseCustomToolCallOutput {
  type?: 'custom_tool_call_output';
  call_id?: string;
  output?: string;
}

interface ResponseWebSearch {
  type?: 'web_search_call';
  call_id?: string;
  query?: string;
  status?: string;
  results?: unknown;
}

interface TokenCountPayload {
  type?: 'token_count';
  info?: {
    last_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
      total_tokens?: number;
    };
    total_token_usage?: unknown;
    model_context_window?: number;
  };
}

function safeJSONParse(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function flattenContent(parts: ResponseMessage['content']): string | null {
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter((s) => s.length > 0);
  return texts.length > 0 ? texts.join('\n') : null;
}

function flattenReasoningSummary(summary: ResponseReasoning['summary']): string | null {
  if (Array.isArray(summary)) {
    const texts = summary
      .map((p: unknown) =>
        typeof p === 'object' && p !== null && 'text' in p && typeof (p as { text: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .filter((s) => s.length > 0);
    if (texts.length > 0) return texts.join('\n');
  }
  return null;
}

function deriveTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const single = s.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > 120 ? single.slice(0, 117) + '...' : single;
}

export function normalizeSession(
  raws: RawCodexEvent[],
  opts: NormalizeOptions,
): NormalizeResult {
  const events: CanonicalEvent[] = [];

  // Session-header fields.
  let resolvedSessionId: string | null = opts.sessionId ?? null;
  let cwd = '<unknown>';
  let originator: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let model: string | null = null;
  let title: string | null = null;

  // Find session_meta + first user_message + last turn_context's model.
  for (const r of raws) {
    const ts = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (r.type === 'session_meta') {
      const p = (r.payload ?? {}) as SessionMetaPayload;
      if (!resolvedSessionId && typeof p.id === 'string') resolvedSessionId = p.id;
      if (typeof p.cwd === 'string') cwd = p.cwd;
      if (typeof p.originator === 'string') originator = p.originator;
    }
    if (r.type === 'turn_context') {
      const p = (r.payload ?? {}) as TurnContextPayload;
      if (typeof p.model === 'string') model = p.model;
    }
    if (r.type === 'event_msg') {
      const p = (r.payload ?? {}) as { type?: string; message?: string };
      if (p.type === 'user_message' && !title) {
        title = deriveTitle(p.message);
      }
    }
  }

  if (!resolvedSessionId) {
    resolvedSessionId = opts.rawPath.split('/').pop()?.replace(/\.jsonl$/, '') ?? 'unknown';
  }
  if (!firstTs) firstTs = new Date(0).toISOString();
  if (!lastTs) lastTs = firstTs;

  const source = {
    harness: 'codex' as const,
    format_version: opts.formatVersion,
    raw_path: opts.rawPath,
  };

  let currentTurnId = `${resolvedSessionId}::t0`;
  let turnIndex = 0;
  const pricing = loadPricingTable();
  // Map call_id -> tool name (so tool_result rendering can know which renderer to use)
  const callTool = new Map<string, string>();

  // We need to attach token_count to the immediately-preceding assistant /
  // function_call event. Track a reference to the most recent such event.
  let costAttachTarget: CanonicalEvent | null = null;

  function pushEvent(e: CanonicalEvent): void {
    events.push(e);
  }

  function newTurn(seed?: string): void {
    turnIndex += 1;
    currentTurnId = seed
      ? `${resolvedSessionId}::t${turnIndex}::${seed}`
      : `${resolvedSessionId}::t${turnIndex}`;
  }

  let rawIdx = -1;
  for (const r of raws) {
    rawIdx += 1;
    const ts = typeof r.timestamp === 'string' ? r.timestamp : firstTs!;
    const t = r.type;
    const baseId = `${resolvedSessionId}::raw::${rawIdx}`;

    if (t === 'session_meta') {
      const p = (r.payload ?? {}) as SessionMetaPayload;
      pushEvent({
        event_id: baseId,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'meta',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: typeof p.user_instructions === 'string' ? p.user_instructions : null,
        tool: emptyTool(),
        metadata: {
          kind: 'session_meta',
          originator: p.originator,
          cli_version: p.cli_version,
          source: p.source,
          model_provider: p.model_provider,
        },
        raw: r,
      });
      continue;
    }

    if (t === 'turn_context') {
      const p = (r.payload ?? {}) as TurnContextPayload;
      newTurn(p.turn_id);
      pushEvent({
        event_id: baseId,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'meta',
        model: typeof p.model === 'string' ? p.model : null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: emptyTool(),
        metadata: {
          kind: 'turn_context',
          effort: p.effort,
          summary: p.summary,
        },
        raw: r,
      });
      continue;
    }

    if (t === 'event_msg') {
      const p = (r.payload ?? {}) as { type?: string; [k: string]: unknown };
      const sub = p.type;

      if (sub === 'task_started') {
        const tid = typeof p.turn_id === 'string' ? p.turn_id : undefined;
        if (tid) newTurn(tid);
        pushEvent({
          event_id: baseId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'system',
          event_type: 'meta',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: { kind: 'task_started' },
          raw: r,
        });
        continue;
      }

      if (sub === 'task_complete') {
        pushEvent({
          event_id: baseId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'system',
          event_type: 'meta',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: { kind: 'task_complete' },
          raw: r,
        });
        continue;
      }

      if (sub === 'user_message') {
        // Clean human prompt — this is what the user actually typed.
        const message = typeof p.message === 'string' ? p.message : '';
        pushEvent({
          event_id: baseId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'user',
          event_type: 'message',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: message,
          tool: emptyTool(),
          metadata: {},
          raw: r,
        });
        continue;
      }

      if (sub === 'agent_message') {
        // Duplicates the response_item.message assistant — skip entirely.
        continue;
      }

      if (sub === 'token_count') {
        const info = (p as TokenCountPayload).info;
        const usage = info?.last_token_usage;
        if (usage && costAttachTarget) {
          const tokens: EventTokens = {
            input: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
            output: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
            cache_read: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
            cache_creation: null,
            reasoning: typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : null,
          };
          costAttachTarget.tokens = tokens;
          const cost = computeCost({
            model: costAttachTarget.model,
            tokens,
            table: pricing,
          });
          if (cost.method) {
            costAttachTarget.cost_usd = cost.usd;
            costAttachTarget.cost_method = cost.method;
          }
        }
        // No need to also emit a canonical event for the token_count itself —
        // it's purely accounting; the tokens are now on the response event.
        continue;
      }

      if (sub === 'context_compacted') {
        pushEvent({
          event_id: baseId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'system',
          event_type: 'compaction',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: { kind: 'context_compacted' },
          raw: r,
        });
        continue;
      }

      // Unknown event_msg subtype → meta
      pushEvent({
        event_id: baseId,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'meta',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: emptyTool(),
        metadata: { kind: `event_msg:${sub ?? 'unknown'}` },
        raw: r,
      });
      continue;
    }

    if (t === 'response_item') {
      const p = (r.payload ?? {}) as { type?: string };
      const sub = p.type;

      if (sub === 'message') {
        const msg = p as ResponseMessage;
        const content = flattenContent(msg.content);
        if (msg.role === 'assistant') {
          const evt: CanonicalEvent = {
            event_id: baseId,
            session_id: resolvedSessionId,
            turn_id: currentTurnId,
            parent_event_id: null,
            timestamp: ts,
            source,
            role: 'assistant',
            event_type: 'message',
            model,
            tokens: emptyTokens(),
            cost_usd: null,
            cost_method: null,
            duration_ms: null,
            content,
            tool: emptyTool(),
            metadata: typeof msg.phase === 'string' ? { phase: msg.phase } : {},
            raw: r,
          };
          pushEvent(evt);
          costAttachTarget = evt;
          continue;
        }
        // role=user or role=developer → SKIP (this is the actual model-input
        // including AGENTS.md preamble and permission text; the human-typed
        // prompt is captured by event_msg.user_message).
        continue;
      }

      if (sub === 'reasoning') {
        const reasoning = p as ResponseReasoning;
        const summary = flattenReasoningSummary(reasoning.summary);
        const content =
          typeof reasoning.content === 'string' && reasoning.content.length > 0
            ? reasoning.content
            : summary;
        // Skip reasoning events with no plaintext (encrypted_content only) —
        // they're noise for the viewer.
        if (!content) continue;
        pushEvent({
          event_id: baseId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'thinking',
          model,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content,
          tool: emptyTool(),
          metadata: {},
          raw: r,
        });
        continue;
      }

      if (sub === 'function_call') {
        const fc = p as ResponseFunctionCall;
        const callId = typeof fc.call_id === 'string' ? fc.call_id : baseId;
        const name = typeof fc.name === 'string' ? fc.name : null;
        const input = safeJSONParse(fc.arguments);
        if (name) callTool.set(callId, name);
        const evt: CanonicalEvent = {
          event_id: callId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'tool_call',
          model,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name,
            input,
            output: null,
            status: null,
            error_message: null,
          },
          metadata: { call_id: callId },
          raw: r,
        };
        pushEvent(evt);
        // The model-attribution target should remain on the latest assistant
        // message, but if there is none yet, attach the next token_count here.
        costAttachTarget = costAttachTarget ?? evt;
        continue;
      }

      if (sub === 'function_call_output') {
        const fco = p as ResponseFunctionCallOutput;
        const callId = typeof fco.call_id === 'string' ? fco.call_id : null;
        const output = typeof fco.output === 'string' ? fco.output : null;
        const isError =
          fco.is_error === true ||
          (typeof fco.status === 'string' && /error|fail/i.test(fco.status));
        pushEvent({
          event_id: `${baseId}::out`,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: callId && callTool.has(callId) ? callId : null,
          timestamp: ts,
          source,
          role: 'tool',
          event_type: 'tool_result',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name: callId ? callTool.get(callId) ?? null : null,
            input: null,
            output,
            status: isError ? 'error' : 'success',
            error_message: isError && output ? output : null,
          },
          metadata: {
            call_id: callId,
            orphan: callId !== null && !callTool.has(callId),
          },
          raw: r,
        });
        continue;
      }

      if (sub === 'custom_tool_call') {
        const ct = p as ResponseCustomToolCall;
        const callId = typeof ct.call_id === 'string' ? ct.call_id : baseId;
        const name = typeof ct.name === 'string' ? ct.name : null;
        // Some custom tools take a string blob (apply_patch); others an object.
        const input =
          typeof ct.input === 'string'
            ? ({ _raw: ct.input } as Record<string, unknown>)
            : (ct.input ?? null);
        if (name) callTool.set(callId, name);
        const evt: CanonicalEvent = {
          event_id: callId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'tool_call',
          model,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name,
            input,
            output: null,
            status:
              typeof ct.status === 'string' && /error|fail/i.test(ct.status)
                ? 'error'
                : null,
            error_message: null,
          },
          metadata: { call_id: callId, kind: 'custom_tool_call' },
          raw: r,
        };
        pushEvent(evt);
        continue;
      }

      if (sub === 'custom_tool_call_output') {
        const co = p as ResponseCustomToolCallOutput;
        const callId = typeof co.call_id === 'string' ? co.call_id : null;
        const output = typeof co.output === 'string' ? co.output : null;
        pushEvent({
          event_id: `${baseId}::out`,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: callId && callTool.has(callId) ? callId : null,
          timestamp: ts,
          source,
          role: 'tool',
          event_type: 'tool_result',
          model: null,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name: callId ? callTool.get(callId) ?? null : null,
            input: null,
            output,
            status: 'success',
            error_message: null,
          },
          metadata: {
            call_id: callId,
            orphan: callId !== null && !callTool.has(callId),
            kind: 'custom_tool_call_output',
          },
          raw: r,
        });
        continue;
      }

      if (sub === 'web_search_call') {
        const ws = p as ResponseWebSearch;
        const callId = typeof ws.call_id === 'string' ? ws.call_id : baseId;
        callTool.set(callId, 'WebSearch');
        pushEvent({
          event_id: callId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'tool_call',
          model,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name: 'WebSearch',
            input: typeof ws.query === 'string' ? { query: ws.query } : null,
            output: null,
            status: null,
            error_message: null,
          },
          metadata: { call_id: callId },
          raw: r,
        });
        continue;
      }

      // Unknown response_item subtype → meta
      pushEvent({
        event_id: baseId,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'meta',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: emptyTool(),
        metadata: { kind: `response_item:${sub ?? 'unknown'}` },
        raw: r,
      });
      continue;
    }

    if (t === 'compacted') {
      pushEvent({
        event_id: baseId,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'compaction',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: emptyTool(),
        metadata: { kind: 'compacted' },
        raw: r,
      });
      continue;
    }

    // Unknown top-level type
    pushEvent({
      event_id: baseId,
      session_id: resolvedSessionId,
      turn_id: currentTurnId,
      parent_event_id: null,
      timestamp: ts,
      source,
      role: 'system',
      event_type: 'meta',
      model: null,
      tokens: emptyTokens(),
      cost_usd: null,
      cost_method: null,
      duration_ms: null,
      content: null,
      tool: emptyTool(),
      metadata: { kind: t ?? 'unknown' },
      raw: r,
    });
  }

  const session: Session = {
    session_id: resolvedSessionId,
    harness: 'codex',
    project_path: cwd,
    title,
    started_at: firstTs!,
    ended_at: lastTs,
    model,
    raw_path: opts.rawPath,
    format_version: opts.formatVersion,
    mtime_ms: 0,
  };

  return { session, events };
}

import { parseSession } from './parse.js';

export async function loadSession(
  filePath: string,
  opts: { formatVersion?: string } = {},
): Promise<NormalizeResult> {
  const raws = await parseSession(filePath);
  return normalizeSession(raws, {
    rawPath: filePath,
    formatVersion: opts.formatVersion ?? '2026-q2',
  });
}
