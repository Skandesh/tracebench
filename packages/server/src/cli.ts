#!/usr/bin/env node
// `npx tracebench` entry. Parses a small set of flags and starts the server.
//
// Flags (all optional):
//   --port <n>          default 3478
//   --host <h>          default 127.0.0.1
//   --dir <path>        override Claude Code projects dir
//   --db-path <path>    override SQLite location
//   --no-open           don't auto-open the browser
//   --no-index          skip startup index
//   --verbose / -v      verbose logging

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

interface CliArgs {
  port: number;
  host: string;
  dir?: string;
  codexDir?: string;
  cursorDir?: string;
  opencodeDir?: string;
  cursorUserDataDir?: string;
  dbPath?: string;
  open: boolean;
  index: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    port: 3478,
    host: '127.0.0.1',
    open: true,
    index: true,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v == null) throw new Error(`${flag} requires a value`);
      return v;
    };
    switch (flag) {
      case '--port': a.port = Number(next()); break;
      case '--host': a.host = next(); break;
      case '--dir':
      case '--claude-dir': a.dir = next(); break;
      case '--codex-dir': a.codexDir = next(); break;
      case '--cursor-dir': a.cursorDir = next(); break;
      case '--opencode-dir': a.opencodeDir = next(); break;
      case '--cursor-user-data-dir': a.cursorUserDataDir = next(); break;
      case '--db-path': a.dbPath = next(); break;
      case '--no-open': a.open = false; break;
      case '--no-index': a.index = false; break;
      case '--verbose':
      case '-v': a.verbose = true; break;
      case '--help':
      case '-h': a.help = true; break;
      default:
        if (flag.startsWith('-')) {
          process.stderr.write(`unknown flag: ${flag}\n`);
          a.help = true;
        }
    }
  }
  return a;
}

function printHelp(): void {
  process.stdout.write(`
tracebench — local viewer for AI coding agent sessions

Usage: tracebench [flags]

  --port <n>          listen port (default 3478)
  --host <h>          listen host (default 127.0.0.1)
  --dir <path>        Claude Code projects dir (default ~/.claude/projects)
                      alias: --claude-dir
  --codex-dir <path>  Codex sessions dir (default ~/.codex)
  --cursor-dir <path>        Cursor projects dir (default ~/.cursor/projects)
  --opencode-dir <path>      OpenCode data dir (default ~/.local/share/opencode)
  --cursor-user-data-dir <path>  Cursor User dir for Composer DB (default OS-specific)
  --db-path <path>    SQLite file (default ~/.tracebench/tracebench.db)
  --no-open           don't auto-open the browser
  --no-index          skip startup index pass
  -v, --verbose       verbose logging
  -h, --help          this help

Once running, the UI is at http://localhost:<port>
`);
}

const MAX_PORT_ATTEMPTS = 100;

async function listenOnAvailablePort(
  app: FastifyInstance,
  host: string,
  startPort: number,
): Promise<number> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = startPort + i;
    try {
      await app.listen({ port, host });
      return port;
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(
    `no available port found in range ${startPort}–${startPort + MAX_PORT_ATTEMPTS - 1}`,
  );
}

function openInBrowser(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? 'open'
      : platform() === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args =
    platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Don't fail the server start if opening the browser fails.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const { app } = await buildServer({
    dbPath: args.dbPath,
    projectsRoot: args.dir,
    codexRoot: args.codexDir,
    cursorRoot: args.cursorDir,
    opencodeRoot: args.opencodeDir,
    cursorUserDataDir: args.cursorUserDataDir,
    noIndex: !args.index,
    verbose: args.verbose,
  });

  let port: number;
  try {
    port = await listenOnAvailablePort(app, args.host, args.port);
  } catch (err) {
    await app.close();
    throw err;
  }

  const url = `http://${args.host}:${port}`;
  if (port !== args.port) {
    process.stdout.write(`\nport ${args.port} in use, using ${port} instead\n`);
  }
  process.stdout.write(`\ntracebench listening on ${url}\n`);
  if (args.open) openInBrowser(url);

  const shutdown = async () => {
    process.stdout.write('\nshutting down…\n');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`tracebench failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
