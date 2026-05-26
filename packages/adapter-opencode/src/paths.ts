// OpenCode on-disk path helpers.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory containing `opencode.db` (XDG data home / platform fallback). */
export function defaultOpencodeRoot(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32': {
      const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return join(local, 'opencode');
    }
    default: {
      const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
      return join(xdg, 'opencode');
    }
  }
}

export function defaultOpencodeDbPath(): string {
  return join(defaultOpencodeRoot(), 'opencode.db');
}
