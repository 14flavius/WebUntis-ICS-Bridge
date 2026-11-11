import { afterEach, beforeEach, expect, test } from 'vitest';
import ICAL from 'ical.js';
import Fastify from 'fastify';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { applyExamSources } from '../src/server/exam-feeds.js';
import { generateCalendar, selectedEvents } from '../src/server/ics.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { CalendarEvent, Snapshot } from '../src/shared/events.js';
import type { Db } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { systemRoutes } from '../src/server/routes/system.js';
import { SyncService } from '../src/server/sync.js';
import { testConfig, actAsTestUser } from './helpers.js';
import {
  identityDatabase,
  identityAccount,
  separateExam,
  timetableExam,
  examSnapshots,
} from './fixtures/exam-identity.js';
import { lessonFixture } from './fixtures/events.js';

let db: Db;
let accountId: string;
const date = '2026-10-20';
const now = new Date('2026-10-20T05:00:00Z');
beforeEach(() => {
  db = identityDatabase();
  accountId = identityAccount(db);
});
afterEach(() => db.close());

function snapshots(
  exams: CalendarEvent[],
  options: {
    source?: 'exams' | 'timetable';
    lessons?: CalendarEvent[];
    dates?: string[];
  } = {},
): Snapshot[] {
  const source = options.source ?? 'exams';
  const result = examSnapshots(source === 'exams' ? exams : [], {
    lessons: options.lessons ?? [timetableExam()],
    start: date,
    end: date,
  });
  const snapshot = result.find((item) => item.category === 'exam')!;
  snapshot.deletionCoverage = source === 'exams';
  snapshot.examFeed = {
    source,
    dates: options.dates ?? [date],
    events: exams,
    schoolYearId: '2026',
  };
  return result;
}
function visible() {
  return applyExamSources(db, storedEvents(db));
}
function choose(source: 'exams' | 'timetable', id = accountId) {
  db.prepare('UPDATE webuntis_accounts SET examSource=? WHERE id=?').run(
    source,
    id,
  );
}

test('one tab exam replaces two timetable sections; switching and fallback never combine them', () => {
  const first = {
    ...timetableExam(),
    sourceId: 'lesson:101',
    sourceIds: ['lesson:101'],
    end: '2026-10-20T06:45:00.000Z',
  };
  const second = {
    ...first,
    sourceId: 'lesson:102',
    sourceIds: ['lesson:102'],
    start: first.end,
    end: '2026-10-20T07:30:00.000Z',
    values: { ...first.values, room: '202' },
  };
  const lessons = [first, second];
  const data = snapshots([separateExam()], { lessons });
  expect(commitSnapshots(db, accountId, data).warnings).toEqual([]);
  expect(visible()).toHaveLength(1);
  expect(visible()[0]).toMatchObject({
    start: first.start,
    end: second.end,
    category: 'exam',
    revision: 0,
  });
  const feed = saveFeed(db, {
    name: 'Exams',
    enabled: true,
    pastDays: 10,
    futureDays: 30,
    language: 'en',
    cancellation: 'mark',
    sources: [{ accountId, kinds: ['exam'] }],
    templates: defaultTemplates('en'),
  });
  const original = generateCalendar(db, feed, now);
  const parsed = new ICAL.Component(
    ICAL.parse(original.body),
  ).getAllSubcomponents('vevent');
  expect(parsed).toHaveLength(1);
  expect(new ICAL.Event(parsed[0]).endDate.toJSDate().toISOString()).toBe(
    second.end,
  );
  const uid = parsed[0].getFirstPropertyValue('uid');
  expect(selectedEvents(db, feed, now)).toEqual(visible());

  choose('timetable');
  expect(visible().map((event) => event.sourceId)).toEqual([
    'lesson:101',
    'lesson:102',
  ]);
  expect(generateCalendar(db, feed, now).etag).not.toBe(original.etag);
  commitSnapshots(
    db,
    accountId,
    snapshots([], { source: 'timetable', lessons }),
  );
  choose('exams');
  // A successful retry is needed before the stored tab view becomes active again.
  expect(visible()).toHaveLength(2);
  commitSnapshots(db, accountId, data);
  expect(generateCalendar(db, feed, now).body).toBe(original.body);
  expect(
    new ICAL.Component(ICAL.parse(original.body))
      .getFirstSubcomponent('vevent')!
      .getFirstPropertyValue('uid'),
  ).toBe(uid);
  commitSnapshots(
    db,
    accountId,
    snapshots([], { source: 'timetable', lessons }),
  );
  expect(visible()).toHaveLength(2);
  commitSnapshots(db, accountId, data);
  expect(generateCalendar(db, feed, now).body).toBe(original.body);
});

test('two accounts choose independently and normal lessons remain unaffected', () => {
  const other = identityAccount(db);
  const normal = {
    ...lessonFixture(),
    sourceId: 'lesson:200',
    sourceIds: ['lesson:200'],
  };
  for (const id of [accountId, other])
    commitSnapshots(
      db,
      id,
      snapshots([separateExam()], { lessons: [timetableExam(), normal] }),
    );
  choose('timetable', other);
  expect(
    visible()
      .filter((event) => event.kind === 'exam')
      .map((event) => [event.accountId, event.category]),
  ).toEqual(
    expect.arrayContaining([
      [accountId, 'exam'],
      [other, 'lesson'],
    ]),
  );
  expect(visible()).toHaveLength(4);
  const feed = {
    name: 'One',
    enabled: true,
    pastDays: 10,
    futureDays: 30,
    language: 'en' as const,
    cancellation: 'mark' as const,
    sources: [{ accountId: other, kinds: ['exam' as const] }],
    templates: defaultTemplates('en'),
  };
  expect(selectedEvents(db, feed, now)).toHaveLength(1);
  expect(selectedEvents(db, feed, now)[0]).toMatchObject({
    accountId: other,
    category: 'lesson',
  });
});

test('empty successful tabs do not silently publish timetable exams; failed tabs do', () => {
  commitSnapshots(db, accountId, snapshots([]));
  expect(visible()).toEqual([]);
  commitSnapshots(db, accountId, snapshots([], { source: 'timetable' }));
  expect(visible()).toHaveLength(1);
  expect(visible()[0].category).toBe('lesson');
});

test('dashboard counts use the selected source instead of hidden cached exams', async () => {
  const first = {
    ...timetableExam(),
    sourceId: 'lesson:101',
    sourceIds: ['lesson:101'],
    end: '2026-10-20T06:45:00.000Z',
  };
  const second = {
    ...first,
    sourceId: 'lesson:102',
    sourceIds: ['lesson:102'],
    start: first.end,
    end: '2026-10-20T07:30:00.000Z',
  };
  commitSnapshots(
    db,
    accountId,
    snapshots([separateExam()], { lessons: [first, second] }),
  );
  const app = Fastify();
  actAsTestUser(app, db);
  const sync = new SyncService(db, testConfig());
  systemRoutes(app, db, sync);
  try {
    expect((await app.inject('/api/status')).json()).toMatchObject({
      events: 3,
    });
    choose('timetable');
    expect((await app.inject('/api/status')).json()).toMatchObject({
      events: 4,
    });
    choose('exams');
    expect((await app.inject('/api/status')).json()).toMatchObject({
      events: 3,
    });
  } finally {
    await sync.stop();
    await app.close();
  }
});

test('inaccessible fallback dates keep the last successful exam view', () => {
  commitSnapshots(db, accountId, snapshots([separateExam()]));
  const previous = visible();
  commitSnapshots(
    db,
    accountId,
    snapshots([], { source: 'timetable', dates: [], lessons: [] }),
  );
  expect(visible()).toEqual(previous);
});

test('zero IDs, reordering, native ID changes and renames preserve distinct tab identities', () => {
  const exams = [
    separateExam(),
    separateExam({ name: 'Physics exam', subject: 'Physics' }),
  ];
  commitSnapshots(db, accountId, snapshots(exams));
  const initial = visible();
  expect(initial).toHaveLength(2);
  expect(new Set(initial.map((event) => event.sourceId)).size).toBe(2);
  commitSnapshots(db, accountId, snapshots([...exams].reverse()));
  expect(visible()).toEqual(initial);
  const mathId = initial.find(
    (event) => event.values.subject === 'Math',
  )!.sourceId;
  commitSnapshots(
    db,
    accountId,
    snapshots([separateExam({ id: 90, name: 'Renamed algebra' }), exams[1]]),
  );
  expect(
    visible().find((event) => event.values.subject === 'Math'),
  ).toMatchObject({ sourceId: mathId, revision: 1 });
  commitSnapshots(
    db,
    accountId,
    snapshots([separateExam({ name: 'Renamed algebra' }), exams[1]]),
  );
  expect(visible()).toHaveLength(2);
  expect(
    visible().find((event) => event.values.subject === 'Math')!.sourceId,
  ).toBe(mathId);
});

test('ambiguous zero-ID observations preserve the prior view without producing extra events', () => {
  commitSnapshots(db, accountId, snapshots([separateExam()]));
  const previous = visible();
  const result = commitSnapshots(
    db,
    accountId,
    snapshots([separateExam(), separateExam({ name: 'Other title' })]),
  );
  expect(result.warnings).toContain('EXAMS_AMBIGUOUS');
  expect(visible()).toEqual(previous);
});

test('empty observations retain previous tab events; native removals require two trustworthy checks', () => {
  const first = separateExam({ id: 1 });
  const other = separateExam({
    id: 2,
    name: 'Physics exam',
    subject: 'Physics',
  });
  commitSnapshots(db, accountId, snapshots([first, other]), now.toISOString());
  expect(
    commitSnapshots(db, accountId, snapshots([]), '2026-10-20T05:01:00Z')
      .warnings,
  ).toContain('RETAINED_UNCONFIRMED_EVENTS');
  expect(visible()).toHaveLength(2);
  commitSnapshots(db, accountId, snapshots([other]), '2026-10-20T05:02:00Z');
  expect(visible()).toHaveLength(2);
  commitSnapshots(db, accountId, snapshots([other]), '2026-10-20T05:03:00Z');
  expect(visible()).toHaveLength(1);
  expect(visible()[0].values.subject).toBe('Physics');
});

test('invalid source publication rolls back events, source dates and identities atomically', () => {
  const before = storedEvents(db);
  const invalid = snapshots([separateExam()]);
  invalid.at(-1)!.examFeed!.dates = ['2026-10-21'];
  expect(() => commitSnapshots(db, accountId, invalid)).toThrow();
  expect(storedEvents(db)).toEqual(before);
  expect(db.prepare('SELECT * FROM exam_tab_events').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM exam_source_days').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM exam_identities').all()).toEqual([]);
});

test('migration preserves existing accounts and events, defaults the preference and is repeatable', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const previous = storedEvents(db);
  // Reconstruct the preceding schema in this disposable in-memory database.
  db.exec(
    'DROP TABLE exam_tab_events; DROP TABLE exam_source_days; ALTER TABLE webuntis_accounts DROP COLUMN examSource; DELETE FROM schema_migrations WHERE version=105',
  );
  migrateApplication(db);
  migrateApplication(db);
  expect(
    db
      .prepare('SELECT examSource FROM webuntis_accounts WHERE id=?')
      .get(accountId),
  ).toEqual({ examSource: 'exams' });
  expect(visible()).toEqual(previous);
  commitSnapshots(db, accountId, snapshots([separateExam()]));
  db.prepare('DELETE FROM webuntis_accounts WHERE id=?').run(accountId);
  expect(db.prepare('SELECT * FROM exam_tab_events').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM exam_source_days').all()).toEqual([]);
});
