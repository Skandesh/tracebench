export const HARNESS_NAME = 'cursor' as const;
export const FORMAT_VERSION = '2026-q1';

export {
  defaultCursorProjectsRoot,
  defaultCursorUserDataDir,
  defaultCursorGlobalDbPath,
  decodeProjectPath,
} from './paths.js';
export { defaultProjectsRoot, discoverSessions, type DiscoveredCursorSession } from './discover.js';
export { parseSession, streamSession, type RawCursorEvent } from './parse.js';
export {
  loadSession,
  normalizeSession,
  parseTranscriptPath,
  type NormalizeResult,
} from './normalize.js';
