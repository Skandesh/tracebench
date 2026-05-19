// Pure helper to summarize a session's canonical events into a single
// aggregate row. Used by the indexer at write time so /api/sessions doesn't
// need to GROUP BY over the events table at query time.

import type { CanonicalEvent } from './schema.js';
import type { SessionAggregateRow } from './db.js';

export function summarizeEvents(events: readonly CanonicalEvent[]): SessionAggregateRow {
  let total_cost_usd = 0;
  let total_input_tokens = 0;
  let total_output_tokens = 0;
  let total_cache_read_tokens = 0;
  let total_cache_create_tokens = 0;
  let total_reasoning_tokens = 0;
  let duration_ms = 0;
  let tool_call_count = 0;
  let tool_error_count = 0;
  let message_count = 0;
  const turnIds = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const e of events) {
    if (e.cost_usd != null) total_cost_usd += e.cost_usd;
    if (e.tokens.input != null) total_input_tokens += e.tokens.input;
    if (e.tokens.output != null) total_output_tokens += e.tokens.output;
    if (e.tokens.cache_read != null) total_cache_read_tokens += e.tokens.cache_read;
    if (e.tokens.cache_creation != null) total_cache_create_tokens += e.tokens.cache_creation;
    if (e.tokens.reasoning != null) total_reasoning_tokens += e.tokens.reasoning;
    if (e.duration_ms != null) duration_ms += e.duration_ms;
    if (e.event_type === 'tool_call') tool_call_count++;
    if (e.tool.status === 'error') tool_error_count++;
    if (e.event_type === 'message') message_count++;
    if (e.turn_id) turnIds.add(e.turn_id);
    if (e.timestamp) {
      if (!firstTs || e.timestamp < firstTs) firstTs = e.timestamp;
      if (!lastTs || e.timestamp > lastTs) lastTs = e.timestamp;
    }
  }

  // If event durations weren't recorded, fall back to wall-clock between
  // first and last event.
  if (duration_ms === 0 && firstTs && lastTs) {
    duration_ms = Math.max(0, new Date(lastTs).getTime() - new Date(firstTs).getTime());
  }

  return {
    total_cost_usd,
    total_input_tokens,
    total_output_tokens,
    total_cache_read_tokens,
    total_cache_create_tokens,
    total_reasoning_tokens,
    duration_ms,
    turn_count: turnIds.size,
    tool_call_count,
    tool_error_count,
    message_count,
  };
}
