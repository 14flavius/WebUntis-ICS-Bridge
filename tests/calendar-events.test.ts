import { afterEach, beforeEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import ICAL from 'ical.js';
import { calendarEvents } from '../src/server/calendar-events.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import {
  eventUid,
  generateCalendar,
  selectedEvents,
} from '../src/server/ics.js';
import { feedRoutes } from '../src/server/routes/feeds.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates, type Feed } from '../src/shared/feeds.js';
import type {
  CalendarEvent,
  EventKind,
  Snapshot,
} from '../src/shared/events.js';
import type { Db } from '../src/server/db.js';
import { normalizeTimetable } from '../src/server/webuntis/normalize.js';
import {
  identityAccount,
  identityDatabase,
  separateExam,
} from './fixtures/exam-identity.js';
import { examTimetableFixture } from './fixtures/timetable-exams.js';
import { context } from './fixtures/events.js';
import { actAsTestUser } from './helpers.js';

let db: Db;
let accountId: string;
let feed: Feed;
const date = '2026-10-20';
const now = new Date(`${date}T05:00:00Z`);
beforeEach(() => {
  db = identityDatabase();
  accountId = identityAccount(db);
  feed = saveFeed(db, {
    name: 'Combined',
    enabled: true,
    pastDays: 365,
    futureDays: 365,
    language: 'de',
    cancellation: 'mark',
    sources: [{ accountId, kinds: ['lesson', 'substitution', 'exam'] }],
    templates: defaultTemplates('de'),
  });
});
afterEach(() => db.close());

function timetable(status = 'REGULAR', type = 'EXAM') {
  const data = examTimetableFixture();
  const entry = data.days[0].gridEntries[0];
  entry.status = status;
  entry.type = type;
  entry.name = 'Algebra';
  entry.position3 = [{ current: { type: 'TEACHER', shortName: 'TA' } }];
  entry.position4 = [{ current: { type: 'CLASS', shortName: 'C10' } }];
  return normalizeTimetable(data, context);
}
function commit(
  lessons: CalendarEvent[],
  source: 'exams' | 'timetable' = 'timetable',
  exams: CalendarEvent[] = [],
) {
  const range = { start: date, end: date, confirmedEmptyDates: [] };
  const snapshots: Snapshot[] = [
    { ...range, category: 'lesson', events: lessons },
    {
      ...range,
      category: 'exam',
      events: [],
      examFeed: { source, dates: [date], events: exams, schoolYearId: '2026' },
    },
  ];
  commitSnapshots(db, accountId, snapshots);
}
function parse(kinds: EventKind[]) {
  const config = { ...feed, sources: [{ accountId, kinds }] };
  const output = generateCalendar(db, config, now);
  return {
    output,
    events: new ICAL.Component(ICAL.parse(output.body)).getAllSubcomponents(
      'vevent',
    ),
  };
}

test('lesson and exam filters independently control ICS and preview without changing the stored event', async () => {
  commit(timetable());
  const stored = storedEvents(db);
  const app = Fastify();
  actAsTestUser(app, db);
  feedRoutes(app, db);
  try {
    const lesson = parse(['lesson']).events;
    const exam = parse(['exam']).events;
    const combined = parse(['lesson', 'exam']);
    expect(lesson).toHaveLength(1);
    expect(exam).toHaveLength(1);
    expect(combined.events).toHaveLength(2);
    expect(lesson[0].getFirstPropertyValue('summary')).toBe('Math · TA (C10)');
    expect(exam[0].getFirstPropertyValue('summary')).toBe(
      'Algebra · Math · TA (C10)',
    );
    const uids = combined.events.map((event) =>
      event.getFirstPropertyValue('uid'),
    );
    expect(new Set(uids).size).toBe(2);
    expect(uids).toContain(lesson[0].getFirstPropertyValue('uid'));
    expect(uids).toContain(exam[0].getFirstPropertyValue('uid'));
    for (const event of combined.events) {
      expect(event.getFirstPropertyValue('location')).toBe('101');
      expect(event.getFirstPropertyValue('description')).toContain(
        'Klasse: C10',
      );
      expect(new ICAL.Event(event).startDate.toJSDate().toISOString()).toBe(
        stored[0].start,
      );
      expect(new ICAL.Event(event).endDate.toJSDate().toISOString()).toBe(
        stored[0].end,
      );
    }
    for (const kinds of [
      ['lesson'],
      ['exam'],
      ['lesson', 'exam'],
    ] as EventKind[][]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/preview',
        payload: { ...feed, sources: [{ accountId, kinds }] },
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<{ kind: EventKind }[]>()
          .map((event) => event.kind)
          .sort(),
      ).toEqual([...kinds].sort());
    }
    expect(parse(['lesson', 'exam']).output).toEqual(combined.output);
    expect(storedEvents(db)).toEqual(stored);
  } finally {
    await app.close();
  }
});

test('exam source changes affect only assessments while both timetable sections keep their teaching identities', () => {
  const original = timetable()[0];
  const first = {
    ...original,
    sourceIds: ['lesson:101'],
    end: '2026-10-20T06:45:00.000Z',
  };
  const second = {
    ...original,
    sourceId: 'lesson:102',
    sourceIds: ['lesson:102'],
    start: first.end,
  };
  commit([first, second], 'exams', [separateExam({ id: 90 })]);
  expect(parse(['lesson']).events).toHaveLength(2);
  expect(parse(['exam']).events).toHaveLength(1);
  expect(parse(['lesson', 'exam']).events).toHaveLength(3);
  const lessonsBefore = parse(['lesson']).output;
  const examBefore = parse(['exam']).output;
  db.prepare('UPDATE webuntis_accounts SET examSource=? WHERE id=?').run(
    'timetable',
    accountId,
  );
  expect(parse(['exam']).events).toHaveLength(2);
  expect(parse(['lesson', 'exam']).events).toHaveLength(4);
  expect(parse(['lesson']).output).toEqual(lessonsBefore);
  db.prepare('UPDATE webuntis_accounts SET examSource=? WHERE id=?').run(
    'exams',
    accountId,
  );
  expect(parse(['exam']).output).toEqual(examBefore);
  expect(parse(['lesson']).output).toEqual(lessonsBefore);
});

test('a successful empty exam view keeps teaching; standalone exams never invent teaching', () => {
  commit(timetable(), 'exams');
  expect(parse(['exam']).events).toHaveLength(0);
  expect(parse(['lesson']).events).toHaveLength(1);
  const other = identityAccount(db);
  commitSnapshots(db, other, [
    {
      category: 'exam',
      start: date,
      end: date,
      events: [],
      confirmedEmptyDates: [],
      examFeed: {
        source: 'exams',
        dates: [date],
        events: [separateExam({ id: 90 })],
        schoolYearId: '2026',
      },
    },
  ]);
  const otherEvents = calendarEvents(db).filter(
    (event) => event.accountId === other,
  );
  expect(otherEvents).toHaveLength(1);
  expect(otherEvents[0].kind).toBe('exam');
});

test('teaching UID survives exam classification and cancellation; substitutions retain their filter and teacher', () => {
  commit(timetable('REGULAR', 'NORMAL_TEACHING_PERIOD'));
  const original = selectedEvents(db, feed, now)[0];
  const uid = eventUid(feed.id, original);
  commit(timetable());
  expect(calendarEvents(db)).toHaveLength(2);
  expect(parse(['lesson']).events[0].getFirstPropertyValue('uid')).toBe(uid);
  commit(timetable('CHANGED'));
  expect(parse(['lesson']).events).toHaveLength(0);
  const substitution = parse(['substitution']).events;
  expect(substitution).toHaveLength(1);
  expect(substitution[0].getFirstPropertyValue('uid')).toBe(uid);
  expect(substitution[0].getFirstPropertyValue('summary')).toBe(
    'Vertretung · Math · TA (C10)',
  );
  commit(timetable('CANCELLED'));
  expect(parse(['exam']).events).toHaveLength(0);
  expect(parse(['cancelled']).events[0].getFirstPropertyValue('uid')).toBe(uid);
  commit(timetable('REGULAR', 'NORMAL_TEACHING_PERIOD'));
  expect(calendarEvents(db)).toHaveLength(1);
  expect(parse(['lesson']).events[0].getFirstPropertyValue('uid')).toBe(uid);
});
