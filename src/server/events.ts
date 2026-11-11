import type { Db } from './db.js';
import type { CalendarEvent, Snapshot, StoredEvent } from '../shared/events.js';
import { AppError } from './errors.js';
import { originalIds, resolveIdentities } from './identities.js';
import { prepareExamIdentities } from './exam-identities.js';
import { refreshStoredLabels } from './webuntis/stored-labels.js';
import { commitExamFeeds } from './exam-feeds.js';

interface EventRow {
  accountId: string;
  sourceId: string;
  payload: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
  deleted: number;
  missingSince: string | null;
}
export function storedEvents(db: Db): StoredEvent[] {
  const rows = db
    .prepare(
      'SELECT * FROM events WHERE deleted = 0 ORDER BY accountId, sourceId',
    )
    .all() as EventRow[];
  return rows.map((row) => ({
    ...(JSON.parse(row.payload) as CalendarEvent),
    accountId: row.accountId,
    revision: row.revision,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
  }));
}
function relevant(event: CalendarEvent) {
  const { source: _source, ...content } = event;
  void _source;
  return JSON.stringify(content);
}

/** Publish only after all snapshots are validated. Missing records require two
 * complete observations, at least a minute apart. Unexpected wholly empty
 * responses retain old data indefinitely unless WebUntis explicitly says NO_DATA.
 * Tombstones retain revisions when the same source later reappears.
 */
export function commitSnapshots(
  db: Db,
  accountId: string,
  snapshots: Snapshot[],
  now = new Date().toISOString(),
) {
  return db
    .transaction(() => {
      const prepared = prepareExamIdentities(db, accountId, snapshots);
      const preparedSnapshots = prepared.snapshots;
      const seen = new Map<string, CalendarEvent>();
      for (const snapshot of preparedSnapshots) {
        for (const event of snapshot.events) {
          if (
            event.category !== snapshot.category ||
            (event.category !== 'holiday' &&
              (event.date < snapshot.start || event.date > snapshot.end))
          )
            throw new AppError('WEBUNTIS_OUTSIDE_WINDOW', 502);
          const previous = seen.get(event.sourceId);
          if (previous && relevant(previous) !== relevant(event))
            throw new AppError('WEBUNTIS_CONFLICTING_ID', 502);
          seen.set(event.sourceId, event);
        }
      }
      const { published, assignments } = resolveIdentities(db, accountId, [
        ...seen.values(),
      ]);
      let retained = 0;
      const rows = db
        .prepare('SELECT * FROM events WHERE accountId = ?')
        .all(accountId) as EventRow[];
      const previous = new Map(rows.map((row) => [row.sourceId, row]));
      for (const event of published.values()) {
        const old = previous.get(event.sourceId);
        const changed =
          !old ||
          !!old.deleted ||
          relevant(JSON.parse(old.payload) as CalendarEvent) !==
            relevant(event);
        db.prepare(
          `INSERT INTO events (accountId, sourceId, category, date, payload, revision, createdAt, modifiedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(accountId, sourceId) DO UPDATE SET category=excluded.category, date=excluded.date, payload=excluded.payload, revision=excluded.revision, modifiedAt=excluded.modifiedAt, deleted=0, missingSince=NULL`,
        ).run(
          accountId,
          event.sourceId,
          event.category,
          event.date,
          JSON.stringify(event),
          (old?.revision ?? -1) + Number(changed),
          old?.createdAt ?? now,
          changed ? now : old!.modifiedAt,
        );
      }
      for (const row of rows) {
        if (published.has(row.sourceId) || row.deleted) continue;
        const event = JSON.parse(row.payload) as CalendarEvent;
        if (
          snapshots.some(
            (snapshot) =>
              event.date >= snapshot.start && event.date <= snapshot.end,
          )
        ) {
          const refreshed = refreshStoredLabels(event);
          if (refreshed !== event)
            db.prepare(
              'UPDATE events SET payload = ?, revision = revision + 1, modifiedAt = ? WHERE accountId = ? AND sourceId = ?',
            ).run(JSON.stringify(refreshed), now, accountId, row.sourceId);
        }
        const consolidated = originalIds(event).every(
          (id) => assignments.has(id) && assignments.get(id) !== row.sourceId,
        );
        if (consolidated) {
          db.prepare(
            'UPDATE events SET deleted = 1, revision = revision + 1, modifiedAt = ?, missingSince = NULL WHERE accountId = ? AND sourceId = ?',
          ).run(now, accountId, row.sourceId);
          continue;
        }
        const coverage = preparedSnapshots.find(
          (snapshot) =>
            snapshot.deletionCoverage !== false &&
            snapshot.category === event.category &&
            event.date >= snapshot.start &&
            event.date <= snapshot.end,
        );
        if (!coverage) continue;
        if (
          prepared.protectedIds.has(row.sourceId) ||
          originalIds(event).some((id) => prepared.protectedIds.has(id))
        ) {
          retained++;
          continue;
        }
        const trustworthy =
          coverage.events.some((candidate) => candidate.date === event.date) ||
          coverage.confirmedEmptyDates.includes(event.date);
        if (!trustworthy) {
          retained++;
          continue;
        }
        if (
          row.missingSince &&
          Date.parse(now) - Date.parse(row.missingSince) >= 60000
        ) {
          db.prepare(
            'UPDATE events SET deleted = 1, revision = revision + 1, modifiedAt = ?, missingSince = NULL WHERE accountId = ? AND sourceId = ?',
          ).run(now, accountId, row.sourceId);
        } else {
          retained++;
          db.prepare(
            'UPDATE events SET missingSince = COALESCE(missingSince, ?) WHERE accountId = ? AND sourceId = ?',
          ).run(now, accountId, row.sourceId);
        }
      }
      for (const snapshot of preparedSnapshots) {
        if (snapshot.deletionCoverage === false) continue;
        db.prepare(
          `INSERT INTO sync_coverage (accountId, category, start, end, checkedAt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(accountId, category, start, end) DO UPDATE SET checkedAt=excluded.checkedAt`,
        ).run(accountId, snapshot.category, snapshot.start, snapshot.end, now);
      }
      const warnings = commitExamFeeds(db, accountId, snapshots, now);
      if (!snapshots.some((snapshot) => snapshot.examFeed))
        warnings.push(...prepared.warnings);
      if (retained) warnings.push('RETAINED_UNCONFIRMED_EVENTS');
      db.prepare(
        'UPDATE webuntis_accounts SET lastSuccess = ?, error = ? WHERE id = ?',
      ).run(now, warnings.length ? warnings.join(', ') : null, accountId);
      return { retained, warnings };
    })
    .immediate();
}
