export * from './discover.js';
export * from './parse.js';
export * from './normalize.js';

export const HARNESS_NAME = 'claude_code' as const;
/** Bumped when the upstream Claude Code format changes in an incompatible way. */
export const FORMAT_VERSION = '2025-q2';
