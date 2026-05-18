// Pure selectors / data transforms over canonical events.
//
// One place to express "how a tool_call is linked to its tool_result" and
// related primitives — both App.tsx (error navigation) and Timeline.tsx
// (per-turn rendering) consume the same lookups, and a bug in the linking
// rule (e.g. handling multiple results per call_id) only needs fixing here.

import type { CanonicalEvent, Turn } from './types';

/**
 * Build a `call_id → tool_result` lookup over a flat event list. Used to
 * pair a tool_call with its matching tool_result.
 *
 * If multiple tool_results share a parent_event_id (rare but possible during
 * compaction edges), the last one wins — that's what the UI was already
 * doing implicitly.
 */
export function indexToolResultsByCall(
  events: readonly CanonicalEvent[],
): Map<string, CanonicalEvent> {
  const m = new Map<string, CanonicalEvent>();
  for (const e of events) {
    if (e.event_type === 'tool_result' && e.parent_event_id) {
      m.set(e.parent_event_id, e);
    }
  }
  return m;
}

/**
 * Walk all turns and return the event_ids of tool_call events whose matched
 * tool_result has status === 'error'. Used by the error-navigation feature
 * (click "N err" → scroll to first/next one).
 *
 * O(events) total — one pass to index per turn, one pass to filter.
 */
export function findErrorToolCallIds(turns: readonly Turn[]): string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    const byCall = indexToolResultsByCall(turn.events);
    for (const e of turn.events) {
      if (
        e.event_type === 'tool_call' &&
        byCall.get(e.event_id)?.tool.status === 'error'
      ) {
        ids.push(e.event_id);
      }
    }
  }
  return ids;
}
