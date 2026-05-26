// Discover OpenCode sessions from opencode.db.

import { join } from 'node:path';
import { defaultOpencodeDbPath, defaultOpencodeRoot } from './paths.js';
import { listSessions, opencodeDbMtimeMs } from './db-read.js';
import { opencodeDbUri } from './db-uri.js';

export interface DiscoveredOpencodeSession {
  session_id: string;
  file_path: string;
  mtime_ms: number;
  size: number;
}

export function discoverSessions(root?: string): DiscoveredOpencodeSession[] {
  const base = root ?? defaultOpencodeRoot();
  const dbPath = join(base, 'opencode.db');
  const dbMtime = opencodeDbMtimeMs(dbPath);

  let sessions;
  try {
    sessions = listSessions(dbPath);
  } catch {
    return [];
  }

  return sessions.map((s) => ({
    session_id: s.sessionId,
    file_path: opencodeDbUri(s.sessionId, dbPath),
    mtime_ms: s.timeUpdated || dbMtime,
    size: s.messageCount,
  }));
}

export { defaultOpencodeRoot, defaultOpencodeDbPath };
