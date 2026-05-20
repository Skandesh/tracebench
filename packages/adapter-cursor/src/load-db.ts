import { loadComposerFromDb } from './db-read.js';
import { parseComposerDbUri } from './db-uri.js';
import { normalizeComposerSession } from './normalize-db.js';
import type { NormalizeResult } from './normalize.js';

export async function loadComposerSession(
  rawPath: string,
  opts: { formatVersion?: string } = {},
): Promise<NormalizeResult> {
  const parsed = parseComposerDbUri(rawPath);
  if (!parsed) {
    throw new Error(`not a composer DB path: ${rawPath}`);
  }

  const loaded = loadComposerFromDb(parsed.globalDbPath, parsed.composerId);
  if (!loaded) {
    throw new Error(`composer not found in DB: ${parsed.composerId}`);
  }

  return normalizeComposerSession(loaded, {
    rawPath,
    globalDbPath: parsed.globalDbPath,
    formatVersion: opts.formatVersion,
  });
}
