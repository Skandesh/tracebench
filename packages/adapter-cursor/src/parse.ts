// Stream a Cursor agent-transcript JSONL file line by line.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type RawCursorEvent = Record<string, unknown> & {
  role?: string;
  message?: unknown;
};

export async function* streamSession(
  filePath: string,
): AsyncIterable<RawCursorEvent> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RawCursorEvent;
    } catch {
      continue;
    }
  }
}

export async function parseSession(filePath: string): Promise<RawCursorEvent[]> {
  const out: RawCursorEvent[] = [];
  for await (const ev of streamSession(filePath)) out.push(ev);
  return out;
}
