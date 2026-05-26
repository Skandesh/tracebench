import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMinimalOpencodeDb } from './db-fixture.js';
import { discoverSessions } from './discover.js';
import { loadSession } from './normalize.js';

describe('OpenCode adapter', () => {
  let root: string;
  let dbPath: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tracebench-opencode-fixture-'));
    dbPath = join(root, 'opencode.db');
    createMinimalOpencodeDb(dbPath);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers fixture session', () => {
    const found = discoverSessions(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.session_id).toBe('ses_fixture_001');
    expect(found[0]!.file_path).toContain('ses_fixture_001@');
  });

  it('normalizes user message, thinking, assistant text, and tool call/result', async () => {
    const discovered = discoverSessions(root)[0]!;
    const { session, events } = await loadSession(discovered.file_path);

    expect(session.session_id).toBe('ses_fixture_001');
    expect(session.harness).toBe('opencode');
    expect(session.project_path).toBe('/Users/me/code/fixture');
    expect(session.title).toMatch(/Read the fixture README/);

    const types = events.map((e) => e.event_type);
    expect(types).toContain('message');
    expect(types).toContain('thinking');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');

    const userMsg = events.find((e) => e.role === 'user' && e.event_type === 'message');
    expect(userMsg?.content).toMatch(/Read the README/);

    const toolCall = events.find((e) => e.event_type === 'tool_call');
    expect(toolCall?.event_id).toBe('call_fixture_read_001');
    expect(toolCall?.tool.name).toBe('Read');

    const toolResult = events.find((e) => e.event_type === 'tool_result');
    expect(toolResult?.parent_event_id).toBe('call_fixture_read_001');
    expect(String(toolResult?.content)).toMatch(/Fixture/);

    const withTokens = events.find((e) => e.tokens.input != null);
    expect(withTokens?.tokens.input).toBe(100);
    expect(withTokens?.tokens.output).toBe(50);
  });
});
