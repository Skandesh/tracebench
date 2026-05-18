// Stream a Codex rollout JSONL file line by line. Same shape as the Claude
// Code parser — no schema validation, no state, no normalization.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type RawCodexEvent = Record<string, unknown> & {
  timestamp?: string;
  type?: string;
  payload?: unknown;
};

export async function* streamSession(filePath: string): AsyncIterable<RawCodexEvent> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawCodexEvent;
    } catch {
      continue;
    }
  }
}

export async function parseSession(filePath: string): Promise<RawCodexEvent[]> {
  const out: RawCodexEvent[] = [];
  for await (const ev of streamSession(filePath)) out.push(ev);
  return out;
}
