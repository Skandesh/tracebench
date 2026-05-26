// The registry of harness adapters known to the server.
//
// Each adapter implements (effectively) the same shape:
//   - a default root path on disk
//   - discoverSessions(root?) → { session_id, file_path, mtime_ms, size }[]
//   - loadSession(file_path) → { session, events }
//   - FORMAT_VERSION string
//
// We deliberately don't load these via dynamic require/plugin loader yet —
// that's a v0.4 task. In-tree imports are fine until then.

import * as claudeCode from '@tracebench/adapter-claude-code';
import * as codex from '@tracebench/adapter-codex';
import * as cursor from '@tracebench/adapter-cursor';
import * as opencode from '@tracebench/adapter-opencode';
import type { CanonicalEvent, Harness, Session } from '@tracebench/core';
import { join } from 'node:path';

export interface AdapterDiscovered {
  session_id: string;
  file_path: string;
  mtime_ms: number;
  size: number;
}

export interface AdapterLoadResult {
  session: Session;
  events: CanonicalEvent[];
}

export interface AdapterDiscoverContext {
  cursorGlobalDbPath?: string;
}

export interface AdapterModule {
  harness: Harness;
  formatVersion: string;
  defaultRoot(): string;
  discover(root?: string, ctx?: AdapterDiscoverContext): AdapterDiscovered[];
  load(filePath: string): Promise<AdapterLoadResult>;
  /** Optional: reuse expensive resources (e.g. DB snapshot) across an index pass. */
  beginIndexPass?(root?: string): void;
  endIndexPass?(): void;
}

const claudeCodeAdapter: AdapterModule = {
  harness: 'claude_code',
  formatVersion: claudeCode.FORMAT_VERSION,
  defaultRoot: claudeCode.defaultProjectsRoot,
  discover: (root) => claudeCode.discoverSessions(root),
  load: (p) => claudeCode.loadSession(p),
};

const codexAdapter: AdapterModule = {
  harness: 'codex',
  formatVersion: codex.FORMAT_VERSION,
  defaultRoot: codex.defaultCodexRoot,
  discover: (root) => codex.discoverSessions(root),
  load: (p) => codex.loadSession(p),
};

const cursorAdapter: AdapterModule = {
  harness: 'cursor',
  formatVersion: cursor.FORMAT_VERSION,
  defaultRoot: cursor.defaultProjectsRoot,
  discover: (root, ctx) =>
    cursor.discoverSessions({
      projectsRoot: root,
      globalDbPath: ctx?.cursorGlobalDbPath,
    }).map((d) => ({
      session_id: d.session_id,
      file_path: d.file_path,
      mtime_ms: d.mtime_ms,
      size: d.size,
    })),
  load: (p) => cursor.loadSession(p),
};

const opencodeAdapter: AdapterModule = {
  harness: 'opencode',
  formatVersion: opencode.FORMAT_VERSION,
  defaultRoot: opencode.defaultOpencodeRoot,
  discover: (root) => opencode.discoverSessions(root),
  load: (p) => opencode.loadSession(p),
  beginIndexPass: (root) =>
    opencode.beginOpencodeDbBatch(join(root ?? opencode.defaultOpencodeRoot(), 'opencode.db')),
  endIndexPass: () => opencode.endOpencodeDbBatch(),
};

export const ADAPTERS: AdapterModule[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
];

export function adapterByHarness(name: Harness): AdapterModule | undefined {
  return ADAPTERS.find((a) => a.harness === name);
}
