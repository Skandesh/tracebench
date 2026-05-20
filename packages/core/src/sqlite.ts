// Re-export better-sqlite3 so adapters can use it without a duplicate dependency.

export { default as SqliteDatabase } from 'better-sqlite3';
export type { Database as SqliteDatabaseInstance } from 'better-sqlite3';
export type { RunResult, Statement } from 'better-sqlite3';
