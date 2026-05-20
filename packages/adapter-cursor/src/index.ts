export const HARNESS_NAME = 'cursor' as const;
/** JSONL agent-transcript format version. */
export const FORMAT_VERSION = '2026-q1';
/** Composer SQLite (state.vscdb) format version. */
export const FORMAT_VERSION_COMPOSER = '2026-q1-composer';

export {
  defaultCursorProjectsRoot,
  defaultCursorUserDataDir,
  defaultCursorGlobalDbPath,
  decodeProjectPath,
} from './paths.js';
export {
  defaultProjectsRoot,
  discoverSessions,
  type DiscoveredCursorSession,
  type DiscoverSessionsOptions,
} from './discover.js';
export { discoverComposerSessions, type DiscoveredComposerSession } from './discover-db.js';
export { parseSession, streamSession, type RawCursorEvent } from './parse.js';
export {
  loadSession,
  normalizeSession,
  parseTranscriptPath,
  type NormalizeResult,
} from './normalize.js';
export { loadComposerSession } from './load-db.js';
export { normalizeComposerSession, FORMAT_VERSION_DB } from './normalize-db.js';
export { composerDbUri, parseComposerDbUri, isComposerDbUri } from './db-uri.js';
