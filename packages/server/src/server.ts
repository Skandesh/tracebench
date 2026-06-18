// Server factory. Lives behind the CLI; exported so tests can spin one up
// without going through the CLI.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  backfillSearchChunks,
  createEmbedder,
  runEmbedDrainBatch,
  setVecMeta,
  CHUNKER_VERSION,
} from '@tracebench/core';
import { defaultCursorUserDataDir } from '@tracebench/adapter-cursor';
import type { Harness, TracebenchDb } from '@tracebench/core';
import { defaultDbPath } from './paths.js';
import { registerRoutes, type RouteContext } from './routes.js';
import { indexSessions } from './indexer.js';

const DEFAULT_STARTUP_MAX_SESSIONS_PER_HARNESS = 200;
const DEFAULT_STARTUP_MAX_SOURCE_BYTES_PER_HARNESS = 1024 ** 3;

export interface ServerOptions {
  /** SQLite path. Defaults to ~/.tracebench/tracebench.db */
  dbPath?: string;
  /** Claude Code projects directory. Defaults to ~/.claude/projects */
  projectsRoot?: string;
  /** Codex sessions root. Defaults to ~/.codex */
  codexRoot?: string;
  /** Cursor projects root. Defaults to ~/.cursor/projects */
  cursorRoot?: string;
  /** OpenCode data root (contains opencode.db). Defaults to XDG data home / opencode. */
  opencodeRoot?: string;
  /** Cursor User data dir (global state.vscdb). Defaults to platform Cursor User path. */
  cursorUserDataDir?: string;
  /** Skip the startup index pass. */
  noIndex?: boolean;
  /** Preserve current startup freshness while bounding first-run/deep materialization. */
  indexAll?: boolean;
  maxSessionsPerHarness?: number;
  maxSourceBytesPerHarness?: number;
  sinceMs?: number;
  only?: Harness[];
  rawMode?: 'full' | 'reference';
  /** Opt in to the semantic leg (load sqlite-vec + embeddings). Off by default. */
  enableVectors?: boolean;
  /** Above this many stored vectors, semantic search auto-degrades to lexical. */
  maxVectorChunks?: number;
  /** Verbose stderr logging. */
  verbose?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  db: TracebenchDb;
}

function findUiBuildDir(): string | null {
  // Prefer the monorepo workspace bundle when it exists — that's the
  // "source of truth" during local dev. The npm-installed layout (<pkg>/ui)
  // is checked last so a stale prepack artifact at packages/server/ui doesn't
  // shadow a freshly-rebuilt packages/ui/dist in a dev session.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'ui', 'dist'), // monorepo (packages/server/dist → ../../ui/dist)
    join(here, '..', '..', '..', 'ui', 'dist'),
    join(here, '..', 'ui'), // npm-installed (<pkg>/dist → ../ui)
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

export async function buildServer(opts: ServerOptions = {}): Promise<BuiltServer> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const db = openDb({ path: dbPath, enableVectors: opts.enableVectors });
  const app = Fastify({
    logger: opts.verbose
      ? { level: 'info' }
      : { level: 'warn' },
  });

  const roots = {
    claude_code: opts.projectsRoot,
    codex: opts.codexRoot,
    cursor: opts.cursorRoot,
    opencode: opts.opencodeRoot,
  } as const;

  const cursorUserDir = opts.cursorUserDataDir ?? defaultCursorUserDataDir();
  const cursorGlobalDbPath = join(cursorUserDir, 'globalStorage', 'state.vscdb');

  const ctx: RouteContext = {
    db,
    dbPath,
    roots,
    cursorGlobalDbPath,
    embedder: null,
    maxVectorChunks: opts.maxVectorChunks,
  };
  await registerRoutes(app, ctx);

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
        cursor: opts.cursorRoot,
        opencode: opts.opencodeRoot,
      },
      cursorGlobalDbPath,
      only: opts.only,
      sinceMs: opts.sinceMs,
      maxSessionsPerHarness: opts.indexAll
        ? undefined
        : (opts.maxSessionsPerHarness ?? DEFAULT_STARTUP_MAX_SESSIONS_PER_HARNESS),
      maxSourceBytesPerHarness: opts.indexAll
        ? undefined
        : (opts.maxSourceBytesPerHarness ?? DEFAULT_STARTUP_MAX_SOURCE_BYTES_PER_HARNESS),
      rawMode: opts.rawMode ?? 'reference',
      verbose: opts.verbose,
    });
    if (opts.verbose) {
      const perHarness = Object.entries(result.per_harness)
        .map(([h, s]) => `${h}=${s.indexed}/${s.scanned}`)
        .join(' ');
      process.stderr.write(
        `[tracebench] indexed ${result.indexed} / ${result.scanned} sessions (${perHarness}; ${result.skipped} unchanged, ${result.deferred} deferred, ${result.errors.length} errors) in ${result.duration_ms}ms\n`,
      );
    }
    // Search background work — strictly AFTER indexing resolves, fire-and-forget
    // so it never blocks readiness: lexical backfill first (brings old sessions
    // into search), then the embedding drain when vectors are enabled.
    void runSearchBackground(ctx, opts.verbose);
  }

  return { app, db };
}

/**
 * Background pipeline: drain the lexical backfill to completion, then (when the
 * semantic leg is enabled) acquire the local embedder and drain pending
 * embeddings. Bounded batches with WAL checkpoints + yields keep foreground
 * requests responsive (RISK11/S1). All best-effort — failures degrade to
 * lexical-only and never crash the server.
 */
async function runSearchBackground(ctx: RouteContext, verbose?: boolean): Promise<void> {
  const { db } = ctx;
  const maxVectorChunks = ctx.maxVectorChunks;
  const log = (msg: string) => verbose && process.stderr.write(`[tracebench] ${msg}\n`);
  // 1) Lexical backfill.
  try {
    let total = 0;
    for (;;) {
      const { processed, remaining } = backfillSearchChunks(db, { limit: 25 });
      total += processed;
      if (processed > 0) {
        try {
          db.raw.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          /* best-effort */
        }
      }
      if (processed === 0 || remaining === 0) break;
      await new Promise((r) => setImmediate(r));
    }
    if (total > 0) log(`search backfill: indexed ${total} session(s)`);
  } catch (e) {
    log(`search backfill error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Embedding drain (only when the semantic leg loaded).
  if (!db.vectorsAvailable) return;
  try {
    const embedder = await createEmbedder();
    if (!embedder) {
      log('embeddings: model unavailable — semantic search disabled (lexical-only)');
      return;
    }
    // Publish to the route context so /api/search can embed queries (the
    // semantic leg goes live as soon as some vectors exist, even mid-drain).
    ctx.embedder = embedder;
    setVecMeta(db, 'model_id', embedder.modelId);
    setVecMeta(db, 'dtype', embedder.dtype);
    setVecMeta(db, 'chunker_version', String(CHUNKER_VERSION));
    let total = 0;
    for (;;) {
      const { processed, remaining, budgetReached } = await runEmbedDrainBatch(db, embedder.embed, {
        limit: 32,
        maxVectorChunks,
      });
      total += processed;
      if (processed > 0) {
        try {
          db.raw.pragma('wal_checkpoint(TRUNCATE)');
        } catch {
          /* best-effort */
        }
      }
      if (budgetReached) {
        log('embeddings: vector budget reached — remaining chunks stay lexical-only');
        break;
      }
      if (processed === 0 || remaining === 0) break;
      await new Promise((r) => setImmediate(r));
    }
    if (total > 0) log(`embeddings: embedded ${total} chunk(s)`);
  } catch (e) {
    log(`embeddings error: ${e instanceof Error ? e.message : String(e)}`);
  }
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
