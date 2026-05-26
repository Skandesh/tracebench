#!/usr/bin/env node
// One-command release:
//   1. Bumps version on every publishable package (core + adapters + tracebench bin)
//   2. Promotes the CHANGELOG's [Unreleased] block to a dated [X.Y.Z] section
//   3. Builds, tests; optionally publishes all 6 packages (or CI on tag)
//   4. Commits, tags v<version>, pushes
//   5. Creates a GitHub release with the new CHANGELOG section as notes
//
// Usage:
//   pnpm release 0.1.3
//   pnpm release patch | minor | major
//   pnpm release patch --skip-publish
//
// Preconditions:
//   - working tree clean
//   - gh CLI authenticated
//   - npm auth only when publishing locally (omit with --skip-publish)
//
// You don't need to remember these — the script checks and fails loud.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(repoRoot, 'CHANGELOG.md');

const PACKAGES = [
  'packages/core/package.json',
  'packages/adapter-claude-code/package.json',
  'packages/adapter-codex/package.json',
  'packages/adapter-cursor/package.json',
  'packages/adapter-opencode/package.json',
  'packages/server/package.json',
];

function sh(cmd, opts = {}) {
  // stdio:'inherit' (the default here) lets the user watch builds/tests/
  // publishes scroll by, but execSync returns null in that mode — so only
  // capture+trim output when the caller asked for silent execution.
  if (opts.silent) {
    return execSync(cmd, { stdio: 'pipe', cwd: repoRoot, encoding: 'utf8' }).toString().trim();
  }
  execSync(cmd, { stdio: 'inherit', cwd: repoRoot });
  return '';
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ── Argument parsing ───────────────────────────────────────────────────────
const cliArgs = process.argv.slice(2);
const skipPublish = cliArgs.includes('--skip-publish');
const arg = cliArgs.find((a) => a !== '--skip-publish');
if (!arg) {
  fail('Usage: pnpm release <version | patch | minor | major> [--skip-publish]');
}

function readPkg(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
}
function writePkg(rel, pkg) {
  writeFileSync(join(repoRoot, rel), JSON.stringify(pkg, null, 2) + '\n');
}

// All packages must currently agree on the version.
const currentVersions = new Set(PACKAGES.map((p) => readPkg(p).version));
if (currentVersions.size !== 1) {
  fail(`Packages disagree on current version: ${[...currentVersions].join(', ')}`);
}
const currentVersion = [...currentVersions][0];

function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`Cannot parse version ${v}`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

let nextVersion;
if (['patch', 'minor', 'major'].includes(arg)) {
  nextVersion = bumpVersion(currentVersion, arg);
} else if (/^\d+\.\d+\.\d+$/.test(arg)) {
  nextVersion = arg;
} else {
  fail(`Invalid version "${arg}". Use semver (e.g. 0.1.3) or patch | minor | major.`);
}
if (nextVersion === currentVersion) fail(`next version equals current (${currentVersion})`);

console.log(`\n→ Releasing ${currentVersion} → ${nextVersion}`);
if (skipPublish) console.log('  publish: skipped\n');
else console.log('');

// ── Working tree check ─────────────────────────────────────────────────────
const status = sh('git status --porcelain', { silent: true });
if (status.trim().length) {
  fail(`Working tree not clean:\n${status}\nCommit or stash first.`);
}
const branch = sh('git rev-parse --abbrev-ref HEAD', { silent: true });
console.log(`  branch: ${branch}`);

// ── CHANGELOG: promote [Unreleased] → [X.Y.Z] — DATE ───────────────────────
let changelog = readFileSync(CHANGELOG, 'utf8');
if (!/##\s+\[Unreleased\]/.test(changelog)) {
  fail('CHANGELOG.md has no [Unreleased] section. Add one above the latest version.');
}
const today = new Date().toISOString().slice(0, 10);
changelog = changelog.replace(
  /##\s+\[Unreleased\]\s*\n/,
  `## [Unreleased]\n\n## [${nextVersion}] — ${today}\n`,
);
writeFileSync(CHANGELOG, changelog);
console.log(`  CHANGELOG promoted [Unreleased] → [${nextVersion}] — ${today}`);

// Pull the new section's notes for the GitHub release body.
function extractSection(version) {
  const re = new RegExp(
    `##\\s+\\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = re.exec(readFileSync(CHANGELOG, 'utf8'));
  return m ? m[1].trim() : '';
}
const releaseNotes = extractSection(nextVersion);
if (!releaseNotes) fail(`Could not extract release notes for ${nextVersion}`);

// ── Bump each package.json ─────────────────────────────────────────────────
for (const rel of PACKAGES) {
  const pkg = readPkg(rel);
  pkg.version = nextVersion;
  writePkg(rel, pkg);
  console.log(`  ${pkg.name}: ${currentVersion} → ${nextVersion}`);
}

// Resync lockfile so workspace:* dep version pins match.
sh('pnpm install --lockfile-only');

// ── Build + test ──────────────────────────────────────────────────────────
console.log('\n→ Building all packages');
sh('pnpm -r build');
console.log('\n→ Running tests');
sh('pnpm -r test');

// ── Publish in dep order (optional; CI handles this when --skip-publish) ───
if (!skipPublish) {
  const publishOrder = [
    'packages/core',
    'packages/adapter-claude-code',
    'packages/adapter-codex',
    'packages/adapter-cursor',
    'packages/adapter-opencode',
    'packages/server', // publishes as `tracebench`
  ];
  for (const dir of publishOrder) {
    console.log(`\n→ Publishing ${dir}`);
    sh(`cd ${dir} && pnpm publish --access public --no-git-checks`);
  }
} else {
  console.log('\n→ Skipping npm publish (CI publishes on tag)');
}

// ── Commit, tag, push ─────────────────────────────────────────────────────
console.log('\n→ Committing release');
sh('git add -A');
sh(`git -c gpg.gpgsign=false commit -m "release: v${nextVersion}"`);
sh(`git tag v${nextVersion} -m "v${nextVersion}"`);
sh('git push');
sh('git push --tags');

// ── GitHub release ────────────────────────────────────────────────────────
console.log('\n→ Creating GitHub release');
const notesFile = join(repoRoot, '.release-notes.tmp.md');
writeFileSync(notesFile, releaseNotes);
try {
  sh(`gh release create v${nextVersion} --title "v${nextVersion}" --notes-file "${notesFile}"`);
} finally {
  try { execSync(`rm -f ${notesFile}`); } catch { /* ignore */ }
}

console.log(`\n✓ Released v${nextVersion}`);
