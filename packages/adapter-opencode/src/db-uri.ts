// Virtual paths for OpenCode DB sessions (indexed by tracebench as raw_path).

const PREFIX = 'opencode-db:';

export function opencodeDbUri(sessionId: string, dbPath: string): string {
  return `${PREFIX}${sessionId}@${dbPath}`;
}

export function parseOpencodeDbUri(
  rawPath: string,
): { sessionId: string; dbPath: string } | null {
  if (!rawPath.startsWith(PREFIX)) return null;
  const rest = rawPath.slice(PREFIX.length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) return null;
  return {
    sessionId: rest.slice(0, at),
    dbPath: rest.slice(at + 1),
  };
}

export function isOpencodeDbUri(rawPath: string): boolean {
  return rawPath.startsWith(PREFIX);
}
