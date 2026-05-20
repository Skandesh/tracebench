// Copy Cursor's state.vscdb (+ WAL sidecars) for consistent reads while Cursor is running.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface DbSnapshot {
  /** Path to the copied main DB file (inside a temp dir). */
  dbPath: string;
  /** Temp directory holding the snapshot; call `releaseDbSnapshot` when done. */
  tempDir: string;
}

/**
 * Snapshot `state.vscdb` (and `-wal`/`-shm` when present) into a temp directory.
 * Returns null when the main DB file does not exist.
 */
export function snapshotCursorDb(mainDbPath: string): DbSnapshot | null {
  if (!existsSync(mainDbPath)) return null;

  const tempDir = mkdtempSync(join(tmpdir(), 'tracebench-cursor-db-'));
  const base = basename(mainDbPath);
  const dir = join(mainDbPath, '..');

  copyFileSync(mainDbPath, join(tempDir, base));
  const wal = join(dir, `${base}-wal`);
  const shm = join(dir, `${base}-shm`);
  if (existsSync(wal)) copyFileSync(wal, join(tempDir, `${base}-wal`));
  if (existsSync(shm)) copyFileSync(shm, join(tempDir, `${base}-shm`));

  return { dbPath: join(tempDir, base), tempDir };
}

export function releaseDbSnapshot(snapshot: DbSnapshot | null): void {
  if (!snapshot) return;
  try {
    rmSync(snapshot.tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}
