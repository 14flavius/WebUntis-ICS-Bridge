import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { Snapshot } from '../src/shared/events.js';
import {
  normalizeRpc,
  normalizeTimetable,
} from '../src/server/webuntis/normalize.js';
import { refreshStoredLabels } from '../src/server/webuntis/stored-labels.js';
import { context, timetableFixture } from './fixtures/events.js';
import {
  identityDatabase,
  identityAccount,
  examSnapshots,
  separateExam,
} from './fixtures/exam-identity.js';

function legacyLesson(exam = false) {
  const data = structuredClone(timetableFixture);
  const entry = data.days[0].gridEntries[0];
  entry.type = exam ? 'EXAM' : 'NORMAL_TEACHING_PERIOD';
  entry.position3 = [
    { current: { type: 'ROOM', shortName: 'R101', longName: 'Staff A' } },
  ];
  entry.position4 = [
    { current: { type: 'CLASS', shortName: 'C10', longName: 'Staff B' } },
  ];
  if (exam)
    entry.examDetails = {
      name: 'Algebra test',
      typeLongName: 'Written assessment',
    };
  const event = normalizeTimetable(data, context)[0];
  return {
    ...event,
    values: {
      ...event.values,
      room: 'Staff A',
      class: 'Staff B',
      examType: exam ? 'W' : '',
    },
  };
}

test('room and class identifiers are consistent for new REST/RPC and historical sources', () => {
  const old = legacyLesson();
  const corrected = refreshStoredLabels(old);
  expect(corrected.values).toMatchObject({ room: 'R101', class: 'C10' });
  expect(old.values.room).toBe('Staff A');
  expect(refreshStoredLabels(corrected)).toBe(corrected);
  const rpc = {
    id: 501,
    date: 20261020,
    startTime: 800,
    endTime: 845,
    su: [{ id: 1, name: 'Math', longname: 'Mathematics' }],
    te: [{ id: 2, name: 'TA', longname: 'Teacher A' }],
    ro: [{ id: 3, name: 'R101', longname: 'Staff A' }],
    kl: [{ id: 4, name: 'C10', longname: 'Staff B' }],
  };
  const fresh = normalizeRpc([rpc], context)[0];
  expect(fresh.values).toMatchObject({
    room: 'R101',
    class: 'C10',
    teacher: 'Teacher A',
    subject: 'Mathematics',
  });
  expect(
    refreshStoredLabels({ ...fresh, values: old.values }).values,
  ).toMatchObject({ room: 'R101', class: 'C10' });
  const incomplete = { ...old, source: '{}' };
  expect(refreshStoredLabels(incomplete)).toBe(incomplete);
});

test('inaccessible cached lessons refresh labels once without changing identity, timing, missing state or lesson coverage', () => {
  const db = identityDatabase();
  const accountId = identityAccount(db);
  try {
    const old = legacyLesson();
    const initialTime = '2026-10-20T05:00:00.000Z';
    const initial: Snapshot = {
      category: 'lesson',
      start: old.date,
      end: old.date,
      events: [old],
      confirmedEmptyDates: [],
    };
    commitSnapshots(db, accountId, [initial], initialTime);
    db.prepare('UPDATE events SET missingSince = ? WHERE accountId = ?').run(
      initialTime,
      accountId,
    );
    const before = storedEvents(db)[0];
    const templates = defaultTemplates('en');
    templates.lesson.location = '{{room}}';
    const feed = saveFeed(db, {
      name: 'Labels',
      enabled: true,
      pastDays: 14,
      futureDays: 90,
      language: 'en',
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['lesson'] }],
      templates,
    });
    const beforeCalendar = generateCalendar(db, feed, new Date(initialTime));
    // Only the exam endpoint is readable. This must not certify lesson coverage.
    const readOnlyWindow: Snapshot = {
      category: 'exam',
      start: old.date,
      end: old.date,
      events: [],
      confirmedEmptyDates: [],
    };
    commitSnapshots(
      db,
      accountId,
      [readOnlyWindow],
      '2026-10-20T05:01:00.000Z',
    );
    const after = storedEvents(db)[0];
    expect(after).toEqual({
      ...before,
      values: { ...before.values, room: 'R101', class: 'C10' },
      revision: before.revision + 1,
      modifiedAt: '2026-10-20T05:01:00.000Z',
    });
    expect(
      db
        .prepare('SELECT missingSince FROM events WHERE accountId = ?')
        .get(accountId),
    ).toEqual({ missingSince: initialTime });
    expect(
      db
        .prepare(
          "SELECT checkedAt FROM sync_coverage WHERE accountId = ? AND category = 'lesson'",
        )
        .get(accountId),
    ).toEqual({ checkedAt: initialTime });
    const now = new Date('2026-10-20T05:01:00Z');
    const corrected = generateCalendar(db, feed, now);
    const parse = (body: string) =>
      new ICAL.Component(ICAL.parse(body)).getFirstSubcomponent('vevent')!;
    expect(parse(corrected.body).getFirstPropertyValue('uid')).toBe(
      parse(beforeCalendar.body).getFirstPropertyValue('uid'),
    );
    expect(parse(corrected.body).getFirstPropertyValue('location')).toBe(
      'R101',
    );
    expect(parse(corrected.body).getFirstPropertyValue('sequence')).toBe(1);
    commitSnapshots(
      db,
      accountId,
      [readOnlyWindow],
      '2026-10-20T05:02:00.000Z',
    );
    expect(storedEvents(db)).toEqual([after]);
    expect(generateCalendar(db, feed, now).body).toBe(corrected.body);
  } finally {
    db.close();
  }
});

test('cached exam reconciliation refreshes labels and keeps detailed type without adding a second event', () => {
  const db = identityDatabase();
  const accountId = identityAccount(db);
  try {
    const old = legacyLesson(true);
    commitSnapshots(db, accountId, [
      {
        category: 'lesson',
        start: old.date,
        end: old.date,
        events: [old],
        confirmedEmptyDates: [],
      },
    ]);
    const exam = separateExam({ endTime: 845, examType: 'W', rooms: ['R101'] });
    const snapshots = examSnapshots([exam]);
    commitSnapshots(db, accountId, snapshots);
    const after = storedEvents(db);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      sourceId: old.sourceId,
      category: 'lesson',
      values: { room: 'R101', class: 'C10', examType: 'Written assessment' },
    });
    commitSnapshots(db, accountId, snapshots);
    const comparable = (events: ReturnType<typeof storedEvents>) =>
      events.map((event) => ({
        ...event,
        source: JSON.parse(event.source) as unknown,
      }));
    expect(comparable(storedEvents(db))).toEqual(comparable(after));
  } finally {
    db.close();
  }
});

test('label refresh does not alter records outside the requested window or another account', () => {
  const db = identityDatabase();
  const accountId = identityAccount(db);
  const otherAccount = identityAccount(db);
  try {
    const old = legacyLesson();
    const initial: Snapshot = {
      category: 'lesson',
      start: old.date,
      end: old.date,
      events: [old],
      confirmedEmptyDates: [],
    };
    commitSnapshots(db, accountId, [initial]);
    commitSnapshots(db, otherAccount, [initial]);
    const before = storedEvents(db);
    commitSnapshots(db, accountId, [
      {
        category: 'exam',
        start: '2026-11-01',
        end: '2026-11-07',
        events: [],
        confirmedEmptyDates: [],
      },
    ]);
    expect(storedEvents(db)).toEqual(before);
    commitSnapshots(db, accountId, [
      {
        category: 'exam',
        start: old.date,
        end: old.date,
        events: [],
        confirmedEmptyDates: [],
      },
    ]);
    expect(
      storedEvents(db).find((event) => event.accountId === otherAccount),
    ).toEqual(before.find((event) => event.accountId === otherAccount));
  } finally {
    db.close();
  }
});
