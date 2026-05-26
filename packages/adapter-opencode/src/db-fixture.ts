/** Build a minimal OpenCode opencode.db for tests. */
import { SqliteDatabase } from '@tracebench/core';

export function createMinimalOpencodeDb(dbPath: string): void {
  const db = new SqliteDatabase(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  const projectId = 'proj_fixture_001';
  const sessionId = 'ses_fixture_001';
  const userMsgId = 'msg_fixture_user_001';
  const asstMsgId = 'msg_fixture_asst_001';
  const t0 = 1_770_000_000_000;
  const t1 = t0 + 1_000;
  const t2 = t0 + 2_000;
  const t3 = t0 + 3_000;

  db.prepare(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, '/Users/me/code/fixture', 'git', 'fixture', t0, t0, '[]');

  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    projectId,
    null,
    'fixture-session',
    '/Users/me/code/fixture',
    'Read the fixture README',
    '1.0.0',
    t0,
    t3,
  );

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    userMsgId,
    sessionId,
    t0,
    t0,
    JSON.stringify({
      role: 'user',
      time: { created: t0 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
    }),
  );

  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_fixture_user_text',
    userMsgId,
    sessionId,
    t0,
    t0,
    JSON.stringify({ type: 'text', text: 'Read the README and summarize it.' }),
  );

  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    asstMsgId,
    sessionId,
    t1,
    t3,
    JSON.stringify({
      role: 'assistant',
      time: { created: t1, completed: t3 },
      modelID: 'gpt-4.1',
      providerID: 'openai',
      agent: 'build',
      cost: 0,
      tokens: {
        total: 150,
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: 'stop',
    }),
  );

  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_fixture_reasoning',
    asstMsgId,
    sessionId,
    t1,
    t1,
    JSON.stringify({ type: 'reasoning', text: 'Planning to read the README.' }),
  );

  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_fixture_text',
    asstMsgId,
    sessionId,
    t2,
    t2,
    JSON.stringify({ type: 'text', text: 'Here is a summary of the README.' }),
  );

  const callId = 'call_fixture_read_001';
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'prt_fixture_tool',
    asstMsgId,
    sessionId,
    t2,
    t3,
    JSON.stringify({
      type: 'tool',
      callID: callId,
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: '/Users/me/code/fixture/README.md' },
        output: '# Fixture\nA sample project.',
        time: { start: t2, end: t3 },
      },
    }),
  );

  db.close();
}
