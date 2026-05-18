// Stream a Claude Code JSONL file line by line. Yields raw event objects;
// normalization is a separate pass (normalize.ts).
//
// We keep this dumb on purpose: no schema validation, no normalization, no
// state. That makes the parser cheap to reason about and lets normalize.ts
// own the format quirks.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type RawClaudeCodeEvent = Record<string, unknown> & {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  message?: unknown;
};

export async function* streamSession(
  filePath: string,
): AsyncIterable<RawClaudeCodeEvent> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawClaudeCodeEvent;
    } catch {
      // Skip malformed lines silently. Real sessions occasionally have a
      // truncated trailing line if the harness was killed mid-write.
      continue;
    }
  }
}

/** Collect every event into memory. Convenient for tests and small files. */
export async function parseSession(
  filePath: string,
): Promise<RawClaudeCodeEvent[]> {
  const out: RawClaudeCodeEvent[] = [];
  for await (const ev of streamSession(filePath)) out.push(ev);
  return out;
}
