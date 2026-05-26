// OpenCode SQLite session → canonical Tracebench events.
//
// Layout: session → messages (user/assistant) → parts (text, reasoning, tool, …).
// Turn boundaries: each user message starts a new turn.
// Usage tokens attach to the first canonical event emitted per assistant message.

import { computeCost, loadPricingTable } from '@tracebench/core';
import type {
  CanonicalEvent,
  EventTokens,
  EventTool,
  EventType,
  Session,
} from '@tracebench/core';
import type { LoadedOpencodeSession } from './db-read.js';
import { parseOpencodeDbUri } from './db-uri.js';

export const FORMAT_VERSION = '2026-q1';

export interface NormalizeResult {
  session: Session;
  events: CanonicalEvent[];
}

function emptyTool(): EventTool {
  return { name: null, input: null, output: null, status: null, error_message: null };
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

function msToIso(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function deriveTitle(text: string | null): string | null {
  if (!text) return null;
  const single = text.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > 120 ? single.slice(0, 117) + '...' : single;
}

function mapToolName(name: string | undefined): string | null {
  if (!name) return null;
  const map: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    question: 'Question',
  };
  return map[name.toLowerCase()] ?? name;
}

function messageModel(data: Record<string, unknown>): string | null {
  if (typeof data.modelID === 'string') return data.modelID;
  const model = data.model;
  if (model && typeof model === 'object' && 'modelID' in model) {
    const id = (model as { modelID?: unknown }).modelID;
    if (typeof id === 'string') return id;
  }
  return null;
}

function partTimestamp(
  partData: Record<string, unknown>,
  messageData: Record<string, unknown>,
  messageRowTime: number,
): string {
  const time = partData.time;
  if (time && typeof time === 'object') {
    const start = (time as { start?: unknown }).start;
    if (typeof start === 'number') return msToIso(start);
    const end = (time as { end?: unknown }).end;
    if (typeof end === 'number') return msToIso(end);
  }
  const msgTime = messageData.time;
  if (msgTime && typeof msgTime === 'object') {
    const created = (msgTime as { created?: unknown }).created;
    if (typeof created === 'number') return msToIso(created);
  }
  return msToIso(messageRowTime);
}

function messageTokens(data: Record<string, unknown>): EventTokens | null {
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const t = tokens as Record<string, unknown>;
  const cache = t.cache;
  const cacheObj = cache && typeof cache === 'object' ? (cache as Record<string, unknown>) : {};
  return {
    input: typeof t.input === 'number' ? t.input : null,
    output: typeof t.output === 'number' ? t.output : null,
    reasoning: typeof t.reasoning === 'number' ? t.reasoning : null,
    cache_read: typeof cacheObj.read === 'number' ? cacheObj.read : null,
    cache_creation: typeof cacheObj.write === 'number' ? cacheObj.write : null,
  };
}

function attachUsage(
  target: CanonicalEvent,
  messageData: Record<string, unknown>,
  pricing: ReturnType<typeof loadPricingTable>,
): void {
  const tokens = messageTokens(messageData);
  if (!tokens) return;
  target.tokens = tokens;
  const loggedCost = typeof messageData.cost === 'number' ? messageData.cost : null;
  if (loggedCost != null && loggedCost > 0) {
    target.cost_usd = loggedCost;
    target.cost_method = 'logged';
    return;
  }
  const cost = computeCost({
    model: target.model,
    tokens,
    table: pricing,
  });
  if (cost.method) {
    target.cost_usd = cost.usd;
    target.cost_method = cost.method;
  }
}

export function normalizeSession(
  loaded: LoadedOpencodeSession,
  opts: { rawPath: string; formatVersion?: string },
): NormalizeResult {
  const { session, messages } = loaded;
  const sessionId = session.id;
  const formatVersion = opts.formatVersion ?? FORMAT_VERSION;
  const source = {
    harness: 'opencode' as const,
    format_version: formatVersion,
    raw_path: opts.rawPath,
  };

  const pricing = loadPricingTable();
  const events: CanonicalEvent[] = [];
  let turnIndex = 0;
  let currentTurnId = `${sessionId}::t0`;
  let title: string | null = session.title || null;
  let firstUserText: string | null = null;

  function newTurn(): void {
    turnIndex += 1;
    currentTurnId = `${sessionId}::t${turnIndex}`;
  }

  function pushEvent(e: CanonicalEvent): void {
    events.push(e);
  }

  for (const msg of messages) {
    const role = typeof msg.data.role === 'string' ? msg.data.role : 'unknown';
    const model = messageModel(msg.data);

    if (role === 'user') {
      newTurn();
      const textParts = msg.parts
        .filter((p) => p.data.type === 'text' && typeof p.data.text === 'string')
        .map((p) => p.data.text as string);
      const content = textParts.length > 0 ? textParts.join('\n') : null;
      if (!firstUserText && content) firstUserText = content;
      if (!title && content) title = deriveTitle(content);

      pushEvent({
        event_id: msg.row.id,
        session_id: sessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: msToIso(
          (msg.data.time as { created?: number } | undefined)?.created ?? msg.row.time_created,
        ),
        source,
        role: 'user',
        event_type: 'message',
        model,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content,
        tool: emptyTool(),
        metadata: {
          agent: msg.data.agent ?? null,
          provider: msg.data.providerID ?? null,
        },
        raw: { message: msg.data, parts: msg.parts.map((p) => p.data) },
      });
      continue;
    }

    if (role !== 'assistant') {
      pushEvent({
        event_id: msg.row.id,
        session_id: sessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: msToIso(msg.row.time_created),
        source,
        role: 'system',
        event_type: 'meta',
        model,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content: null,
        tool: emptyTool(),
        metadata: { kind: 'unknown_message_role', role },
        raw: { message: msg.data, parts: msg.parts.map((p) => p.data) },
      });
      continue;
    }

    let firstAssistantEvent: CanonicalEvent | null = null;
    const msgStart = (msg.data.time as { created?: number } | undefined)?.created;
    const msgEnd = (msg.data.time as { completed?: number } | undefined)?.completed;
    const msgDuration =
      typeof msgStart === 'number' && typeof msgEnd === 'number' ? msgEnd - msgStart : null;

    for (const part of msg.parts) {
      const partType = typeof part.data.type === 'string' ? part.data.type : 'unknown';
      const ts = partTimestamp(part.data, msg.data, part.row.time_created);
      const baseMeta = {
        part_id: part.row.id,
        message_id: msg.row.id,
        agent: msg.data.agent ?? null,
        mode: msg.data.mode ?? null,
      };

      if (partType === 'text') {
        const text = typeof part.data.text === 'string' ? part.data.text : null;
        const evt: CanonicalEvent = {
          event_id: part.row.id,
          session_id: sessionId,
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
          duration_ms: firstAssistantEvent ? null : msgDuration,
          content: text,
          tool: emptyTool(),
          metadata: baseMeta,
          raw: part.data,
        };
        pushEvent(evt);
        if (!firstAssistantEvent) firstAssistantEvent = evt;
        continue;
      }

      if (partType === 'reasoning') {
        const text = typeof part.data.text === 'string' ? part.data.text : null;
        const evt: CanonicalEvent = {
          event_id: part.row.id,
          session_id: sessionId,
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
          content: text,
          tool: emptyTool(),
          metadata: baseMeta,
          raw: part.data,
        };
        pushEvent(evt);
        if (!firstAssistantEvent) firstAssistantEvent = evt;
        continue;
      }

      if (partType === 'tool') {
        const callId =
          typeof part.data.callID === 'string'
            ? part.data.callID
            : typeof part.data.callId === 'string'
              ? part.data.callId
              : part.row.id;
        const toolName = mapToolName(typeof part.data.tool === 'string' ? part.data.tool : undefined);
        const state =
          part.data.state && typeof part.data.state === 'object'
            ? (part.data.state as Record<string, unknown>)
            : {};
        const input =
          state.input && typeof state.input === 'object'
            ? (state.input as Record<string, unknown>)
            : null;
        const statusRaw = typeof state.status === 'string' ? state.status : null;
        const isError = statusRaw === 'error';
        const toolTime = state.time && typeof state.time === 'object' ? (state.time as Record<string, unknown>) : {};
        const toolDuration =
          typeof toolTime.start === 'number' && typeof toolTime.end === 'number'
            ? toolTime.end - toolTime.start
            : null;

        const callEvt: CanonicalEvent = {
          event_id: callId,
          session_id: sessionId,
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
          duration_ms: toolDuration,
          content: null,
          tool: {
            name: toolName,
            input,
            output: null,
            status: isError ? 'error' : statusRaw === 'completed' ? 'success' : null,
            error_message: isError && typeof state.error === 'string' ? state.error : null,
          },
          metadata: baseMeta,
          raw: part.data,
        };
        pushEvent(callEvt);
        if (!firstAssistantEvent) firstAssistantEvent = callEvt;

        const output: string | Record<string, unknown> | null =
          typeof state.output === 'string'
            ? state.output
            : state.output != null && typeof state.output === 'object'
              ? (state.output as Record<string, unknown>)
              : null;
        if (output != null || isError) {
          pushEvent({
            event_id: `${callId}::result`,
            session_id: sessionId,
            turn_id: currentTurnId,
            parent_event_id: callId,
            timestamp: ts,
            source,
            role: 'tool',
            event_type: 'tool_result',
            model: null,
            tokens: emptyTokens(),
            cost_usd: null,
            cost_method: null,
            duration_ms: null,
            content: typeof output === 'string' ? output : null,
            tool: {
              name: toolName,
              input: null,
              output,
              status: isError ? 'error' : 'success',
              error_message: isError && typeof state.error === 'string' ? state.error : null,
            },
            metadata: baseMeta,
            raw: part.data,
          });
        }
        continue;
      }

      if (partType === 'compaction') {
        pushEvent({
          event_id: part.row.id,
          session_id: sessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'system',
          event_type: 'compaction',
          model,
          tokens: emptyTokens(),
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: { ...baseMeta, auto: part.data.auto ?? null, overflow: part.data.overflow ?? null },
          raw: part.data,
        });
        continue;
      }

      let eventType: EventType = 'meta';
      if (partType === 'step-finish' && typeof part.data.reason === 'string' && part.data.reason === 'stop') {
        eventType = 'summary';
      }

      pushEvent({
        event_id: part.row.id,
        session_id: sessionId,
        turn_id: currentTurnId,
        parent_event_id: null,
        timestamp: ts,
        source,
        role: 'system',
        event_type: eventType,
        model,
        tokens: emptyTokens(),
        cost_usd: null,
        cost_method: null,
        duration_ms: null,
        content:
          partType === 'file' && typeof part.data.filename === 'string'
            ? `[file: ${part.data.filename}]`
            : null,
        tool: emptyTool(),
        metadata: { kind: partType, ...baseMeta },
        raw: part.data,
      });
    }

    if (firstAssistantEvent) {
      attachUsage(firstAssistantEvent, msg.data, pricing);
    }
  }

  if (!title && firstUserText) title = deriveTitle(firstUserText);

  let sessionModel: string | null = null;
  for (const msg of messages) {
    const m = messageModel(msg.data);
    if (m) sessionModel = m;
  }

  const sessionRow: Session = {
    session_id: sessionId,
    harness: 'opencode',
    project_path: session.directory,
    title: title ?? session.slug ?? sessionId,
    started_at: msToIso(session.time_created),
    ended_at: msToIso(session.time_updated),
    model: sessionModel,
    raw_path: opts.rawPath,
    format_version: formatVersion,
    mtime_ms: session.time_updated,
  };

  return { session: sessionRow, events };
}

export async function loadSession(rawPath: string): Promise<NormalizeResult> {
  const parsed = parseOpencodeDbUri(rawPath);
  if (!parsed) {
    throw new Error(`not an OpenCode DB path: ${rawPath}`);
  }
  const { loadSessionFromDb } = await import('./db-read.js');
  const loaded = loadSessionFromDb(parsed.dbPath, parsed.sessionId);
  if (!loaded) {
    throw new Error(`OpenCode session not found: ${parsed.sessionId}`);
  }
  return normalizeSession(loaded, { rawPath });
}
