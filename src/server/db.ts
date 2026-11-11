import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename: string) {
  if (filename !== ':memory:')
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)',
  );
  return db;
}
export type Db = ReturnType<typeof openDatabase>;

export function migrate(db: Db, version: number, sql: string) {
  db.transaction(() => {
    if (
      db
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(version)
    )
      return;
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(
      version,
    );
  }).immediate();
}
