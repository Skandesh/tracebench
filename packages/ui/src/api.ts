// Thin fetch wrapper around the Tracebench backend.

import type { Session, ToolCount, Turn, Harness, CanonicalEvent } from './types';

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${url}`);
  }
  return res.json() as Promise<T>;
}

export interface ListSessionsParams {
  harness?: Harness | 'all';
  q?: string;
  limit?: number;
  offset?: number;
}

export function listSessions(params: ListSessionsParams = {}): Promise<{ sessions: Session[] }> {
  const qs = new URLSearchParams();
  if (params.harness && params.harness !== 'all') qs.set('harness', params.harness);
  if (params.q) qs.set('q', params.q);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const url = '/api/sessions' + (qs.toString() ? '?' + qs : '');
  return getJSON<{ sessions: Session[] }>(url);
}

export function getSession(id: string): Promise<{ session: Session; tool_counts: ToolCount[] }> {
  return getJSON(`/api/sessions/${encodeURIComponent(id)}`);
}

export function getSessionTurns(id: string): Promise<{ turns: Turn[] }> {
  return getJSON(`/api/sessions/${encodeURIComponent(id)}/turns`);
}

export function getSessionEvents(id: string): Promise<{ events: CanonicalEvent[] }> {
  return getJSON(`/api/sessions/${encodeURIComponent(id)}/events`);
}

export function reindex(): Promise<{ scanned: number; indexed: number; skipped: number; deferred: number }> {
  return fetch('/api/reindex', { method: 'POST' }).then((r) => r.json());
}
