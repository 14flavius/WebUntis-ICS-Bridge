import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import {
  normalizeTimetable,
  normalizeRpc,
  normalizeExams,
} from '../src/server/webuntis/normalize.js';
import { context, timetableFixture } from './fixtures/events.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { commitSnapshots } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';

test('REST rooms with identical descriptions keep their distinct numbers in ICS', () => {
  const timetable = structuredClone(timetableFixture);
  timetable.days[0].gridEntries[0].position3 = [
    { current: { type: 'ROOM', shortName: 'r201', longName: 'IT laboratory' } },
    { current: { type: 'ROOM', shortName: 'r202', longName: 'IT laboratory' } },
  ];
  const event = normalizeTimetable(timetable, context)[0];
  expect(event.values.room).toBe('r201, r202');
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const accountId = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    accountId,
    'Test',
    'test',
    'https://test.webuntis.com',
    'test',
    'encrypted',
    context.timezone,
  );
  try {
    const snapshot = {
      category: 'lesson' as const,
      start: event.date,
      end: event.date,
      confirmedEmptyDates: [],
    };
    // A normal sync upgrades old labels without creating duplicate appointments.
    commitSnapshots(db, accountId, [
      {
        ...snapshot,
        events: [
          { ...event, values: { ...event.values, room: 'IT laboratory' } },
        ],
      },
    ]);
    const templates = defaultTemplates('de');
    // Existing feeds may still use the original base-field template.
    templates.lesson.location = '{{room}}';
    const feed = saveFeed(db, {
      name: 'Rooms',
      enabled: true,
      pastDays: 14,
      futureDays: 90,
      language: 'de',
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['lesson'] }],
      templates,
    });
    const now = new Date('2026-10-20T05:00:00Z');
    const parse = () =>
      new ICAL.Component(
        ICAL.parse(generateCalendar(db, feed, now).body),
      ).getAllSubcomponents('vevent');
    const before = parse()[0];
    commitSnapshots(db, accountId, [{ ...snapshot, events: [event] }]);
    const after = parse();
    expect(after).toHaveLength(1);
    expect(after[0].getFirstPropertyValue('uid')).toBe(
      before.getFirstPropertyValue('uid'),
    );
    expect(after[0].getFirstPropertyValue('location')).toBe('r201, r202');
    expect(after[0].getFirstPropertyValue('sequence')).toBe(1);
    commitSnapshots(db, accountId, [{ ...snapshot, events: [event] }]);
    expect(parse()[0].getFirstPropertyValue('sequence')).toBe(1);
  } finally {
    db.close();
  }
});

test('REST room labels fall back to display name or description when a number is absent', () => {
  const timetable = structuredClone(timetableFixture);
  timetable.days[0].gridEntries[0].position3 = [
    {
      current: {
        type: 'ROOM',
        shortName: '',
        displayName: 'Gym West',
        longName: 'Sports hall',
      },
    },
    { current: { type: 'ROOM', longName: 'Assembly hall' } },
  ];
  expect(normalizeTimetable(timetable, context)[0].values.room).toBe(
    'Gym West, Assembly hall',
  );
});

test('RPC lessons and separate exams preserve room numbers while retaining other long names', () => {
  const rpc = normalizeRpc(
    [
      {
        id: 201,
        date: 20261020,
        startTime: 800,
        endTime: 845,
        su: [{ id: 1, name: 'MA', longname: 'Mathematics' }],
        te: [{ id: 2, name: 'TA', longname: 'Teacher A' }],
        ro: [
          { id: 3, name: 'r201', longname: 'Laboratory' },
          { id: 4, longname: 'Gym' },
        ],
      },
    ],
    context,
  )[0];
  expect(rpc.values).toMatchObject({
    room: 'r201, Gym',
    subject: 'Mathematics',
    teacher: 'Teacher A',
  });
  const exam = normalizeExams(
    [
      {
        id: 301,
        name: 'Assessment',
        examDate: 20261020,
        rooms: [
          { name: 'r202', longName: 'Laboratory' },
          { longName: 'Gym' },
          'Annex',
        ],
        teachers: [{ name: 'TA', longName: 'Teacher A' }],
      },
    ],
    context,
  )[0];
  expect(exam.values).toMatchObject({
    room: 'r202, Gym, Annex',
    teacher: 'Teacher A',
  });
});
