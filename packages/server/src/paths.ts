// Where Tracebench keeps its local SQLite DB.
//
// Default: ~/.tracebench/tracebench.db
// Overridable via --db-path on the CLI.

import { join } from 'node:path';
import { homedir } from 'node:os';

export function defaultDbPath(): string {
  return join(homedir(), '.tracebench', 'tracebench.db');
}
