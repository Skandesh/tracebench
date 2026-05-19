// Cursor on-disk path helpers (JSONL roots + future Composer SQLite locations).

import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultCursorProjectsRoot(): string {
  return join(homedir(), '.cursor', 'projects');
}

/** VS Code–style Cursor `User/` data directory (global + workspace DBs). */
export function defaultCursorUserDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User');
    case 'win32': {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      return join(appData, 'Cursor', 'User');
    }
    default:
      return join(home, '.config', 'Cursor', 'User');
  }
}

/** Global Composer DB — Phase 2 reads this (not used by JSONL adapter yet). */
export function defaultCursorGlobalDbPath(): string {
  return join(defaultCursorUserDataDir(), 'globalStorage', 'state.vscdb');
}

/**
 * Decode sanitized project dir name back to an absolute path (best-effort).
 * Cursor encodes `/Users/me/proj` → `Users-me-proj` (leading slash stripped).
 */
export function decodeProjectPath(encoded: string): string {
  if (encoded.startsWith('Users-')) {
    return '/Users/' + encoded.slice('Users-'.length).replace(/-/g, '/');
  }
  if (encoded.startsWith('home-')) {
    return '/' + encoded.replace(/-/g, '/');
  }
  if (/^[A-Za-z]-/.test(encoded)) {
    const drive = encoded[0]!.toUpperCase();
    return drive + ':\\' + encoded.slice(2).replace(/-/g, '\\');
  }
  return encoded;
}
