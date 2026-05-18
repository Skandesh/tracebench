// Discover Claude Code sessions on disk.
//
// Layout: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// The encoded-cwd is the project's cwd with '/' → '-' and a leading '-' (since
// absolute paths start with '/'). We don't decode it back into a real path —
// every event in the file carries its own `cwd`, which is the authoritative
// source. The dir name is just a useful grouping hint.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';

export interface DiscoveredSession {
  /** Session uuid, taken from the filename. */
  session_id: string;
  /** Absolute path to the .jsonl file. */
  file_path: string;
  /** Encoded project dir name (the parent dir of the jsonl). Hint only. */
  encoded_project_dir: string;
  /** Bytes. */
  size: number;
  /** File mtime in ms since epoch — used for incremental re-index. */
  mtime_ms: number;
}

export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Synchronously walk the projects root and return every JSONL we find. Used
 * for the v0.1 startup indexer. Errors on individual files are swallowed —
 * a single corrupted/permission-denied entry shouldn't break the whole scan.
 */
export function discoverSessions(root?: string): DiscoveredSession[] {
  const base = root ?? defaultProjectsRoot();
  const out: DiscoveredSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // root doesn't exist — fine
  }
  for (const dir of projectDirs) {
    const dirPath = join(base, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, f);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      out.push({
        session_id: f.replace(/\.jsonl$/, ''),
        file_path: filePath,
        encoded_project_dir: dir,
        size: st.size,
        mtime_ms: st.mtimeMs,
      });
    }
  }
  // Newest first — matches the UI's default ordering.
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}

/** Async variant used by the server's incremental indexer. */
export async function discoverSessionsAsync(
  root?: string,
): Promise<DiscoveredSession[]> {
  // Trivial async wrapper; could be made truly streaming if needed later.
  return new Promise((resolve) => resolve(discoverSessions(root)));
}

/** Read a session's mtime without listing the directory. */
export async function statSession(filePath: string): Promise<{ size: number; mtime_ms: number } | null> {
  try {
    const s = await fs.stat(filePath);
    return { size: s.size, mtime_ms: s.mtimeMs };
  } catch {
    return null;
  }
}
