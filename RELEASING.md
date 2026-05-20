# Releasing

Maintainer-only. Users don't need this — see [README.md](./README.md) instead.

## Overview

```
CHANGELOG [Unreleased]  →  pnpm release patch --skip-publish  →  tag vX.Y.Z on main
                                                              ↓
                                              GitHub Actions (release.yml)
                                                              ↓
                                              npm: all 5 packages @ X.Y.Z
```

Local machine: changelog, version bump, build, test, git tag, GitHub release notes.  
CI: npm publish for `tracebench` + four `@tracebench/*` packages (OIDC, no token or passkey).

## TL;DR

```bash
# 1. Edit [Unreleased] in CHANGELOG.md
# 2. Ship:
pnpm release patch --skip-publish
# 3. Confirm Actions workflow succeeded; npm shows the new version
```

Also: `pnpm release minor --skip-publish`, `pnpm release major --skip-publish`, or `pnpm release 0.3.0 --skip-publish`.

Legacy local publish (passkey or npm token): omit `--skip-publish`.

## One-time setup

1. **`gh` CLI** — `gh auth status` must work for this repo.
2. **Trusted Publisher** (npm → each package → Settings → Trusted Publisher → GitHub Actions):
   - `tracebench`
   - `@tracebench/core`
   - `@tracebench/adapter-claude-code`
   - `@tracebench/adapter-codex`
   - `@tracebench/adapter-cursor`

   Use the same values for all five:

   | Field | Value |
   |--------|--------|
   | Repository | `Skandesh/tracebench` |
   | Workflow filename | `release.yml` |
   | Environment | *(empty)* |

3. **Workflow on `main`** — [`.github/workflows/release.yml`](./.github/workflows/release.yml) must exist before Trusted Publisher is saved.

Scoped packages live under the **tracebench** org on npm, not on your personal package list.

## Workflow

### 1. As you work — edit `[Unreleased]` in `CHANGELOG.md`

Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories: Added, Changed, Deprecated, Removed, Fixed, Security.

```md
## [Unreleased]

### Added
- OpenCode adapter (#42)
```

### 2. Ship

Working tree must be clean:

```bash
pnpm release patch --skip-publish
```

The script (`scripts/release.mjs`):

1. Checks the working tree is clean.
2. Promotes `## [Unreleased]` → `## [X.Y.Z] — YYYY-MM-DD` (empty `[Unreleased]` left at top).
3. Bumps version on all five publishable packages.
4. `pnpm install --lockfile-only`
5. `pnpm -r build && pnpm -r test` (aborts on failure)
6. Skips `pnpm publish` when `--skip-publish` is set
7. `git commit -m "release: vX.Y.Z"`, `git tag vX.Y.Z`, push commit + tags
8. `gh release create` with the new changelog section as the body

### 3. Verify CI publish

Open **Actions → Release** for the `vX.Y.Z` run. On success, all five packages show the new version on npm:

```bash
npm view tracebench version
npm view @tracebench/core version
```

The `tracebench` tarball is built in CI via each package's `prepack` (UI bundle, README, CHANGELOG).

## Versioning

[SemVer](https://semver.org/):

- **MAJOR** — breaking schema, `/api/*`, or `@tracebench/core` exports (stay on `0.x` until v1).
- **MINOR** — features, new adapters (backwards-compatible).
- **PATCH** — fixes, perf, docs, internal refactors.

All five publishable packages share one version. `tracebench` pins exact versions of the scoped deps — ship together.

## What the npm page shows

The npm page uses `README.md` from the published `tracebench` tarball (`prepack` copies the repo README). Bump and release to update it.

## Anti-patterns

- Don't bump versions by hand.
- Don't publish individual packages out of band.
- Don't put release notes only in git commit messages — the script reads `CHANGELOG.md` only.
- Don't republish the same version — bump to the next patch.

## Emergency recovery

**Script failed before push** (changelog promoted locally, tag not pushed):

```bash
git checkout -- .
git clean -fd
pnpm install
pnpm release patch --skip-publish
```

**Tag pushed but CI publish failed** (or only some packages on npm):

1. Fix the workflow or Trusted Publisher config.
2. Bump to the next patch and release again — npm versions are immutable.

**Published locally by mistake without `--skip-publish`:** fine if all five succeeded; otherwise bump and let CI publish on the next tag.
