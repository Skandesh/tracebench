// Read Composer sessions from Cursor's global state.vscdb.

import { statSync } from 'node:fs';
import { SqliteDatabase } from '@tracebench/core';
import type {
  ComposerDataRow,
  ComposerHeaderEntry,
  ConversationHeader,
  CursorBubble,
} from './db-types.js';
import { snapshotCursorDb, releaseDbSnapshot } from './db-snapshot.js';

export interface ComposerListEntry {
  composerId: string;
  name: string | null;
  subtitle: string | null;
  projectPath: string | null;
  createdAtMs: number | null;
  lastUpdatedAtMs: number | null;
  unifiedMode: string | null;
  modelName: string | null;
  bubbleCount: number;
  /** Number of bubbles listed in fullConversationHeadersOnly (may be 0 for agent sessions). */
  headerBubbleCount: number;
}

function parseJson<T>(raw: string | Buffer | null | undefined): T | null {
  if (raw == null) return null;
  const s = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function workspacePath(
  ws?: { uri?: { fsPath?: string; path?: string } },
): string | null {
  return ws?.uri?.fsPath ?? ws?.uri?.path ?? null;
}

function openReadonly(dbPath: string) {
  return new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
}

/** List composers that have at least one stored bubble. */
export function listComposersWithBubbles(dbPath: string): ComposerListEntry[] {
  const snap = snapshotCursorDb(dbPath);
  if (!snap) return [];

  try {
    const db = openReadonly(snap.dbPath);

    const headersRaw = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get('composer.composerHeaders') as { value: string } | undefined;
    const headers = parseJson<{ allComposers?: ComposerHeaderEntry[] }>(
      headersRaw?.value,
    );
    const headerById = new Map<string, ComposerHeaderEntry>();
    for (const h of headers?.allComposers ?? []) {
      if (h.composerId) headerById.set(h.composerId, h);
    }

    const bubbleCounts = new Map<string, number>();
    const rows = db
      .prepare(
        `SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`,
      )
      .all() as { key: string }[];
    for (const { key } of rows) {
      const parts = key.split(':');
      if (parts.length < 3) continue;
      const composerId = parts[1]!;
      bubbleCounts.set(composerId, (bubbleCounts.get(composerId) ?? 0) + 1);
    }

    const composerIds = [...bubbleCounts.keys()];
    const out: ComposerListEntry[] = [];

    const dataStmt = db.prepare(
      'SELECT value FROM cursorDiskKV WHERE key = ?',
    );

    for (const composerId of composerIds) {
      const dataRow = dataStmt.get(`composerData:${composerId}`) as
        | { value: string }
        | undefined;
      const data = parseJson<ComposerDataRow>(dataRow?.value);
      const header = headerById.get(composerId);

      const name =
        data?.name ?? header?.name ?? header?.subtitle ?? data?.subtitle ?? null;
      const projectPath =
        workspacePath(data?.workspaceIdentifier) ??
        workspacePath(header?.workspaceIdentifier);

      out.push({
        composerId,
        name: name ?? null,
        subtitle: data?.subtitle ?? header?.subtitle ?? null,
        projectPath,
        createdAtMs: data?.createdAt ?? header?.createdAt ?? null,
        lastUpdatedAtMs: data?.lastUpdatedAt ?? header?.lastUpdatedAt ?? null,
        unifiedMode: data?.unifiedMode ?? header?.unifiedMode ?? null,
        modelName: data?.modelConfig?.modelName ?? null,
        bubbleCount: bubbleCounts.get(composerId) ?? 0,
        headerBubbleCount: data?.fullConversationHeadersOnly?.length ?? 0,
      });
    }

    db.close();
    out.sort((a, b) => (b.lastUpdatedAtMs ?? 0) - (a.lastUpdatedAtMs ?? 0));
    return out;
  } finally {
    releaseDbSnapshot(snap);
  }
}

export interface LoadedComposer {
  composerId: string;
  data: ComposerDataRow | null;
  headers: ConversationHeader[];
  bubbles: CursorBubble[];
}

export function loadComposerFromDb(
  dbPath: string,
  composerId: string,
): LoadedComposer | null {
  const snap = snapshotCursorDb(dbPath);
  if (!snap) return null;

  try {
    const db = openReadonly(snap.dbPath);

    const dataRow = db
      .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${composerId}`) as { value: string } | undefined;
    const data = parseJson<ComposerDataRow>(dataRow?.value);

    const headerList = data?.fullConversationHeadersOnly ?? [];
    const bubbles: CursorBubble[] = [];

    const bubbleStmt = db.prepare(
      'SELECT value FROM cursorDiskKV WHERE key = ?',
    );
    const prefix = `bubbleId:${composerId}:`;

    if (headerList.length > 0) {
      for (const h of headerList) {
        const row = bubbleStmt.get(`${prefix}${h.bubbleId}`) as
          | { value: string }
          | undefined;
        const bubble = parseJson<CursorBubble>(row?.value);
        if (bubble) bubbles.push(bubble);
      }
    } else {
      const all = db
        .prepare(
          `SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`,
        )
        .all(`${prefix}%`) as { key: string; value: string }[];
      for (const row of all) {
        const bubble = parseJson<CursorBubble>(row.value);
        if (bubble) bubbles.push(bubble);
      }
      bubbles.sort((a, b) => {
        const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return ta - tb;
      });
    }

    db.close();

    if (bubbles.length === 0 && !data) return null;

    return {
      composerId,
      data,
      headers: headerList,
      bubbles,
    };
  } finally {
    releaseDbSnapshot(snap);
  }
}

/** DB mtime for incremental indexing (main file only). */
export function cursorDbMtimeMs(dbPath: string): number {
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}
