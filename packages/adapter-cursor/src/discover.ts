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

export interface DiscoveredCursorSession {
  session_id: string;
  file_path: string;
  encoded_project_dir: string;
  size: number;
  mtime_ms: number;
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

export function discoverSessions(root?: string): DiscoveredCursorSession[] {
  const base = root ?? defaultCursorProjectsRoot();
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
  out.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return out;
}
