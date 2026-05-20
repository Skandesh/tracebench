// Discover Cursor Composer sessions from global state.vscdb.

import { defaultCursorGlobalDbPath } from './paths.js';
import { listComposersWithBubbles, cursorDbMtimeMs } from './db-read.js';
import { composerDbUri } from './db-uri.js';

export interface DiscoveredComposerSession {
  session_id: string;
  file_path: string;
  global_db_path: string;
  project_path: string | null;
  name: string | null;
  size: number;
  mtime_ms: number;
}

export function discoverComposerSessions(
  globalDbPath?: string,
): DiscoveredComposerSession[] {
  const dbPath = globalDbPath ?? defaultCursorGlobalDbPath();
  const dbMtime = cursorDbMtimeMs(dbPath);
  const composers = listComposersWithBubbles(dbPath);

  return composers.map((c) => ({
    session_id: c.composerId,
    file_path: composerDbUri(c.composerId, dbPath),
    global_db_path: dbPath,
    project_path: c.projectPath,
    name: c.name,
    size: c.bubbleCount,
    mtime_ms: c.lastUpdatedAtMs ?? dbMtime,
  }));
}
