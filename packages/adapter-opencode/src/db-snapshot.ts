// Copy OpenCode's opencode.db (+ WAL sidecars) for consistent reads while OpenCode is running.
//
// During an index pass we hold one snapshot for all sessions — copying a 500MB+
// DB per session was ~300× slower than necessary.

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface DbSnapshot {
  dbPath: string;
  /** Empty when opened in-place (no temp copy). */
  tempDir: string;
}

let batchSnapshot: { mainDbPath: string; snap: DbSnapshot } | null = null;

/** Hold one DB snapshot for the duration of an index pass (discover + N loads). */
export function beginOpencodeDbBatch(mainDbPath: string): void {
  endOpencodeDbBatch();
  const snap = snapshotOpencodeDb(mainDbPath);
  if (snap) batchSnapshot = { mainDbPath, snap };
}

export function endOpencodeDbBatch(): void {
  if (!batchSnapshot) return;
  releaseDbSnapshot(batchSnapshot.snap);
  batchSnapshot = null;
}

export function acquireSnapshot(mainDbPath: string): DbSnapshot | null {
  if (batchSnapshot?.mainDbPath === mainDbPath) return batchSnapshot.snap;
  return snapshotOpencodeDb(mainDbPath);
}

export function releaseSnapshot(mainDbPath: string, snap: DbSnapshot): void {
  if (batchSnapshot?.mainDbPath === mainDbPath && batchSnapshot.snap === snap) return;
  releaseDbSnapshot(snap);
}

export function snapshotOpencodeDb(mainDbPath: string): DbSnapshot | null {
  if (!existsSync(mainDbPath)) return null;

  const base = basename(mainDbPath);
  const dir = join(mainDbPath, '..');
  const wal = join(dir, `${base}-wal`);
  const walBytes = existsSync(wal) ? statSync(wal).size : 0;

  // No pending WAL — safe to read the live file without copying.
  if (walBytes === 0) {
    return { dbPath: mainDbPath, tempDir: '' };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'tracebench-opencode-db-'));
  copyFileSync(mainDbPath, join(tempDir, base));
  const shm = join(dir, `${base}-shm`);
  if (existsSync(wal)) copyFileSync(wal, join(tempDir, `${base}-wal`));
  if (existsSync(shm)) copyFileSync(shm, join(tempDir, `${base}-shm`));

  return { dbPath: join(tempDir, base), tempDir };
}

export function releaseDbSnapshot(snapshot: DbSnapshot | null): void {
  if (!snapshot?.tempDir) return;
  try {
    rmSync(snapshot.tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}
