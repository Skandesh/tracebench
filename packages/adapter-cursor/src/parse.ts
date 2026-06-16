// Stream a Cursor agent-transcript JSONL file line by line.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type RawCursorEvent = Record<string, unknown> & {
  role?: string;
  message?: unknown;
};

export interface RawCursorRecord {
  raw: RawCursorEvent;
  line: number;
}

export async function* streamSession(
  filePath: string,
): AsyncIterable<RawCursorEvent> {
  for await (const record of streamSessionRecords(filePath)) {
    yield record.raw;
  }
}

export async function* streamSessionRecords(
  filePath: string,
): AsyncIterable<RawCursorRecord> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield { raw: JSON.parse(line) as RawCursorEvent, line: lineNo };
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
