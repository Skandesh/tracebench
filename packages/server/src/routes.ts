// HTTP routes for Tracebench.
//
// All read-only over local SQLite. No auth. No CORS — the UI is served from
// the same origin (or via Vite proxy in dev).

import type { FastifyInstance } from 'fastify';
import {
  listSessions,
  getSession,
  getSessionEvents,
  getEventRaw,
  getSessionTurns,
  getToolCounts,
  listDiscoveredSessions,
  loadPricingTable,
  searchEvents,
  type Harness,
  type TracebenchDb,
} from '@tracebench/core';
import { indexSessions } from './indexer.js';
import { buildStorageReport, parseByteSize, parseSinceMs } from './storage.js';

export interface RouteContext {
  db: TracebenchDb;
  dbPath?: string;
  roots: Partial<Record<Harness, string | undefined>>;
  cursorGlobalDbPath?: string;
  /** Shared local embedder for the semantic search leg; set by the background
   *  pipeline once the model loads (null until then → lexical-only). */
  embedder?: { embed: (texts: string[]) => Promise<number[][]> } | null;
  /** Vector budget for the semantic leg. */
  maxVectorChunks?: number;
}

export async function registerRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get<{
    Querystring: {
      harness?: string;
      project?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/sessions', async (req) => {
    const rawHarness = req.query.harness;
    const harness =
      rawHarness && rawHarness !== 'all' ? (rawHarness as Harness) : undefined;
    const sessions = listSessions(ctx.db, {
      harness,
      project_path: req.query.project,
      search: req.query.q,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return { sessions };
  });

  // Cross-session body search (U4). Empty q returns an empty result (not 500).
  app.get<{
    Querystring: { q?: string; harness?: string; limit?: string; offset?: string };
  }>('/api/search', async (req) => {
    const rawHarness = req.query.harness;
    const harness =
      rawHarness && rawHarness !== 'all' ? (rawHarness as Harness) : undefined;
    const embedder = ctx.embedder;
    const embedQuery = embedder
      ? async (q: string): Promise<number[] | null> => {
          const [v] = await embedder.embed([q]);
          return v ?? null;
        }
      : undefined;
    return searchEvents(
      ctx.db,
      {
        q: req.query.q ?? '',
        harness,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      },
      { embedQuery, maxVectorChunks: ctx.maxVectorChunks },
    );
  });

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req, reply) => {
      const session = getSession(ctx.db, req.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'session_not_found', session_id: req.params.id };
      }
      const tool_counts = getToolCounts(ctx.db, req.params.id);
      return { session, tool_counts };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/events',
    async (req, reply) => {
      const session = getSession(ctx.db, req.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'session_not_found', session_id: req.params.id };
      }
      return { events: getSessionEvents(ctx.db, req.params.id) };
    },
  );

  app.get<{ Params: { id: string; eventId: string } }>(
    '/api/sessions/:id/events/:eventId/raw',
    async (req, reply) => {
      const session = getSession(ctx.db, req.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'session_not_found', session_id: req.params.id };
      }
      const result = await getEventRaw(
        ctx.db,
        req.params.id,
        req.params.eventId,
      );
      if (!result) {
        reply.code(404);
        return {
          error: 'event_not_found',
          session_id: req.params.id,
          event_id: req.params.eventId,
        };
      }
      return result;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/turns',
    async (req, reply) => {
      const session = getSession(ctx.db, req.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'session_not_found', session_id: req.params.id };
      }
      return { turns: getSessionTurns(ctx.db, req.params.id) };
    },
  );

  app.get('/api/pricing', async () => {
    const table = loadPricingTable();
    return table;
  });

  app.get('/api/storage', async () => {
    return buildStorageReport({
      db: ctx.db,
      dbPath: ctx.dbPath,
      roots: ctx.roots,
      cursorGlobalDbPath: ctx.cursorGlobalDbPath,
    });
  });

  app.get<{
    Querystring: {
      harness?: string;
      session_id?: string;
    };
  }>('/api/discovered-sessions', async (req) => {
    const rawHarness = req.query.harness;
    const harness =
      rawHarness && rawHarness !== 'all' ? (rawHarness as Harness) : undefined;
    return {
      sessions: listDiscoveredSessions(ctx.db, {
        harness,
        session_id: req.query.session_id,
      }),
    };
  });

  // POST triggers a re-index; returns the same shape as startup.
  app.post<{
    Querystring: {
      harness?: string;
      full?: string;
      indexAll?: string;
      maxSessions?: string;
      maxSourceBytes?: string;
      since?: string;
      raw?: string;
    };
  }>('/api/reindex', async (req) => {
    const only = parseHarnessList(req.query.harness);
    return indexSessions(ctx.db, {
      roots: indexRoots(ctx),
      cursorGlobalDbPath: ctx.cursorGlobalDbPath,
      only,
      full: truthy(req.query.full),
      maxSessionsPerHarness: truthy(req.query.indexAll)
        ? undefined
        : parseOptionalInt(req.query.maxSessions),
      maxSourceBytesPerHarness: truthy(req.query.indexAll)
        ? undefined
        : parseOptionalBytes(req.query.maxSourceBytes),
      sinceMs: req.query.since ? parseSinceMs(req.query.since) : undefined,
      rawMode: req.query.raw === 'full' ? 'full' : 'reference',
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/index',
    async (req, reply) => {
      const discovered = listDiscoveredSessions(ctx.db, { session_id: req.params.id });
      if (discovered.length === 0) {
        reply.code(404);
        return { error: 'session_not_discovered', session_id: req.params.id };
      }
      return indexSessions(ctx.db, {
        roots: indexRoots(ctx),
        cursorGlobalDbPath: ctx.cursorGlobalDbPath,
        only: Array.from(new Set(discovered.map((d) => d.harness))),
        sessionIds: [req.params.id],
        rawMode: 'reference',
      });
    },
  );
}

function indexRoots(ctx: RouteContext): Partial<Record<Harness, string>> {
  const roots: Partial<Record<Harness, string>> = {};
  for (const [k, v] of Object.entries(ctx.roots)) {
    if (typeof v === 'string') roots[k as Harness] = v;
  }
  return roots;
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid integer: ${value}`);
  return Math.floor(n);
}

function parseOptionalBytes(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  return parseByteSize(value).bytes;
}

function parseHarnessList(value: string | undefined): Harness[] | undefined {
  if (!value || value === 'all') return undefined;
  return value.split(',').map((h) => h.trim()).filter(Boolean) as Harness[];
}
