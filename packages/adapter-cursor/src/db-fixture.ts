/** Build a minimal Cursor state.vscdb for tests. */
import { SqliteDatabase } from '@tracebench/core';

export function createMinimalCursorDb(dbPath: string): void {
  const db = new SqliteDatabase(dbPath);
  db.exec(`
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
  `);

  const composerId = 'aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const userBubbleId = '11111111-1111-1111-1111-111111111111';
  const thinkBubbleId = '22222222-2222-2222-2222-222222222222';
  const toolBubbleId = '33333333-3333-3333-3333-333333333333';

  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerHeaders',
    JSON.stringify({
      allComposers: [
        {
          type: 'head',
          composerId,
          name: 'Fixture composer chat',
          lastUpdatedAt: 1_770_000_000_000,
          createdAt: 1_769_999_000_000,
          workspaceIdentifier: {
            uri: { fsPath: '/Users/me/code/fixture' },
          },
        },
      ],
    }),
  );

  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    `composerData:${composerId}`,
    JSON.stringify({
      composerId,
      name: 'Fixture composer chat',
      createdAt: 1_769_999_000_000,
      lastUpdatedAt: 1_770_000_000_000,
      unifiedMode: 'agent',
      modelConfig: { modelName: 'composer-2.5' },
      fullConversationHeadersOnly: [
        { bubbleId: userBubbleId, type: 1 },
        { bubbleId: thinkBubbleId, type: 2 },
        { bubbleId: toolBubbleId, type: 2 },
      ],
      workspaceIdentifier: {
        uri: { fsPath: '/Users/me/code/fixture' },
      },
    }),
  );

  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    `bubbleId:${composerId}:${userBubbleId}`,
    JSON.stringify({
      bubbleId: userBubbleId,
      type: 1,
      text: '<user_query>\nSummarize the fixture DB session\n</user_query>',
      createdAt: '2026-05-18T10:00:00.000Z',
    }),
  );

  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    `bubbleId:${composerId}:${thinkBubbleId}`,
    JSON.stringify({
      bubbleId: thinkBubbleId,
      type: 2,
      capabilityType: 30,
      thinking: { text: 'Planning fixture response.' },
      thinkingDurationMs: 50,
      createdAt: '2026-05-18T10:00:01.000Z',
    }),
  );

  const toolCallId = 'tool_fixture_call_001';
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    `bubbleId:${composerId}:${toolBubbleId}`,
    JSON.stringify({
      bubbleId: toolBubbleId,
      type: 2,
      capabilityType: 15,
      createdAt: '2026-05-18T10:00:02.000Z',
      modelInfo: { modelName: 'composer-2.5' },
      tokenCount: { inputTokens: 10, outputTokens: 20 },
      toolFormerData: {
        toolCallId,
        name: 'read_file',
        status: 'completed',
        params: JSON.stringify({ path: '/Users/me/code/fixture/README.md' }),
        result: JSON.stringify({ output: '# Fixture\n', rejected: false }),
      },
    }),
  );

  db.close();
}
