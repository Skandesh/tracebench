// Virtual paths for Composer DB sessions (indexed by tracebench as raw_path).

const PREFIX = 'cursor-db:';

/** Stable raw_path for a Composer session loaded from SQLite. */
export function composerDbUri(composerId: string, globalDbPath: string): string {
  return `${PREFIX}${composerId}@${globalDbPath}`;
}

export function parseComposerDbUri(
  rawPath: string,
): { composerId: string; globalDbPath: string } | null {
  if (!rawPath.startsWith(PREFIX)) return null;
  const rest = rawPath.slice(PREFIX.length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) return null;
  return {
    composerId: rest.slice(0, at),
    globalDbPath: rest.slice(at + 1),
  };
}

export function isComposerDbUri(rawPath: string): boolean {
  return rawPath.startsWith(PREFIX);
}
