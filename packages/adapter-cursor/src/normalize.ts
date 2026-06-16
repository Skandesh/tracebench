// Convert Cursor agent-transcript JSONL into canonical Tracebench events.
//
// Cursor writes supplementary logs under ~/.cursor/projects/.../agent-transcripts/.
// Format is Anthropic-like (role + message.content blocks) but:
//   - no per-line timestamps (synthetic timestamps from file mtime)
//   - tool_use blocks have no id field
//   - no tool_result lines — tool outputs are not exported separately
//
// Turn boundaries: each user text message starts a new turn.

import type { CanonicalEvent, EventTool, EventType, Session } from '@tracebench/core';
import type { RawCursorEvent } from './parse.js';
import { decodeProjectPath } from './paths.js';

interface NormalizeOptions {
  rawPath: string;
  sessionId?: string;
  formatVersion: string;
  /** File mtime (ms) — used for synthetic per-line timestamps. */
  fileMtimeMs?: number;
  encodedProjectDir?: string;
}

export interface NormalizeResult {
  session: Session;
  events: CanonicalEvent[];
}

function emptyTool(): EventTool {
  return { name: null, input: null, output: null, status: null, error_message: null };
}

const emptyTokens = {
  input: null,
  output: null,
  cache_read: null,
  cache_creation: null,
  reasoning: null,
} as const;

function toString(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
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

function stripUserQuery(text: string | null): string | null {
  if (text == null) return null;
  const stripped = text.replace(/<\/?user_query>/gi, '').trim();
  return stripped.length > 0 ? stripped : null;
}

function deriveTitle(content: unknown): string | null {
  const s = stripUserQuery(toString(content));
  if (!s) return null;
  const single = s.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > 120 ? single.slice(0, 117) + '...' : single;
}

export function parseTranscriptPath(rawPath: string): {
  encoded_project_dir: string | null;
  subagent: boolean;
  parent_session_id: string | null;
} {
  const dirMatch = rawPath.match(/\/projects\/([^/]+)\/agent-transcripts\//);
  const encoded = dirMatch ? dirMatch[1]! : null;
  const subMatch = /\/agent-transcripts\/([^/]+)\/subagents\/([^/]+)\.jsonl$/i.exec(rawPath);
  if (subMatch) {
    return {
      encoded_project_dir: encoded,
      subagent: true,
      parent_session_id: subMatch[1]!,
    };
  }
  return { encoded_project_dir: encoded, subagent: false, parent_session_id: null };
}

function syntheticTimestamps(lineCount: number, endMs: number): string[] {
  if (lineCount === 0) return [];
  const span = Math.max(lineCount - 1, 0) * 1000;
  const startMs = endMs - span;
  return Array.from({ length: lineCount }, (_, i) =>
    new Date(startMs + i * 1000).toISOString(),
  );
}

export function normalizeSession(
  raws: RawCursorEvent[],
  opts: NormalizeOptions,
): NormalizeResult {
  const pathInfo = parseTranscriptPath(opts.rawPath);
  const encodedDir =
    opts.encodedProjectDir ?? pathInfo.encoded_project_dir ?? 'unknown';
  const projectPath = decodeProjectPath(encodedDir);

  let resolvedSessionId = opts.sessionId ?? null;
  if (!resolvedSessionId) {
    resolvedSessionId =
      opts.rawPath.split('/').pop()?.replace(/\.jsonl$/, '') ?? 'unknown';
  }

  const endMs = opts.fileMtimeMs ?? Date.now();
  const timestamps = syntheticTimestamps(raws.length, endMs);
  const firstTs = timestamps[0] ?? new Date(endMs).toISOString();
  const lastTs = timestamps[timestamps.length - 1] ?? firstTs;

  let firstUser: RawCursorEvent | undefined;
  for (const r of raws) {
    if (r.role === 'user' && !firstUser) firstUser = r;
  }

  const titleSource = firstUser
    ? ((firstUser.message as { content?: unknown } | undefined)?.content ?? null)
    : null;
  const title = deriveTitle(titleSource);

  const source = {
    harness: 'cursor' as const,
    format_version: opts.formatVersion,
    raw_path: opts.rawPath,
  };

  const sessionMeta: Record<string, unknown> = {
    encoded_project_dir: encodedDir,
  };
  if (pathInfo.subagent) {
    sessionMeta.subagent = true;
    if (pathInfo.parent_session_id) sessionMeta.parent_session_id = pathInfo.parent_session_id;
  }

  const events: CanonicalEvent[] = [];
  let turnIndex = 0;
  let currentTurnId = `${resolvedSessionId}::t0`;

  function newTurn(): string {
    turnIndex += 1;
    currentTurnId = `${resolvedSessionId}::t${turnIndex}`;
    return currentTurnId;
  }

  function baseMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...sessionMeta, ...extra };
  }

  for (let lineIndex = 0; lineIndex < raws.length; lineIndex++) {
    const r = raws[lineIndex]!;
    const ts = timestamps[lineIndex] ?? lastTs;
    const role = typeof r.role === 'string' ? r.role : 'unknown';

    if (role === 'user') {
      newTurn();
      const content = (r.message as { content?: unknown } | undefined)?.content;
      events.push({
        event_id: `cursor:${resolvedSessionId}:u:${lineIndex}`,
        session_id: resolvedSessionId,
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
        content: stripUserQuery(toString(content)),
        tool: emptyTool(),
        metadata: baseMeta(),
        raw: r,
      });
      continue;
    }

    if (role === 'assistant') {
      const msg = (r.message as { content?: unknown } | undefined) ?? {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      if (blocks.length === 0) {
        events.push({
          event_id: `cursor:${resolvedSessionId}:a:${lineIndex}:0`,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: 'message',
          model: null,
          tokens: { ...emptyTokens },
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: null,
          tool: emptyTool(),
          metadata: baseMeta({ empty: true }),
          raw: r,
        });
        continue;
      }

      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi] as Record<string, unknown>;
        const blockType = typeof block.type === 'string' ? block.type : '';
        const eventId = `cursor:${resolvedSessionId}:${lineIndex}:${bi}`;

        let evtType: EventType = 'message';
        let toolInfo = emptyTool();
        let contentField: CanonicalEvent['content'] = null;

        if (blockType === 'text') {
          evtType = 'message';
          contentField = typeof block.text === 'string' ? block.text : null;
        } else if (blockType === 'tool_use') {
          evtType = 'tool_call';
          toolInfo = {
            name: typeof block.name === 'string' ? block.name : null,
            input: (block.input as Record<string, unknown> | undefined) ?? null,
            output: null,
            status: null,
            error_message: null,
          };
        } else if (blockType === 'thinking') {
          evtType = 'thinking';
          contentField =
            typeof block.thinking === 'string'
              ? block.thinking
              : typeof block.text === 'string'
                ? block.text
                : null;
        } else {
          evtType = 'meta';
          contentField = block as unknown as CanonicalEvent['content'];
        }

        events.push({
          event_id: eventId,
          session_id: resolvedSessionId,
          turn_id: currentTurnId,
          parent_event_id: null,
          timestamp: ts,
          source,
          role: 'assistant',
          event_type: evtType,
          model: null,
          tokens: { ...emptyTokens },
          cost_usd: null,
          cost_method: null,
          duration_ms: null,
          content: contentField,
          tool: toolInfo,
          metadata: baseMeta(blockType && blockType !== 'text' ? { block_type: blockType } : {}),
          raw: bi === 0 ? r : { _ref_line: lineIndex },
        });
      }
      continue;
    }

    events.push({
      event_id: `cursor:${resolvedSessionId}:meta:${lineIndex}`,
      session_id: resolvedSessionId,
      turn_id: currentTurnId,
      parent_event_id: null,
      timestamp: ts,
      source,
      role: 'system',
      event_type: 'meta',
      model: null,
      tokens: { ...emptyTokens },
      cost_usd: null,
      cost_method: null,
      duration_ms: null,
      content: null,
      tool: emptyTool(),
      metadata: baseMeta({ kind: role }),
      raw: r,
    });
  }

  const session: Session = {
    session_id: resolvedSessionId,
    harness: 'cursor',
    project_path: projectPath,
    title,
    started_at: firstTs,
    ended_at: lastTs,
    model: null,
    raw_path: opts.rawPath,
    format_version: opts.formatVersion,
    mtime_ms: 0,
  };

  return { session, events };
}

import { parseSession, streamSessionRecords } from './parse.js';
import { promises as fs } from 'node:fs';
import { isComposerDbUri } from './db-uri.js';
import { loadComposerSession } from './load-db.js';

export async function loadSession(
  filePath: string,
  opts: { formatVersion?: string; encodedProjectDir?: string } = {},
): Promise<NormalizeResult> {
  if (isComposerDbUri(filePath)) {
    return loadComposerSession(filePath, opts);
  }

  const raws = await parseSession(filePath);
  let fileMtimeMs: number | undefined;
  try {
    const st = await fs.stat(filePath);
    fileMtimeMs = st.mtimeMs;
  } catch {
    // ignore
  }
  const sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '');
  return normalizeSession(raws, {
    rawPath: filePath,
    sessionId,
    formatVersion: opts.formatVersion ?? '2026-q1',
    fileMtimeMs,
    encodedProjectDir: opts.encodedProjectDir,
  });
}

export async function* streamLoadSession(
  filePath: string,
  opts: { formatVersion?: string; encodedProjectDir?: string; batchSize?: number } = {},
): AsyncIterable<
  | { type: 'session'; session: Session }
  | { type: 'events'; events: CanonicalEvent[] }
> {
  if (isComposerDbUri(filePath)) {
    const normalized = await loadComposerSession(filePath, opts);
    yield { type: 'session', session: normalized.session };
    const batchSize = Math.max(1, opts.batchSize ?? 500);
    for (let i = 0; i < normalized.events.length; i += batchSize) {
      yield { type: 'events', events: normalized.events.slice(i, i + batchSize) };
    }
    return;
  }

  const records: Array<{ raw: RawCursorEvent; line: number }> = [];
  for await (const record of streamSessionRecords(filePath)) {
    records.push(record);
  }
  let fileMtimeMs: number | undefined;
  try {
    const st = await fs.stat(filePath);
    fileMtimeMs = st.mtimeMs;
  } catch {
    // ignore
  }
  const sessionId = filePath.split('/').pop()?.replace(/\.jsonl$/, '');
  const lineByRaw = new WeakMap<object, number>();
  records.forEach((record) => lineByRaw.set(record.raw, record.line));
  const normalized = normalizeSession(
    records.map((r) => r.raw),
    {
      rawPath: filePath,
      sessionId,
      formatVersion: opts.formatVersion ?? '2026-q1',
      fileMtimeMs,
      encodedProjectDir: opts.encodedProjectDir,
    },
  );
  yield { type: 'session', session: normalized.session };
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  let batch: CanonicalEvent[] = [];
  for (const event of normalized.events) {
    batch.push(attachSourceLocator(event, lineByRaw));
    if (batch.length >= batchSize) {
      yield { type: 'events', events: batch };
      batch = [];
    }
  }
  if (batch.length > 0) yield { type: 'events', events: batch };
}

function attachSourceLocator(
  event: CanonicalEvent,
  lineByRaw: WeakMap<object, number>,
): CanonicalEvent {
  let line: number | undefined;
  if (typeof event.raw === 'object' && event.raw !== null) {
    line = lineByRaw.get(event.raw);
    const refLine = (event.raw as { _ref_line?: unknown })._ref_line;
    if (line == null && typeof refLine === 'number') line = refLine + 1;
  }
  if (line == null) return event;
  return { ...event, source: ({ ...(event.source as unknown as Record<string, unknown>), line } as unknown as CanonicalEvent['source']) };
}
