// HTTP routes for Tracebench.
//
// All read-only over local SQLite. No auth. No CORS — the UI is served from
// the same origin (or via Vite proxy in dev).

import type { FastifyInstance } from 'fastify';
import {
  listSessions,
  getSession,
  getSessionEvents,
  getSessionTurns,
  getToolCounts,
  loadPricingTable,
  type Harness,
  type TracebenchDb,
} from '@tracebench/core';
import { indexSessions } from './indexer.js';

export interface RouteContext {
  db: TracebenchDb;
  roots: Partial<Record<Harness, string | undefined>>;
  cursorGlobalDbPath?: string;
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

  // POST trigger a re-index; returns the same shape as startup.
  app.post('/api/reindex', async () => {
    const roots: Partial<Record<Harness, string>> = {};
    for (const [k, v] of Object.entries(ctx.roots)) {
      if (typeof v === 'string') roots[k as Harness] = v;
    }
    return indexSessions(ctx.db, {
      roots,
      cursorGlobalDbPath: ctx.cursorGlobalDbPath,
    });
  });
}
