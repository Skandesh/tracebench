// Discover Codex CLI sessions on disk.
//
// Layout:
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
//   ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl     (flat)
//
// We walk both, recursively. Each rollout filename embeds the session uuid
// after the last `-`.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredCodexSession {
  /** Session UUID extracted from the filename. */
  session_id: string;
  /** Absolute path to the rollout JSONL. */
  file_path: string;
  /** Bytes. */
  size: number;
  /** mtime ms — used for incremental re-index. */
  mtime_ms: number;
  /** "live" | "archived" — informational only. */
  bucket: 'live' | 'archived';
}

export function defaultCodexRoot(): string {
  return join(homedir(), '.codex');
}

const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function extractSessionId(filename: string): string | null {
  const m = ROLLOUT_RE.exec(filename);
  return m ? m[1]! : null;
}

function walkRollouts(root: string, bucket: 'live' | 'archived', out: DiscoveredCodexSession[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkRollouts(p, bucket, out);
      continue;
    }
    if (!name.endsWith('.jsonl')) continue;
    const sid = extractSessionId(name);
    if (!sid) continue;
    out.push({
      session_id: sid,
      file_path: p,
      size: st.size,
      mtime_ms: st.mtimeMs,
      bucket,
    });
  }
}

/**
 * Synchronously walk Codex's rollout dirs. Newest-first ordering matches
 * Tracebench's UI default.
 */
export function discoverSessions(root?: string): DiscoveredCodexSession[] {
  const base = root ?? defaultCodexRoot();
  const out: DiscoveredCodexSession[] = [];
  walkRollouts(join(base, 'sessions'), 'live', out);
  walkRollouts(join(base, 'archived_sessions'), 'archived', out);
  // Dedup by session_id (live wins over archived if both exist)
  const seen = new Map<string, DiscoveredCodexSession>();
  for (const s of out) {
    const prev = seen.get(s.session_id);
    if (!prev || (prev.bucket === 'archived' && s.bucket === 'live')) {
      seen.set(s.session_id, s);
    }
  }
  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return deduped;
}
