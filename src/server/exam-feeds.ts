import { randomUUID } from 'node:crypto';
import type {
  CalendarEvent,
  ExamCandidate,
  Snapshot,
  StoredEvent,
} from '../shared/events.js';
import type { ExamSource } from '../shared/types.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { matchExams, type ExamIdentity } from './webuntis/exam-matching.js';

interface ExamRow {
  accountId: string;
  id: string;
  schoolYearId: string;
  payload: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
  deleted: number;
  missingSince: string | null;
}

function content(event: CalendarEvent): string {
  return JSON.stringify({ ...event, source: '' });
}

/** Runs within commitSnapshots' transaction. The Exams tab has an independent
 * identity set: a 90-minute tab exam must not inherit two timetable sections. */
export function commitExamFeeds(
  db: Db,
  accountId: string,
  snapshots: Snapshot[],
  now: string,
): string[] {
  const warnings = new Set<string>();
  for (const snapshot of snapshots) {
    const feed = snapshot.examFeed;
    if (!feed) continue;
    const dates = new Set(feed.dates);
    if (
      !feed.schoolYearId ||
      dates.size !== feed.dates.length ||
      feed.dates.some((date) => date < snapshot.start || date > snapshot.end) ||
      feed.events.some(
        (event) =>
          event.category !== 'exam' ||
          !event.sourceId.startsWith('exam:') ||
          !dates.has(event.date),
      )
    )
      throw new AppError('WEBUNTIS_INVALID_EXAM_CANDIDATE', 502);
    const ambiguousDates = new Set<string>();
    if (feed.source === 'exams') {
      const rows = db
        .prepare('SELECT * FROM exam_tab_events WHERE accountId = ?')
        .all(accountId) as ExamRow[];
      const previous: ExamIdentity[] = rows.map((row) => ({
        id: row.id,
        schoolYearId: row.schoolYearId,
        event: JSON.parse(row.payload) as CalendarEvent,
      }));
      const incoming: ExamCandidate[] = feed.events.map((event) => ({
        event,
        schoolYearId: feed.schoolYearId,
      }));
      const plan = matchExams(incoming, previous);
      for (const candidate of plan.ambiguous)
        ambiguousDates.add(candidate.event.date);
      if (ambiguousDates.size) warnings.add('EXAMS_AMBIGUOUS');
      const seen = new Set<string>();
      for (const candidate of [...plan.matches.keys(), ...plan.created]) {
        const id =
          plan.matches.get(candidate)?.id ?? `exam-tab:${randomUUID()}`;
        seen.add(id);
        const old = rows.find((row) => row.id === id);
        const changed =
          !old ||
          !!old.deleted ||
          content(JSON.parse(old.payload) as CalendarEvent) !==
            content(candidate.event);
        db.prepare(
          `INSERT INTO exam_tab_events (accountId, id, schoolYearId, payload, revision, createdAt, modifiedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(accountId, id) DO UPDATE SET schoolYearId=excluded.schoolYearId,
           payload=excluded.payload, revision=excluded.revision, modifiedAt=excluded.modifiedAt,
           deleted=0, missingSince=NULL`,
        ).run(
          accountId,
          id,
          feed.schoolYearId,
          JSON.stringify(candidate.event),
          (old?.revision ?? -1) + Number(changed),
          old?.createdAt ?? now,
          changed ? now : old!.modifiedAt,
        );
      }
      for (const row of rows) {
        const old = JSON.parse(row.payload) as CalendarEvent;
        if (
          row.deleted ||
          seen.has(row.id) ||
          !dates.has(old.date) ||
          plan.protectedIds.has(row.id)
        )
          continue;
        // Preserve zero-ID observations and unconfirmed empty dates, just as
        // the normal event store does. Source selection is not deletion proof.
        const trustworthy =
          old.sourceId !== 'exam:0' &&
          incoming.some((item) => item.event.date === old.date) &&
          !ambiguousDates.has(old.date);
        if (!trustworthy) {
          warnings.add('RETAINED_UNCONFIRMED_EVENTS');
          continue;
        }
        if (
          row.missingSince &&
          Date.parse(now) - Date.parse(row.missingSince) >= 60000
        )
          db.prepare(
            'UPDATE exam_tab_events SET deleted=1, revision=revision+1, modifiedAt=?, missingSince=NULL WHERE accountId=? AND id=?',
          ).run(now, accountId, row.id);
        else {
          db.prepare(
            'UPDATE exam_tab_events SET missingSince=COALESCE(missingSince, ?) WHERE accountId=? AND id=?',
          ).run(now, accountId, row.id);
          warnings.add('RETAINED_UNCONFIRMED_EVENTS');
        }
      }
    }
    for (const date of dates) {
      if (ambiguousDates.has(date)) {
        // Keep a previous successful view; otherwise use available timetable data.
        db.prepare(
          'INSERT OR IGNORE INTO exam_source_days (accountId, date, source) VALUES (?, ?, ?)',
        ).run(accountId, date, 'timetable');
      } else {
        db.prepare(
          `INSERT INTO exam_source_days (accountId, date, source) VALUES (?, ?, ?)
          ON CONFLICT(accountId, date) DO UPDATE SET source=excluded.source`,
        ).run(accountId, date, feed.source);
      }
    }
  }
  return [...warnings];
}

/** Select one source per account/day before feed filters and ICS rendering.
 * Unobserved days retain their legacy view until the first source-aware sync. */
export function applyExamSources(db: Db, events: StoredEvent[]): StoredEvent[] {
  const preferences = new Map(
    (
      db.prepare('SELECT id, examSource FROM webuntis_accounts').all() as {
        id: string;
        examSource: ExamSource;
      }[]
    ).map((row) => [row.id, row.examSource]),
  );
  const days = new Map(
    (
      db.prepare('SELECT * FROM exam_source_days').all() as {
        accountId: string;
        date: string;
        source: ExamSource;
      }[]
    ).map((row) => [`${row.accountId}:${row.date}`, row.source]),
  );
  const selected = events.filter((event) => {
    if (event.kind !== 'exam') return true;
    if (preferences.get(event.accountId) === 'timetable')
      return event.category === 'lesson';
    const source = days.get(`${event.accountId}:${event.date}`);
    if (source === 'exams') return false;
    if (source === 'timetable') return event.category === 'lesson';
    return true;
  });
  const rows = db
    .prepare(
      'SELECT * FROM exam_tab_events WHERE deleted = 0 ORDER BY accountId, id',
    )
    .all() as ExamRow[];
  for (const row of rows) {
    const event = JSON.parse(row.payload) as CalendarEvent;
    if (
      preferences.get(row.accountId) !== 'exams' ||
      days.get(`${row.accountId}:${event.date}`) !== 'exams'
    )
      continue;
    selected.push({
      ...event,
      sourceId: row.id,
      sourceIds: [row.id],
      accountId: row.accountId,
      revision: row.revision,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt,
    });
  }
  return selected.sort(
    (left, right) =>
      left.accountId.localeCompare(right.accountId) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}
