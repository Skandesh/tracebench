// Thin fetch wrapper around the Tracebench backend.

import type {
  Session,
  ToolCount,
  Turn,
  Harness,
  CanonicalEvent,
  DiscoveredSession,
  StorageReport,
} from './types';

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

export function getEventRaw(
  sessionId: string,
  eventId: string,
): Promise<{
  event: CanonicalEvent;
  raw: unknown;
  provenance: Record<string, unknown>;
}> {
  return getJSON(
    `/api/sessions/${encodeURIComponent(sessionId)}/events/${encodeURIComponent(eventId)}/raw`,
  );
}

export function listDiscoveredSessions(params: { harness?: Harness | 'all' } = {}): Promise<{ sessions: DiscoveredSession[] }> {
  const qs = new URLSearchParams();
  if (params.harness && params.harness !== 'all') qs.set('harness', params.harness);
  const url = '/api/discovered-sessions' + (qs.toString() ? '?' + qs : '');
  return getJSON<{ sessions: DiscoveredSession[] }>(url);
}

export function getStorageReport(): Promise<StorageReport> {
  return getJSON<StorageReport>('/api/storage');
}

export function reindex(): Promise<{ scanned: number; indexed: number; skipped: number; deferred: number }> {
  return fetch('/api/reindex', { method: 'POST' }).then((r) => r.json());
}

export function indexSession(id: string): Promise<{ scanned: number; indexed: number; skipped: number; deferred: number }> {
  return fetch(`/api/sessions/${encodeURIComponent(id)}/index`, { method: 'POST' }).then((r) => r.json());
}
