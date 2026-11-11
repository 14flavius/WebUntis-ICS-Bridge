import { migrate, type Db } from './db.js';
export function migrateApplication(db: Db) {
  migrate(
    db,
    100,
    `
    CREATE TABLE webuntis_accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, school TEXT NOT NULL, server TEXT NOT NULL,
      username TEXT NOT NULL, password TEXT NOT NULL, timezone TEXT NOT NULL,
      lastSuccess TEXT, lastAttempt TEXT, error TEXT
    );
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), intervalMinutes INTEGER NOT NULL DEFAULT 10, language TEXT NOT NULL DEFAULT 'en');
    INSERT INTO settings (id) VALUES (1);
  `,
  );
  migrate(
    db,
    101,
    `
    ALTER TABLE webuntis_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE events (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      sourceId TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL,
      payload TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL,
      modifiedAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, missingSince TEXT,
      PRIMARY KEY (accountId, sourceId)
    );
    CREATE TABLE sync_coverage (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      category TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, checkedAt TEXT NOT NULL,
      PRIMARY KEY (accountId, category, start, end)
    );
    CREATE TABLE feeds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, pastDays INTEGER NOT NULL,
      futureDays INTEGER NOT NULL, config TEXT NOT NULL, modifiedAt TEXT NOT NULL
    );
  `,
  );
  migrate(
    db,
    102,
    `
    ALTER TABLE feeds ADD COLUMN publishedHash TEXT;
    ALTER TABLE feeds ADD COLUMN publishedAt TEXT;
    CREATE TABLE feed_event_state (
      feedId TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      uid TEXT NOT NULL, hash TEXT NOT NULL, sequence INTEGER NOT NULL,
      modifiedAt TEXT NOT NULL, PRIMARY KEY(feedId, uid)
    );
  `,
  );
  migrate(
    db,
    103,
    `
    CREATE TABLE event_aliases (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      originalId TEXT NOT NULL, sourceId TEXT NOT NULL,
      PRIMARY KEY(accountId, originalId)
    );
  `,
  );
  migrate(
    db,
    104,
    `
    CREATE TABLE exam_identities (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(accountId, id)
    );
  `,
  );
  migrate(
    db,
    105,
    `
    ALTER TABLE webuntis_accounts ADD COLUMN examSource TEXT NOT NULL DEFAULT 'exams'
      CHECK(examSource IN ('exams', 'timetable'));
    CREATE TABLE exam_tab_events (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      id TEXT NOT NULL, schoolYearId TEXT NOT NULL, payload TEXT NOT NULL,
      revision INTEGER NOT NULL, createdAt TEXT NOT NULL, modifiedAt TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, missingSince TEXT,
      PRIMARY KEY(accountId, id)
    );
    CREATE TABLE exam_source_days (
      accountId TEXT NOT NULL REFERENCES webuntis_accounts(id) ON DELETE CASCADE,
      date TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('exams', 'timetable')),
      PRIMARY KEY(accountId, date)
    );
  `,
  );
  // Ownership for multiple users. Without a foreign key because Better Auth
  // creates the user table later; deleting a user removes these rows explicitly.
  migrate(
    db,
    106,
    `
    ALTER TABLE webuntis_accounts ADD COLUMN ownerId TEXT;
    ALTER TABLE feeds ADD COLUMN ownerId TEXT;
    CREATE INDEX webuntis_accounts_owner ON webuntis_accounts (ownerId);
    CREATE INDEX feeds_owner ON feeds (ownerId);
  `,
  );
}
