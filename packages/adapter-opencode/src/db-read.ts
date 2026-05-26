// Read OpenCode sessions from opencode.db.

import { statSync } from 'node:fs';
import { SqliteDatabase } from '@tracebench/core';
import { acquireSnapshot, releaseSnapshot } from './db-snapshot.js';

export interface OpencodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
}

export interface OpencodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface OpencodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface SessionListEntry {
  sessionId: string;
  title: string;
  directory: string;
  messageCount: number;
  timeCreated: number;
  timeUpdated: number;
}

export interface LoadedOpencodeMessage {
  row: OpencodeMessageRow;
  data: Record<string, unknown>;
  parts: Array<{ row: OpencodePartRow; data: Record<string, unknown> }>;
}

export interface LoadedOpencodeSession {
  session: OpencodeSessionRow;
  messages: LoadedOpencodeMessage[];
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function openReadonly(dbPath: string) {
  return new SqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
}

export function opencodeDbMtimeMs(dbPath: string): number {
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function listSessions(dbPath: string): SessionListEntry[] {
  const snap = acquireSnapshot(dbPath);
  if (!snap) return [];

  try {
    const db = openReadonly(snap.dbPath);
    const rows = db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
         FROM session s
         ORDER BY s.time_updated DESC`,
      )
      .all() as Array<{
      id: string;
      title: string;
      directory: string;
      time_created: number;
      time_updated: number;
      message_count: number;
    }>;
    db.close();

    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      directory: r.directory,
      messageCount: r.message_count,
      timeCreated: r.time_created,
      timeUpdated: r.time_updated,
    }));
  } finally {
    releaseSnapshot(dbPath, snap);
  }
}

export function loadSessionFromDb(
  dbPath: string,
  sessionId: string,
): LoadedOpencodeSession | null {
  const snap = acquireSnapshot(dbPath);
  if (!snap) return null;

  try {
    const db = openReadonly(snap.dbPath);

    const session = db
      .prepare(
        `SELECT id, project_id, parent_id, slug, directory, title, version,
                time_created, time_updated
         FROM session WHERE id = ?`,
      )
      .get(sessionId) as OpencodeSessionRow | undefined;
    if (!session) {
      db.close();
      return null;
    }

    const messageRows = db
      .prepare(
        `SELECT id, session_id, time_created, time_updated, data
         FROM message WHERE session_id = ?
         ORDER BY time_created ASC, id ASC`,
      )
      .all(sessionId) as OpencodeMessageRow[];

    const partStmt = db.prepare(
      `SELECT id, message_id, session_id, time_created, time_updated, data
       FROM part WHERE message_id = ?
       ORDER BY time_created ASC, id ASC`,
    );

    const messages: LoadedOpencodeMessage[] = messageRows.map((row) => {
      const partRows = partStmt.all(row.id) as OpencodePartRow[];
      return {
        row,
        data: parseJson<Record<string, unknown>>(row.data) ?? {},
        parts: partRows.map((p) => ({
          row: p,
          data: parseJson<Record<string, unknown>>(p.data) ?? {},
        })),
      };
    });

    db.close();
    return { session, messages };
  } finally {
    releaseSnapshot(dbPath, snap);
  }
}
