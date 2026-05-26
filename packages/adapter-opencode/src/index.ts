export const HARNESS_NAME = 'opencode' as const;
export { FORMAT_VERSION } from './normalize.js';

export { defaultOpencodeRoot, defaultOpencodeDbPath } from './paths.js';
export {
  discoverSessions,
  type DiscoveredOpencodeSession,
} from './discover.js';
export { loadSession, normalizeSession, type NormalizeResult } from './normalize.js';
export { opencodeDbUri, parseOpencodeDbUri, isOpencodeDbUri } from './db-uri.js';
export { beginOpencodeDbBatch, endOpencodeDbBatch } from './db-snapshot.js';
