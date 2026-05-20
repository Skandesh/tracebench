// Normalize Cursor Composer DB bubbles into canonical Tracebench events.

import type { CanonicalEvent, EventType, Session } from '@tracebench/core';
import type { CursorBubble } from './db-types.js';
import type { LoadedComposer } from './db-read.js';
import type { NormalizeResult } from './normalize.js';

export const FORMAT_VERSION_DB = '2026-q1-composer';

function emptyTool() {
  return { name: null, input: null, output: null, status: null, error_message: null };
}

const emptyTokens = {
  input: null,
  output: null,
  cache_read: null,
  cache_creation: null,
  reasoning: null,
} as const;

function stripUserQuery(text: string | null): string | null {
  if (text == null) return null;
  const stripped = text.replace(/<\/?user_query>/gi, '').trim();
  return stripped.length > 0 ? stripped : null;
}

function deriveTitle(text: string | null): string | null {
  const s = stripUserQuery(text);
  if (!s) return null;
  const single = s.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > 120 ? single.slice(0, 117) + '...' : single;
}

function parseToolParams(params: string | undefined): Record<string, unknown> | null {
  if (!params) return null;
  try {
    return JSON.parse(params) as Record<string, unknown>;
  } catch {
    return { raw: params };
  }
}

function parseToolResultOutput(
  result: string | undefined,
): { output: string | Record<string, unknown> | null; status: 'success' | 'error' | null; error: string | null } {
  if (!result) return { output: null, status: null, error: null };
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const rejected = parsed.rejected === true;
    const output =
      typeof parsed.output === 'string'
        ? parsed.output
        : typeof parsed.content === 'string'
          ? parsed.content
          : parsed;
    return {
      output,
      status: rejected ? 'error' : 'success',
      error: rejected ? String(parsed.reason ?? 'rejected') : null,
    };
  } catch {
    return { output: result, status: 'success', error: null };
  }
}

function bubbleTimestamp(b: CursorBubble, fallbackMs: number): string {
  if (b.createdAt) {
    const t = Date.parse(b.createdAt);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function mapToolName(name: string | undefined): string | null {
  if (!name) return null;
  const map: Record<string, string> = {
    ripgrep_raw_search: 'Grep',
    run_terminal_command_v2: 'Bash',
    read_file: 'Read',
    edit_file: 'Edit',
    write_file: 'Write',
    list_dir: 'Glob',
    web_search: 'WebSearch',
  };
  return map[name] ?? name;
}

export interface NormalizeDbOptions {
  rawPath: string;
  globalDbPath: string;
  formatVersion?: string;
}

export function normalizeComposerSession(
  loaded: LoadedComposer,
  opts: NormalizeDbOptions,
): NormalizeResult {
  const { composerId, data, bubbles } = loaded;
  const eventFormatVersion = opts.formatVersion ?? FORMAT_VERSION_DB;
  /** Stored on sessions row — matches harness FORMAT_VERSION for indexer skip logic. */
  const sessionFormatVersion = '2026-q1';

  const projectPath =
    data?.workspaceIdentifier?.uri?.fsPath ??
    data?.workspaceIdentifier?.uri?.path ??
    null;

  const modelName =
    data?.modelConfig?.modelName ??
    bubbles.find((b) => b.modelInfo?.modelName)?.modelInfo?.modelName ??
    null;

  const source = {
    harness: 'cursor' as const,
    format_version: eventFormatVersion,
    raw_path: opts.rawPath,
  };

  const sessionMeta: Record<string, unknown> = {
    source: 'composer_db',
    global_db_path: opts.globalDbPath,
    unified_mode: data?.unifiedMode ?? null,
  };

  const events: CanonicalEvent[] = [];
  let turnIndex = 0;
  let currentTurnId = `${composerId}::t0`;
  const endMs = data?.lastUpdatedAt ?? data?.createdAt ?? Date.now();
  const startMs = data?.createdAt ?? endMs;

  function newTurn(): string {
    turnIndex += 1;
    currentTurnId = `${composerId}::t${turnIndex}`;
    return currentTurnId;
  }

  function baseMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...sessionMeta, ...extra };
  }

  let firstUserText: string | null = null;

  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i]!;
    const ts = bubbleTimestamp(b, endMs);
    const bubbleType = b.type ?? 0;

    if (bubbleType === 1) {
      newTurn();
      const content = stripUserQuery(b.text ?? null);
      if (!firstUserText && content) firstUserText = content;
      events.push({
        event_id: `cursor:${composerId}:u:${b.bubbleId ?? i}`,
        session_id: composerId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'user',
        event_type: 'message',
        model: null,
        tokens: { ...emptyTokens },
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content,
        tool: emptyTool(),
        metadata: baseMeta({ bubble_id: b.bubbleId }),
        raw: b as unknown as Record<string, unknown>,
      });
      continue;
    }

    if (b.capabilityType === 30 && b.thinking?.text) {
      events.push({
        event_id: `cursor:${composerId}:think:${b.bubbleId ?? i}`,
        session_id: composerId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'assistant',
        event_type: 'thinking',
        model: modelName,
        tokens: { ...emptyTokens },
        cost_usd: null,
        cost_method: null,
        duration_ms: b.thinkingDurationMs ?? null,
        content: b.thinking.text,
        tool: emptyTool(),
        metadata: baseMeta({ bubble_id: b.bubbleId }),
        raw: b as unknown as Record<string, unknown>,
      });
      continue;
    }

    const tool = b.toolFormerData;
    if (b.capabilityType === 15 && tool?.toolCallId) {
      const callId = tool.toolCallId;
      const input = parseToolParams(tool.params ?? tool.rawArgs);
      const toolName = mapToolName(tool.name);

      events.push({
        event_id: callId,
        session_id: composerId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'assistant',
        event_type: 'tool_call',
        model: modelName,
        tokens: {
          input: b.tokenCount?.inputTokens ?? null,
          output: null,
          cache_read: null,
          cache_creation: null,
          reasoning: null,
        },
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: {
          name: toolName,
          input,
          output: null,
          status: null,
          error_message: null,
        },
        metadata: baseMeta({
          bubble_id: b.bubbleId,
          tool_status: tool.status ?? null,
        }),
        raw: b as unknown as Record<string, unknown>,
      });

      const { output, status, error } = parseToolResultOutput(tool.result);
      if (output != null || tool.status === 'completed' || tool.status === 'error') {
        events.push({
          event_id: `${callId}:result`,
          session_id: composerId,
          turn_id: currentTurnId,
          parent_event_id: callId,
          timestamp: ts,
          source,
          role: 'tool',
          event_type: 'tool_result',
          model: modelName,
          tokens: {
            input: null,
            output: b.tokenCount?.outputTokens ?? null,
            cache_read: null,
            cache_creation: null,
            reasoning: null,
          },
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: {
            name: toolName,
            input: null,
            output,
            status: status ?? (tool.status === 'error' ? 'error' : tool.status === 'completed' ? 'success' : null),
            error_message: error,
          },
          metadata: baseMeta({ bubble_id: b.bubbleId }),
          raw: { result: tool.result ?? null },
        });
      }
      continue;
    }

    const text = (b.text ?? '').trim();
    if (text) {
      let evtType: EventType = 'message';
      events.push({
        event_id: `cursor:${composerId}:a:${b.bubbleId ?? i}`,
        session_id: composerId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'assistant',
        event_type: evtType,
        model: modelName,
        tokens: {
          input: b.tokenCount?.inputTokens ?? null,
          output: b.tokenCount?.outputTokens ?? null,
          cache_read: null,
          cache_creation: null,
          reasoning: null,
        },
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: text,
        tool: emptyTool(),
        metadata: baseMeta({ bubble_id: b.bubbleId }),
        raw: b as unknown as Record<string, unknown>,
      });
    }
  }

  const firstTs =
    events[0]?.timestamp ?? new Date(startMs).toISOString();
  const lastTs =
    events[events.length - 1]?.timestamp ?? new Date(endMs).toISOString();

  const title =
    deriveTitle(firstUserText) ??
    (data?.name && data.name !== 'New Chat' ? data.name : null) ??
    deriveTitle(data?.subtitle ?? null);

  const session: Session = {
    session_id: composerId,
    harness: 'cursor',
    project_path: projectPath ?? 'unknown',
    title,
    started_at: firstTs,
    ended_at: lastTs,
    model: modelName,
    raw_path: opts.rawPath,
    format_version: sessionFormatVersion,
    mtime_ms: 0,
  };

  return { session, events };
}
