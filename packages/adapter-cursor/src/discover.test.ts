import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions } from './discover.js';

describe('discoverSessions', () => {
  it('finds nested and subagent jsonl files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tb-cursor-discover-'));
    const project = join(root, 'Users-me-testproj');
    const nested = join(project, 'agent-transcripts', 'sess-main', 'sess-main.jsonl');
    const subagent = join(
      project,
      'agent-transcripts',
      'sess-main',
      'subagents',
      'sess-sub.jsonl',
    );
    mkdirSync(join(project, 'agent-transcripts', 'sess-main', 'subagents'), {
      recursive: true,
    });
    writeFileSync(nested, '{"role":"user","message":{"content":[]}}\n');
    writeFileSync(subagent, '{"role":"user","message":{"content":[]}}\n');

    const found = discoverSessions({ projectsRoot: root, globalDbPath: false });
    const ids = found.map((f) => f.session_id).sort();
    expect(ids).toEqual(['sess-main', 'sess-sub']);
    expect(found.every((f) => f.encoded_project_dir === 'Users-me-testproj')).toBe(true);
  });

  it('returns empty when root is missing', () => {
    expect(
      discoverSessions({ projectsRoot: '/nonexistent/tracebench-cursor-root', globalDbPath: false }),
    ).toEqual([]);
  });
});
