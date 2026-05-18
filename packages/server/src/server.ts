// Server factory. Lives behind the CLI; exported so tests can spin one up
// without going through the CLI.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@tracebench/core';
import type { TracebenchDb } from '@tracebench/core';
import { defaultDbPath } from './paths.js';
import { registerRoutes } from './routes.js';
import { indexSessions } from './indexer.js';

export interface ServerOptions {
  /** SQLite path. Defaults to ~/.tracebench/tracebench.db */
  dbPath?: string;
  /** Claude Code projects directory. Defaults to ~/.claude/projects */
  projectsRoot?: string;
  /** Codex sessions root. Defaults to ~/.codex */
  codexRoot?: string;
  /** Skip the startup index pass. */
  noIndex?: boolean;
  /** Verbose stderr logging. */
  verbose?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: TracebenchDb;
}

function findUiBuildDir(): string | null {
  // When installed from npm the UI lives at <pkg>/ui (copied by prepack).
  // When running from the monorepo it lives at packages/ui/dist.
  // dist/server.js is in <pkg>/dist or packages/server/dist, so walk up.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'ui'), // npm-installed layout
    join(here, '..', '..', 'ui', 'dist'), // monorepo layout
    join(here, '..', '..', '..', 'ui', 'dist'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

export async function buildServer(opts: ServerOptions = {}): Promise<BuiltServer> {
  const db = openDb({ path: opts.dbPath ?? defaultDbPath() });
  const app = Fastify({
    logger: opts.verbose
      ? { level: 'info' }
      : { level: 'warn' },
  });

  const roots = {
    claude_code: opts.projectsRoot,
    codex: opts.codexRoot,
  } as const;

  await registerRoutes(app, { db, roots });

  // Static UI: if a built UI exists, serve it. Otherwise a friendly fallback
  // page that explains how to start the dev UI.
  const uiDir = findUiBuildDir();
  if (uiDir) {
    await app.register(fastifyStatic, { root: uiDir, prefix: '/' });
    // SPA fallback — any non-API GET serves index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html').send(LANDING_HTML);
    });
  }

  if (!opts.noIndex) {
    const result = await indexSessions(db, {
      roots: {
        claude_code: opts.projectsRoot,
        codex: opts.codexRoot,
      },
      verbose: opts.verbose,
    });
    if (opts.verbose) {
      const perHarness = Object.entries(result.per_harness)
        .map(([h, s]) => `${h}=${s.indexed}/${s.scanned}`)
        .join(' ');
      process.stderr.write(
        `[tracebench] indexed ${result.indexed} / ${result.scanned} sessions (${perHarness}; ${result.skipped} unchanged, ${result.errors.length} errors) in ${result.duration_ms}ms\n`,
      );
    }
  }

  return { app, db };
}

const LANDING_HTML = `<!doctype html>
<html><head><title>tracebench — backend running</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; color: #d4d4d4; background: #0a0a0a; }
h1 { font-weight: 600; }
code { background: #1a1a1a; padding: 0.1rem 0.4rem; border-radius: 4px; color: #5eead4; }
a { color: #5eead4; }
.dim { color: #888; }
</style></head>
<body>
<h1>tracebench backend is running</h1>
<p class="dim">The UI hasn't been built yet. The HTTP API is live; try:</p>
<ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/sessions">/api/sessions</a></li>
  <li><a href="/api/sessions?harness=claude_code&amp;limit=5">/api/sessions?harness=claude_code&amp;limit=5</a></li>
  <li><a href="/api/pricing">/api/pricing</a></li>
</ul>
<p class="dim">Once the UI package is built (<code>pnpm --filter @tracebench/ui build</code>), it'll be served here automatically.</p>
</body></html>`;
