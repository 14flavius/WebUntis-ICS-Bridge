import { expect, test } from 'vitest';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import {
  normalizeTimetable,
  normalizeHolidays,
  normalizeExams,
} from '../src/server/webuntis/normalize.js';
import { windows } from '../src/server/webuntis/snapshot.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import type { Snapshot } from '../src/shared/events.js';
import { timetableFixture, context, lessonFixture } from './fixtures/events.js';

function database() {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'account',
    'Student A',
    'school',
    'https://school.webuntis.com',
    'student',
    'encrypted',
    context.timezone,
  );
  return db;
}
function snapshot(
  events = [lessonFixture()],
  confirmedEmptyDates: string[] = [],
): Snapshot {
  return {
    category: 'lesson',
    start: '2026-10-20',
    end: '2026-10-20',
    events,
    confirmedEmptyDates,
  };
}
test('stable identity and revisions, repeat sync, atomic conflict rejection', () => {
  const db = database();
  commitSnapshots(db, 'account', [snapshot()], '2026-10-20T06:00:00.000Z');
  const initial = storedEvents(db)[0];
  commitSnapshots(db, 'account', [snapshot()], '2026-10-20T06:01:00.000Z');
  expect(storedEvents(db)).toEqual([initial]);
  const changed = lessonFixture();
  changed.values.room = '204';
  changed.kind = 'cancelled';
  commitSnapshots(
    db,
    'account',
    [snapshot([changed])],
    '2026-10-20T06:02:00.000Z',
  );
  expect(storedEvents(db)[0].sourceId).toBe(initial.sourceId);
  expect(storedEvents(db)[0].revision).toBe(1);
  expect(() =>
    commitSnapshots(db, 'account', [snapshot([changed, lessonFixture()])]),
  ).toThrow();
  expect(storedEvents(db)[0].kind).toBe('cancelled');
  db.close();
});
test('empty answers retain data; explicit absence needs two observations; tombstones preserve revision', () => {
  const db = database();
  commitSnapshots(db, 'account', [snapshot()], '2026-10-20T06:00:00.000Z');
  for (const stamp of ['06:01', '06:02'])
    commitSnapshots(
      db,
      'account',
      [snapshot([])],
      `2026-10-20T${stamp}:00.000Z`,
    );
  expect(storedEvents(db)).toHaveLength(1);
  commitSnapshots(
    db,
    'account',
    [snapshot([], ['2026-10-20'])],
    '2026-10-20T06:03:00.000Z',
  );
  expect(storedEvents(db)).toHaveLength(1);
  commitSnapshots(
    db,
    'account',
    [snapshot([], ['2026-10-20'])],
    '2026-10-20T06:04:00.000Z',
  );
  expect(storedEvents(db)).toHaveLength(0);
  commitSnapshots(db, 'account', [snapshot()], '2026-10-20T06:05:00.000Z');
  expect(storedEvents(db)[0].revision).toBe(2);
  db.close();
});
test('substitutions, timezone offsets, all-day exclusive end, structured exams', () => {
  const data = structuredClone(timetableFixture);
  data.days[0].gridEntries[0].position2 = [
    {
      current: { type: 'TEACHER', shortName: 'Teacher B' },
      removed: { type: 'TEACHER', shortName: 'Teacher A' },
    },
  ];
  const event = normalizeTimetable(data, context)[0];
  expect(event.kind).toBe('substitution');
  expect(event.values.originalTeacher).toBe('Teacher A');
  expect(event.start).toBe('2026-10-20T06:00:00.000Z');
  expect(event.sourceId).toBe(lessonFixture().sourceId);
  const holiday = {
    id: 1,
    name: 'Holiday',
    startDate: 20261023,
    endDate: 20261025,
  };
  const holidays = normalizeHolidays([holiday, { ...holiday, id: 2 }], context);
  expect(holidays).toHaveLength(1);
  expect(holidays[0].end).toBe('2026-10-26');
  const db = database();
  const holidaySnapshot = (events: typeof holidays): Snapshot => ({
    category: 'holiday',
    start: '2026-10-20',
    end: '2026-10-31',
    events,
    confirmedEmptyDates: [],
  });
  commitSnapshots(db, 'account', [holidaySnapshot(holidays)]);
  commitSnapshots(db, 'account', [
    holidaySnapshot(
      normalizeHolidays([{ ...holiday, id: 2 }, holiday], context),
    ),
  ]);
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0].sourceId).toBe('holiday:1');
  expect(storedEvents(db)[0].revision).toBe(0);
  db.close();
  expect(
    normalizeExams([{ id: 8, name: 'Test', examDate: 20261020 }], context)[0]
      .allDay,
  ).toBe(true);
  expect(() =>
    normalizeExams(
      [{ id: 8, name: 'Test', examDate: 20261020, startTime: 800 }],
      context,
    ),
  ).toThrow();
});
test('schoolyear boundaries split windows; missing years fail closed', () => {
  const years = [
    { id: 1, dateRange: { start: '2025-08-01', end: '2026-07-31' } },
    { id: 2, dateRange: { start: '2026-08-01', end: '2027-07-31' } },
  ];
  expect(windows('2026-07-30', '2026-08-03', years)).toEqual([
    { start: '2026-07-30', end: '2026-07-31', yearId: '1' },
    { start: '2026-08-01', end: '2026-08-03', yearId: '2' },
  ]);
  expect(() => windows('2028-01-01', '2028-01-02', years)).toThrow();
});
test('adjacent lessons with different statuses remain distinct', () => {
  const data = structuredClone(timetableFixture);
  const second = structuredClone(data.days[0].gridEntries[0]);
  second.ids = [102];
  second.status = 'CANCELLED';
  second.duration = {
    start: '2026-10-20T08:45:00',
    end: '2026-10-20T09:30:00',
  };
  data.days[0].gridEntries.push(second);
  expect(normalizeTimetable(data, context).map((event) => event.kind)).toEqual([
    'lesson',
    'cancelled',
  ]);
});

test('persisted identities survive block reorder, changed representative, splitting and merging', () => {
  const db = database();
  const block = lessonFixture();
  block.sourceIds = ['lesson:101', 'lesson:102'];
  commitSnapshots(db, 'account', [snapshot([block])]);
  const smaller = {
    ...block,
    sourceId: 'lesson:102',
    sourceIds: ['lesson:102'],
  };
  commitSnapshots(db, 'account', [snapshot([smaller])]);
  expect(storedEvents(db).map((event) => event.sourceId)).toEqual([
    'lesson:101',
  ]);
  const first = { ...block, sourceIds: ['lesson:101'] };
  commitSnapshots(db, 'account', [snapshot([first, smaller])]);
  expect(storedEvents(db)).toHaveLength(2);
  commitSnapshots(db, 'account', [snapshot([block])]);
  expect(storedEvents(db).map((event) => event.sourceId)).toEqual([
    'lesson:101',
  ]);
  expect(() =>
    commitSnapshots(db, 'account', [snapshot([block, smaller])]),
  ).toThrow();
  expect(storedEvents(db)).toHaveLength(1);
  db.close();
});

test('DST changes retain correct instants and ambiguous/nonexistent local times fail closed', () => {
  const data = structuredClone(timetableFixture);
  data.days[0].date = '2026-11-02';
  data.days[0].gridEntries[0].duration = {
    start: '2026-11-02T08:00:00',
    end: '2026-11-02T08:45:00',
  };
  expect(normalizeTimetable(data, context)[0].start).toBe(
    '2026-11-02T07:00:00.000Z',
  );
  for (const date of ['2026-03-29', '2026-10-25']) {
    data.days[0].date = date;
    data.days[0].gridEntries[0].duration = {
      start: `${date}T02:15:00`,
      end: `${date}T02:45:00`,
    };
    expect(() => normalizeTimetable(data, context)).toThrow();
  }
  data.days[0].gridEntries[0].duration = {
    start: '2026-10-25T02:15:00+01:00',
    end: '2026-10-25T02:45:00+01:00',
  };
  expect(normalizeTimetable(data, context)[0].start).toBe(
    '2026-10-25T01:15:00.000Z',
  );
});
