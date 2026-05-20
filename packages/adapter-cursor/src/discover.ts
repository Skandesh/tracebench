// Discover Cursor agent transcripts on disk.
//
// Layout:
//   ~/.cursor/projects/<sanitized-path>/agent-transcripts/
//     <session-uuid>.jsonl                         (flat)
//     <session-uuid>/<session-uuid>.jsonl          (nested)
//     <parent-uuid>/subagents/<subagent-uuid>.jsonl

import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { defaultCursorProjectsRoot } from './paths.js';
import { discoverComposerSessions } from './discover-db.js';

export interface DiscoveredCursorSession {
  session_id: string;
  file_path: string;
  encoded_project_dir: string;
  size: number;
  mtime_ms: number;
  /** Present when loaded from Composer SQLite instead of JSONL. */
  source?: 'jsonl' | 'composer_db';
}

export { defaultCursorProjectsRoot as defaultProjectsRoot };

function walkJsonl(
  dir: string,
  encodedProjectDir: string,
  out: DiscoveredCursorSession[],
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = String(ent.name);
    const p = join(dir, name);
    if (ent.isDirectory()) {
      walkJsonl(p, encodedProjectDir, out);
      continue;
    }
    if (!name.endsWith('.jsonl')) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const sessionId = basename(name, '.jsonl');
    out.push({
      session_id: sessionId,
      file_path: p,
      encoded_project_dir: encodedProjectDir,
      size: st.size,
      mtime_ms: st.mtimeMs,
    });
  }
}

export interface DiscoverSessionsOptions {
  /** Override ~/.cursor/projects */
  projectsRoot?: string;
  /** Override global state.vscdb path; set to false to skip DB discovery. */
  globalDbPath?: string | false;
}

function discoverJsonlSessions(base: string): DiscoveredCursorSession[] {
  const out: DiscoveredCursorSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const transcriptsDir = join(base, dir, 'agent-transcripts');
    walkJsonl(transcriptsDir, dir, out);
  }
  for (const s of out) s.source = 'jsonl';
  return out;
}

/**
 * Discover agent-transcript JSONL sessions and Composer DB sessions.
 * When the same composerId exists in both, the DB entry wins (richer events).
 */
export function discoverSessions(
  rootOrOpts?: string | DiscoverSessionsOptions,
): DiscoveredCursorSession[] {
  const opts: DiscoverSessionsOptions =
    typeof rootOrOpts === 'string' ? { projectsRoot: rootOrOpts } : (rootOrOpts ?? {});

  const base = opts.projectsRoot ?? defaultCursorProjectsRoot();
  const jsonl = discoverJsonlSessions(base);

  if (opts.globalDbPath === false) {
    jsonl.sort((a, b) => b.mtime_ms - a.mtime_ms);
    return jsonl;
  }

  let dbSessions: DiscoveredCursorSession[] = [];
  try {
    dbSessions = discoverComposerSessions(
      opts.globalDbPath === undefined ? undefined : opts.globalDbPath,
    ).map((d) => ({
      session_id: d.session_id,
      file_path: d.file_path,
      encoded_project_dir: '',
      size: d.size,
      mtime_ms: d.mtime_ms,
      source: 'composer_db' as const,
    }));
  } catch {
    dbSessions = [];
  }

  const dbIds = new Set(dbSessions.map((s) => s.session_id));
  const merged = [
    ...dbSessions,
    ...jsonl.filter((s) => !dbIds.has(s.session_id)),
  ];
  merged.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return merged;
}
