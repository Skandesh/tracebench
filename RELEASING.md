# Releasing

Maintainer-only. Users don't need this — see [README.md](./README.md) instead.

`pnpm release <version>` ships a new version of tracebench end-to-end. It bumps all four packages atomically, promotes the changelog, publishes to npm, commits, tags, pushes, and creates a GitHub release.

## TL;DR

```bash
pnpm release 0.1.4         # exact version
# or
pnpm release patch         # auto-bump
pnpm release minor
pnpm release major
```

That's it. Read on for the rest.

## Workflow

### 1. As you work — edit `[Unreleased]` in `CHANGELOG.md`

Every PR / commit that's worth a user-facing line goes under the `[Unreleased]` section at the top of `CHANGELOG.md`. Use the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories:

- `### Added` — new features
- `### Changed` — behavior changes
- `### Deprecated` — soon-to-be-removed APIs
- `### Removed` — gone-now APIs
- `### Fixed` — bug fixes
- `### Security` — security-relevant fixes

Example entry:
```md
## [Unreleased]

### Added
- OpenCode adapter (#42)

### Fixed
- Codex session_meta with missing `cwd` no longer crashes the indexer (#48)
```

### 2. When you're ready to ship

Make sure your working tree is clean (the script refuses to release with uncommitted changes), then:

```bash
pnpm release 0.1.4
```

The script will:

1. Check the working tree is clean.
2. Promote `## [Unreleased]` → `## [0.1.4] — 2026-MM-DD` in `CHANGELOG.md`. A fresh empty `[Unreleased]` is left at the top for next time.
3. Bump the version on every package — `@tracebench/core`, `@tracebench/adapter-claude-code`, `@tracebench/adapter-codex`, and `tracebench` — keeping them locked together.
4. Run `pnpm install --lockfile-only` to keep the `workspace:*` resolutions consistent.
5. `pnpm -r build && pnpm -r test`. Aborts on failure.
6. `pnpm publish --access public --no-git-checks` for each package in dependency order: core → adapter-claude-code → adapter-codex → tracebench. The `tracebench` package's `prepack` script bundles the UI dist, README, LICENSE, and CHANGELOG into the tarball.
7. `git commit -m "release: v0.1.4"`, `git tag v0.1.4`, push commit + tag.
8. `gh release create v0.1.4 --notes-file …` using the new `[0.1.4]` section as the release body.

If anything fails partway through, the script exits and prints the failing command — you can fix and re-run. Versions are only "real" once npm has accepted them, so a half-ran release usually just means `git checkout -- .` and try again.

## Prerequisites

The script assumes you have these set up once on your machine:

- **`gh` CLI** authenticated against the `Skandesh/tracebench` repo (`gh auth status` to check).
- **`npm` auth** for the `tracebench` package and the `@tracebench` scope. A granular token with "bypass 2FA when publishing" stored in `~/.npmrc` is the easiest setup:
  ```
  //registry.npmjs.org/:_authToken=npm_XXXXXXXXXXXXXXXXXXXXXXXXX
  ```
  Create one at https://www.npmjs.com/settings/<you>/tokens/granular-access-tokens/new with read+write on "Applies to current and future packages" and "Bypass 2FA when publishing" checked.

## Versioning

We follow [SemVer](https://semver.org/):

- **MAJOR** — breaking changes to the canonical event schema or the `/api/*` shape, or to the public exports of `@tracebench/core`. Locked at `0.x` for now — bump only when we declare v1.
- **MINOR** — new features, new adapters, or any user-visible additions. Backwards-compatible.
- **PATCH** — bug fixes, perf wins, docs, internal refactors.

All four packages share the same version. Don't try to publish them on separate cadences — the `tracebench` bin depends on exact versions of the scoped packages, so they ship as a quartet.

## What the npm page shows

The npm page renders whatever `README.md` is inside the most recently published tarball. The repo `README.md` is copied in by the `prepack` script — so to update the npm page, you publish a new version. There's no "amend" on npm; bump and re-release.

## Anti-patterns

- **Don't bump versions by hand** — the script keeps them consistent. Manual edits drift.
- **Don't publish individual packages out of band** — they need to ship together because `tracebench` pins exact versions of its scoped deps.
- **Don't write changelog entries in commit messages and skip `CHANGELOG.md`** — the script reads only from `CHANGELOG.md` to build release notes.
- **Don't republish a version after a bug is found** — npm reserves the number for 24 hours and won't let you. Bump to the next patch.

## Emergency recovery

If a publish fails partway and you end up with some packages on npm but not others, the simplest fix is to bump again. npm versions are immutable; you can't fix them in place.

If the script crashed AFTER promoting the changelog but BEFORE pushing, revert the local mutations and start over:

```bash
git checkout -- .
git clean -fd
pnpm install
pnpm release 0.1.4    # try again
```
