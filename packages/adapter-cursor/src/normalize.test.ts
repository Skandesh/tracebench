import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession, normalizeSession, parseTranscriptPath, streamLoadSession } from './normalize.js';
import { parseSession } from './parse.js';
import { decodeProjectPath } from './paths.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

describe('fixture 01 — simple agent transcript', () => {
  it('emits a cursor session with decoded project path', async () => {
    const rawPath = join(
      '/Users/me/.cursor/projects/Users-me-code-fixture/agent-transcripts',
      'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
    );
    const raws = await parseSession(join(FIXTURES, '01-simple.jsonl'));
    const { session, events } = normalizeSession(raws, {
      rawPath,
      sessionId: 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      formatVersion: '2026-q1',
      fileMtimeMs: new Date('2026-05-18T12:00:05.000Z').getTime(),
      encodedProjectDir: 'Users-me-code-fixture',
    });
    expect(session.harness).toBe('cursor');
    expect(session.session_id).toBe('aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(session.project_path).toBe('/Users/me/code/fixture');
    expect(session.title).toMatch(/Read the README/);
    expect(session.model).toBeNull();
    expect(events.length).toBeGreaterThan(0);
  });

  it('splits assistant blocks and emits tool_call without upstream id', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const toolCalls = events.filter((e) => e.event_type === 'tool_call');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]!.tool.name).toBe('Read');
    expect(toolCalls[0]!.event_id).toMatch(/^cursor:/);
    expect(events.some((e) => e.event_type === 'tool_result')).toBe(false);
  });

  it('strips user_query wrappers from user messages', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const user = events.find((e) => e.role === 'user');
    expect(user!.content).toBe('Read the README and summarize it');
  });

  it('starts a new turn per user message', async () => {
    const { events } = await loadSession(join(FIXTURES, '01-simple.jsonl'));
    const turnIds = new Set(events.map((e) => e.turn_id));
    expect(turnIds.size).toBe(1);
  });
});

describe('parseTranscriptPath', () => {
  it('detects subagent transcripts', () => {
    const p =
      '/Users/me/.cursor/projects/Users-me-proj/agent-transcripts/parent-uuid/subagents/child-uuid.jsonl';
    const info = parseTranscriptPath(p);
    expect(info.subagent).toBe(true);
    expect(info.parent_session_id).toBe('parent-uuid');
    expect(info.encoded_project_dir).toBe('Users-me-proj');
  });
});

describe('decodeProjectPath', () => {
  it('decodes macOS-style encoded dirs', () => {
    expect(decodeProjectPath('Users-skndsh-Desktop-projects-tracebench')).toBe(
      '/Users/skndsh/Desktop/projects/tracebench',
    );
  });
});

describe('streamLoadSession', () => {
  it('emits the same canonical event order in batches with source line locators', async () => {
    const path = join(FIXTURES, '01-simple.jsonl');
    const loaded = await loadSession(path);
    const streamedEvents = [];
    let streamedSession = null as null | typeof loaded.session;
    for await (const chunk of streamLoadSession(path, { batchSize: 2 })) {
      if (chunk.type === 'session') streamedSession = chunk.session;
      else streamedEvents.push(...chunk.events);
    }
    expect(streamedSession?.session_id).toBe(loaded.session.session_id);
    expect(streamedEvents.map((e) => e.event_id)).toEqual(loaded.events.map((e) => e.event_id));
    expect(streamedEvents.some((e) => typeof e.source.line === 'number')).toBe(true);
  });
});
