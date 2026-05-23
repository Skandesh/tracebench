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

/**
 * Narrow turns to a single tool type for the session-header filter pills.
 * O(events) total. Drops turns with no matching calls and strips
 * non-tool events so pill switching is fast and visually obvious.
 */
export function filterTurnsByTool(
  turns: readonly Turn[],
  filterTool: string | null,
): Turn[] {
  if (!filterTool) return turns as Turn[];

  const filtered: Turn[] = [];

  for (const turn of turns) {
    const matchingCallIds = new Set<string>();
    for (const e of turn.events) {
      if (e.event_type === 'tool_call' && e.tool.name === filterTool) {
        matchingCallIds.add(e.event_id);
      }
    }
    if (matchingCallIds.size === 0) continue;

    const events: CanonicalEvent[] = [];
    for (const e of turn.events) {
      if (e.event_type === 'tool_call' && matchingCallIds.has(e.event_id)) {
        events.push(e);
      } else if (
        e.event_type === 'tool_result' &&
        e.parent_event_id &&
        matchingCallIds.has(e.parent_event_id)
      ) {
        events.push(e);
      }
    }

    filtered.push({ ...turn, events });
  }

  return filtered;
}

export interface ToolCallPair {
  call: CanonicalEvent;
  result?: CanonicalEvent;
}

/**
 * Flat list of matching tool_call + tool_result pairs in session order.
 * Used by the filtered timeline view — avoids turn-group DOM overhead.
 */
export function listFilteredToolCalls(
  turns: readonly Turn[],
  filterTool: string,
): ToolCallPair[] {
  const pairs: ToolCallPair[] = [];
  for (const turn of turns) {
    const byCall = indexToolResultsByCall(turn.events);
    for (const e of turn.events) {
      if (e.event_type === 'tool_call' && e.tool.name === filterTool) {
        pairs.push({ call: e, result: byCall.get(e.event_id) });
      }
    }
  }
  return pairs;
}
