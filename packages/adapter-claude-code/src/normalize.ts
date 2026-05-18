// Convert Claude Code raw events into canonical Tracebench events.
//
// What we handle:
//   - user prompts (role=user, content=string)            → message
//   - user tool_result wrappers (content=array)           → tool_result events
//   - assistant messages with mixed content blocks:
//       text       → message (role=assistant)
//       thinking   → thinking
//       tool_use   → tool_call (event_id = the tool_use id, so tool_results
//                    can reference it via parent_event_id)
//     usage tokens are attached to the *first* emitted event of the message
//     so aggregates don't double-count.
//   - system events                                       → meta
//   - permission-mode / last-prompt / file-history-snapshot / attachment → meta
//   - summary / compaction events when they appear (defensive)
//
// Turn boundaries: a new turn starts at every human user prompt (a user event
// whose message.content is a plain string, OR an array that doesn't contain
// tool_result blocks). tool_result-only user events stay in the current turn.

import { computeCost, loadPricingTable } from '@tracebench/core';
import type {
  CanonicalEvent,
  EventTokens,
  EventTool,
  EventType,
  Session,
} from '@tracebench/core';
import type { RawClaudeCodeEvent } from './parse.js';

interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
}

interface AssistantMessage {
  model?: string;
  id?: string;
  type?: string;
  role?: string;
  content?: Array<Record<string, unknown>>;
  usage?: AssistantUsage;
  stop_reason?: string;
}

interface NormalizeOptions {
  /** Path of the source jsonl (stored in `source.raw_path`). */
  rawPath: string;
  /** Session id; falls back to first event's sessionId. */
  sessionId?: string;
  formatVersion: string;
}

export interface NormalizeResult {
  session: Session;
  events: CanonicalEvent[];
}

const TURN_START_TYPES = new Set(['user']);

function makeTokens(u?: AssistantUsage): EventTokens {
  return {
    input: u?.input_tokens ?? null,
    output: u?.output_tokens ?? null,
    cache_read: u?.cache_read_input_tokens ?? null,
    cache_creation: u?.cache_creation_input_tokens ?? null,
    reasoning: u?.reasoning_tokens ?? null,
  };
}

function emptyTool(): EventTool {
  return { name: null, input: null, output: null, status: null, error_message: null };
}

function emptyTokens(): EventTokens {
  return { input: null, output: null, cache_read: null, cache_creation: null, reasoning: null };
}

function isToolResultArray(content: unknown): content is Array<Record<string, unknown>> {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'tool_result')
  );
}

function toString(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Sometimes a user message is an array with a single text block.
    const parts = content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

function deriveTitle(content: unknown): string | null {
  const s = toString(content);
  if (!s) return null;
  const single = s.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > 120 ? single.slice(0, 117) + '...' : single;
}

export function normalizeSession(
  raws: RawClaudeCodeEvent[],
  opts: NormalizeOptions,
): NormalizeResult {
  const events: CanonicalEvent[] = [];

  // Session metadata derivation: take what we can from the first usable event.
  let firstWithCwd: RawClaudeCodeEvent | undefined;
  let firstUserMsg: RawClaudeCodeEvent | undefined;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let model: string | null = null;
  let resolvedSessionId = opts.sessionId ?? null;

  for (const r of raws) {
    if (!firstWithCwd && typeof r.cwd === 'string') firstWithCwd = r;
    if (!firstUserMsg && r.type === 'user') firstUserMsg = r;
    if (typeof r.timestamp === 'string') {
      if (!firstTs) firstTs = r.timestamp;
      lastTs = r.timestamp;
    }
    if (!resolvedSessionId && typeof r.sessionId === 'string') resolvedSessionId = r.sessionId;
    if (!model && r.type === 'assistant') {
      const m = (r.message as AssistantMessage | undefined)?.model;
      if (typeof m === 'string') model = m;
    }
  }

  if (!resolvedSessionId) {
    // Last-resort: derive from path
    resolvedSessionId = opts.rawPath.split('/').pop()?.replace(/\.jsonl$/, '') ?? 'unknown';
  }
  if (!firstTs) firstTs = new Date(0).toISOString();
  if (!lastTs) lastTs = firstTs;

  const cwd =
    typeof firstWithCwd?.cwd === 'string' ? firstWithCwd.cwd : '<unknown>';
  const titleSource = firstUserMsg
    ? ((firstUserMsg.message as { content?: unknown } | undefined)?.content ?? null)
    : null;
  const title = deriveTitle(titleSource);

  const source = {
    harness: 'claude_code' as const,
    format_version: opts.formatVersion,
    raw_path: opts.rawPath,
  };

  // Map tool_use id -> the canonical event_id we assigned (which we set to the
  // tool_use id itself, so this is trivially identity, but we keep the layer
  // explicit so future variants where ids don't match are easy to handle).
  const toolUseEventIds = new Set<string>();

  let currentTurnId: string = `${resolvedSessionId}::t0`;
  let turnIndex = 0;
  const pricing = loadPricingTable();

  function newTurn(seedTimestamp: string | undefined, fromRaw: RawClaudeCodeEvent): string {
    turnIndex += 1;
    // Prefer promptId when present — it's a stable identifier per user turn.
    const promptId = (fromRaw as { promptId?: unknown }).promptId;
    if (typeof promptId === 'string' && promptId.length > 0) {
      currentTurnId = `${resolvedSessionId}::t${turnIndex}::${promptId}`;
    } else {
      currentTurnId = `${resolvedSessionId}::t${turnIndex}`;
    }
    return currentTurnId;
  }

  for (const r of raws) {
    const ts = typeof r.timestamp === 'string' ? r.timestamp : firstTs!;
    const uuid = typeof r.uuid === 'string' ? r.uuid : `${resolvedSessionId}::raw::${events.length}`;
    const type = r.type;

    if (type === 'user') {
      const msg = (r.message as { role?: string; content?: unknown } | undefined) ?? {};
      const content = msg.content;

      if (isToolResultArray(content)) {
        // Tool results live in the current turn.
        for (let i = 0; i < content.length; i++) {
          const b = content[i]!;
          const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
          const isError = b.is_error === true;
          const outputContent = b.content ?? null;
          events.push({
            event_id: `${uuid}::tr${i}`,
            session_id: resolvedSessionId,
            turn_id: currentTurnId,
            parent_event_id: toolUseId && toolUseEventIds.has(toolUseId) ? toolUseId : null,
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
              name: null,
              input: null,
              output: outputContent as EventTool['output'],
              status: isError ? 'error' : 'success',
              error_message: isError && typeof outputContent === 'string' ? outputContent : null,
            },
            metadata: { tool_use_id: toolUseId, orphan: toolUseId !== null && !toolUseEventIds.has(toolUseId) },
            raw: r,
          });
        }
        continue;
      }

      // Plain user prompt — starts a new turn.
      newTurn(ts, r);
      events.push({
        event_id: uuid,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: typeof r.parentUuid === 'string' ? r.parentUuid : null,
        timestamp: ts,
        source,
        role: 'user',
        event_type: 'message',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: toString(content),
        tool: emptyTool(),
        metadata: {},
        raw: r,
      });
      continue;
    }

    if (type === 'assistant') {
      const msg = (r.message as AssistantMessage | undefined) ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const usage = makeTokens(msg.usage);
      const msgModel = typeof msg.model === 'string' ? msg.model : model;

      const cost = computeCost({ model: msgModel, tokens: usage, table: pricing });

      let usageAttached = false;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]!;
        const blockType = typeof block.type === 'string' ? block.type : '';
        const attach = !usageAttached;

        let evtType: EventType = 'message';
        let toolInfo: EventTool = emptyTool();
        let contentField: CanonicalEvent['content'] = null;
        let eventId = `${uuid}::b${i}`;

        if (blockType === 'text') {
          evtType = 'message';
          contentField = typeof block.text === 'string' ? block.text : null;
        } else if (blockType === 'thinking') {
          evtType = 'thinking';
          contentField = typeof block.thinking === 'string' ? block.thinking : null;
        } else if (blockType === 'tool_use') {
          evtType = 'tool_call';
          const toolUseId = typeof block.id === 'string' ? block.id : null;
          if (toolUseId) {
            eventId = toolUseId;
            toolUseEventIds.add(toolUseId);
          }
          toolInfo = {
            name: typeof block.name === 'string' ? block.name : null,
            input: (block.input as Record<string, unknown> | undefined) ?? null,
            output: null,
            status: null,
            error_message: null,
          };
        } else {
          // Unknown block type — store as meta but don't drop it.
          evtType = 'meta';
          contentField = block as unknown as CanonicalEvent['content'];
        }

        events.push({
          event_id: eventId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: typeof r.parentUuid === 'string' ? r.parentUuid : null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: evtType,
          model: msgModel,
          tokens: attach ? usage : emptyTokens(),
          cost_usd: attach ? (cost.method ? cost.usd : null) : null,
          cost_method: attach ? cost.method : null,
          duration_ms: null,
          content: contentField,
          tool: toolInfo,
          metadata: attach && msg.stop_reason ? { stop_reason: msg.stop_reason } : {},
          raw: i === 0 ? r : { _ref_uuid: uuid }, // avoid duplicating the full raw across blocks
        });
        if (attach) usageAttached = true;
      }

      if (blocks.length === 0) {
        // Defensive: empty content. Still emit a single placeholder so the
        // turn's usage is counted.
        events.push({
          event_id: uuid,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: typeof r.parentUuid === 'string' ? r.parentUuid : null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'message',
          model: msgModel,
          tokens: usage,
          cost_usd: cost.method ? cost.usd : null,
          cost_method: cost.method,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: { empty: true },
          raw: r,
        });
      }
      continue;
    }

    if (type === 'system' || type === 'permission-mode' || type === 'last-prompt' || type === 'file-history-snapshot' || type === 'attachment') {
      events.push({
        event_id: uuid,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: typeof r.parentUuid === 'string' ? r.parentUuid : null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'meta',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: typeof r.content === 'string' ? r.content : null,
        tool: emptyTool(),
        metadata: { kind: type },
        raw: r,
      });
      continue;
    }

    if (type === 'summary') {
      events.push({
        event_id: uuid,
        session_id: resolvedSessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: 'summary',
        model: null,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: typeof r.summary === 'string' ? r.summary : (typeof r.content === 'string' ? r.content : null),
        tool: emptyTool(),
        metadata: {},
        raw: r,
      });
      continue;
    }

    if (type === 'compaction' || type === 'compact_summary') {
      events.push({
        event_id: uuid,
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
        content: typeof r.content === 'string' ? r.content : null,
        tool: emptyTool(),
        metadata: {},
        raw: r,
      });
      continue;
    }

    // Unknown top-level type — emit as meta with raw preserved.
    events.push({
      event_id: uuid,
      session_id: resolvedSessionId,
      turn_id: currentTurnId,
      parent_event_id: typeof r.parentUuid === 'string' ? r.parentUuid : null,
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
      metadata: { kind: type ?? 'unknown' },
      raw: r,
    });
  }

  const session: Session = {
    session_id: resolvedSessionId,
    harness: 'claude_code',
    project_path: cwd,
    title,
    started_at: firstTs!,
    ended_at: lastTs,
    model,
    raw_path: opts.rawPath,
    format_version: opts.formatVersion,
    mtime_ms: 0, // filled by the indexer that knows the file's mtime
  };

  return { session, events };
}

// Convenience: combine parse + normalize.
import { parseSession } from './parse.js';

export async function loadSession(filePath: string, opts: { formatVersion?: string } = {}): Promise<NormalizeResult> {
  const raws = await parseSession(filePath);
  return normalizeSession(raws, {
    rawPath: filePath,
    formatVersion: opts.formatVersion ?? '2025-q2',
  });
}
