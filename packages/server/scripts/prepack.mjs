#!/usr/bin/env node
// prepack: build all workspace deps + copy the UI's built assets into this
// package so the published tarball is fully self-contained.
//
// pnpm runs this automatically before `pnpm publish` / `pnpm pack` for the
// containing package.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');

function run(cmd, cwd = repoRoot) {
  console.log(`[prepack] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

// 1. Ensure all workspace packages are built (core, adapters, ui, server)
run('pnpm -r build');

// 2. Copy the UI bundle into this package as `ui/`. The server resolves the
//    UI dir by walking up from dist/server.js, so we just need it adjacent.
const uiDist = join(repoRoot, 'packages', 'ui', 'dist');
const uiTarget = join(pkgRoot, 'ui');

if (!existsSync(join(uiDist, 'index.html'))) {
  console.error('[prepack] UI dist not found at', uiDist);
  process.exit(1);
}

if (existsSync(uiTarget)) rmSync(uiTarget, { recursive: true, force: true });
mkdirSync(uiTarget, { recursive: true });
cpSync(uiDist, uiTarget, { recursive: true });
console.log('[prepack] copied UI dist →', uiTarget);

// 3. Copy the repo README, LICENSE, and CHANGELOG into this package so the
//    npm page renders correctly and the [CHANGELOG.md] link in the README
//    resolves inside the tarball as well.
for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
  const src = join(repoRoot, name);
  if (existsSync(src)) {
    cpSync(src, join(pkgRoot, name));
    console.log(`[prepack] copied ${name}`);
  }
}

// 4. Sanity check: ensure dist/cli.js exists
if (!existsSync(join(pkgRoot, 'dist', 'cli.js'))) {
  console.error('[prepack] dist/cli.js missing — server build failed');
  process.exit(1);
}

console.log('[prepack] ready to pack');
