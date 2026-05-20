import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMinimalCursorDb } from './db-fixture.js';
import { listComposersWithBubbles, loadComposerFromDb } from './db-read.js';
import { discoverComposerSessions } from './discover-db.js';
import { composerDbUri } from './db-uri.js';
import { loadComposerSession } from './load-db.js';
import { discoverSessions } from './discover.js';

const COMPOSER_ID = 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let dbPath: string;
let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tb-cursor-db-fixture-'));
  dbPath = join(tempDir, 'state.vscdb');
  createMinimalCursorDb(dbPath);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Composer DB reader', () => {
  it('lists composers with bubbles', () => {
    const list = listComposersWithBubbles(dbPath);
    expect(list.length).toBe(1);
    expect(list[0]!.composerId).toBe(COMPOSER_ID);
    expect(list[0]!.bubbleCount).toBe(3);
    expect(list[0]!.projectPath).toBe('/Users/me/code/fixture');
  });

  it('loads ordered bubbles from fullConversationHeadersOnly', () => {
    const loaded = loadComposerFromDb(dbPath, COMPOSER_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.bubbles.length).toBe(3);
    expect(loaded!.bubbles[0]!.type).toBe(1);
    expect(loaded!.bubbles[1]!.capabilityType).toBe(30);
    expect(loaded!.bubbles[2]!.toolFormerData?.toolCallId).toBe('tool_fixture_call_001');
  });
});

describe('normalize Composer DB session', () => {
  it('emits tool_call + tool_result with stable call id', async () => {
    const uri = composerDbUri(COMPOSER_ID, dbPath);
    const { session, events } = await loadComposerSession(uri);
    expect(session.harness).toBe('cursor');
    expect(session.session_id).toBe(COMPOSER_ID);
    expect(session.model).toBe('composer-2.5');
    expect(session.title).toMatch(/Summarize the fixture/);

    const toolCall = events.find((e) => e.event_type === 'tool_call');
    const toolResult = events.find((e) => e.event_type === 'tool_result');
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolCall!.event_id).toBe('tool_fixture_call_001');
    expect(toolResult!.parent_event_id).toBe('tool_fixture_call_001');
    expect(toolCall!.tool.name).toBe('Read');
    expect(toolResult!.tool.output).toContain('Fixture');
  });

  it('emits thinking events from capabilityType 30 bubbles', async () => {
    const { events } = await loadComposerSession(composerDbUri(COMPOSER_ID, dbPath));
    expect(events.some((e) => e.event_type === 'thinking')).toBe(true);
  });
});

describe('discover merge', () => {
  it('prefers DB session over JSONL with same composer id', () => {
    const merged = discoverSessions({
      projectsRoot: join(tempDir, 'empty-projects'),
      globalDbPath: dbPath,
    });
    const match = merged.find((s) => s.session_id === COMPOSER_ID);
    expect(match).toBeDefined();
    expect(match!.source).toBe('composer_db');
    expect(match!.file_path).toContain('cursor-db:');
  });

  it('discovers composer sessions via discoverComposerSessions', () => {
    const dbOnly = discoverComposerSessions(dbPath);
    expect(dbOnly.length).toBe(1);
    expect(dbOnly[0]!.session_id).toBe(COMPOSER_ID);
  });
});
