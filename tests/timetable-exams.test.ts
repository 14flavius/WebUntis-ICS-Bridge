import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import { examTimetableFixture } from './fixtures/timetable-exams.js';
import { context } from './fixtures/events.js';
import {
  normalizeTimetable,
  normalizeExams,
} from '../src/server/webuntis/normalize.js';
import { reconcileExams } from '../src/server/webuntis/exams.js';
import { timetableSchema } from '../src/server/webuntis/schemas.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { CalendarEvent, Snapshot } from '../src/shared/events.js';
import { isCapabilityFailure } from '../src/shared/capabilities.js';

function exam() {
  return normalizeExams(
    [
      {
        id: 501,
        name: 'Algebra test',
        subject: 'Math',
        examDate: 20261020,
        startTime: 800,
        endTime: 930,
        text: 'Bring a calculator',
      },
    ],
    context,
  )[0];
}
function snapshot(
  category: Snapshot['category'],
  events: CalendarEvent[],
): Snapshot {
  return {
    category,
    events,
    start: '2026-10-20',
    end: '2026-10-20',
    confirmedEmptyDates: [],
  };
}

test('nullable positions and explicit EXAM markers retain notes once and preserve period identity', () => {
  const data = examTimetableFixture();
  const event = normalizeTimetable(data, context)[0];
  expect(event).toMatchObject({
    sourceId: 'lesson:101',
    sourceIds: ['lesson:101', 'lesson:102'],
    category: 'lesson',
    kind: 'exam',
    start: '2026-10-20T06:00:00.000Z',
    values: {
      examText: 'Test topics: algebra\nWritten assessment',
      examName: '',
      room: '101',
    },
  });
  data.days[0].gridEntries[0].status = 'CHANGED';
  expect(normalizeTimetable(data, context)[0].kind).toBe('exam');
  data.days[0].gridEntries[0].status = 'CANCELLED';
  expect(normalizeTimetable(data, context)[0].kind).toBe('cancelled');
  data.days[0].gridEntries[0].status = 'REGULAR';
  data.days[0].gridEntries[0].type = 'NORMAL_TEACHING_PERIOD';
  expect(normalizeTimetable(data, context)[0].kind).toBe('lesson');
  expect(normalizeTimetable(data, context)[0].values.examText).toBe('');
});

test('text-array-only notes are preserved; unknown text types and absent exam details are not invented', () => {
  const data = examTimetableFixture();
  const entry = data.days[0].gridEntries[0];
  entry.notesAll = null;
  entry.lessonInfo = null;
  entry.texts!.push({ type: 'HOMEWORK', text: 'Not imported' });
  const event = normalizeTimetable(data, context)[0];
  expect(event.values.examText).toBe(
    'Test topics: algebra\nWritten assessment',
  );
  expect(event.values.examType).toBe('');
  expect(event.values.info).not.toContain('Not imported');
});

test('nonempty upstream errors and malformed non-null positions fail validation', () => {
  expect(() =>
    timetableSchema.parse({
      ...examTimetableFixture(),
      errors: [{ code: 'PARTIAL' }],
    }),
  ).toThrow();
  const data = examTimetableFixture();
  expect(() =>
    timetableSchema.parse({
      days: [
        {
          ...data.days[0],
          gridEntries: [{ ...data.days[0].gridEntries[0], position3: {} }],
        },
      ],
    }),
  ).toThrow();
});

test('two exam endpoints enrich one event only for unambiguous subject and time matches', () => {
  const timetable = normalizeTimetable(examTimetableFixture(), context);
  const merged = reconcileExams(timetable, [exam()]);
  expect(merged.exams).toEqual([]);
  expect(merged.timetable[0].sourceIds).toEqual([
    'lesson:101',
    'lesson:102',
    'exam:501',
  ]);
  expect(merged.timetable[0].values.examText).toBe(
    'Test topics: algebra\nWritten assessment\nBring a calculator',
  );
  const different = { ...exam(), sourceId: 'exam:502' };
  expect(reconcileExams(timetable, [exam(), different]).exams).toHaveLength(2);
  different.end = '2026-10-20T08:00:00.000Z';
  expect(reconcileExams(timetable, [different]).exams).toHaveLength(0);
  different.end = exam().end;
  different.values.subject = 'Physics';
  expect(reconcileExams(timetable, [different]).exams).toHaveLength(1);
  expect(
    reconcileExams(
      [...timetable, { ...timetable[0], sourceId: 'lesson:103' }],
      [exam()],
    ).exams,
  ).toHaveLength(1);
});

test('exam feeds retain one UID across classification, endpoint enrichment, unavailable exams and repeat sync', () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const accountId = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    accountId,
    'Student',
    'fixture',
    'https://fixture.webuntis.com',
    'student',
    'encrypted',
    context.timezone,
  );
  try {
    const timetable = normalizeTimetable(examTimetableFixture(), context);
    const original = { ...timetable[0], kind: 'lesson' as const };
    commitSnapshots(db, accountId, [
      snapshot('lesson', [original]),
      snapshot('exam', [exam()]),
    ]);
    const merged = reconcileExams(timetable, [exam()]);
    commitSnapshots(db, accountId, [
      snapshot('lesson', merged.timetable),
      snapshot('exam', merged.exams),
    ]);
    expect(storedEvents(db)).toHaveLength(1);
    expect(storedEvents(db)[0].sourceId).toBe('lesson:101');
    const feed = saveFeed(db, {
      name: 'Exams',
      enabled: true,
      pastDays: 14,
      futureDays: 90,
      language: 'de',
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['exam'] }],
      templates: defaultTemplates('de'),
    });
    const now = new Date('2026-10-20T05:00:00Z');
    const parse = () =>
      new ICAL.Component(
        ICAL.parse(generateCalendar(db, feed, now).body),
      ).getAllSubcomponents('vevent');
    const initial = parse();
    expect(initial).toHaveLength(1);
    const uid = initial[0].getFirstPropertyValue('uid');
    commitSnapshots(db, accountId, [snapshot('lesson', timetable)]);
    const fallback = parse();
    expect(fallback).toHaveLength(1);
    expect(fallback[0].getFirstPropertyValue('uid')).toBe(uid);
    expect(fallback[0].getFirstPropertyValue('summary')).toBe('Prüfung · Math');
    expect(fallback[0].getFirstPropertyValue('description')).toContain(
      'Written assessment',
    );
    const stable = generateCalendar(db, feed, now);
    commitSnapshots(db, accountId, [snapshot('lesson', timetable)]);
    expect(generateCalendar(db, feed, now)).toEqual(stable);
    commitSnapshots(db, accountId, [
      snapshot('lesson', merged.timetable),
      snapshot('exam', merged.exams),
    ]);
    expect(parse()).toHaveLength(1);
    expect(parse()[0].getFirstPropertyValue('uid')).toBe(uid);
  } finally {
    db.close();
  }
});

test('only denied or unavailable separate exams are optional, not authentication or server failures', () => {
  expect(isCapabilityFailure({ name: 'exams', status: 'forbidden' })).toBe(
    false,
  );
  expect(isCapabilityFailure({ name: 'exams', status: 'unavailable' })).toBe(
    false,
  );
  for (const status of ['server', 'authentication', 'invalid'] as const)
    expect(isCapabilityFailure({ name: 'exams', status })).toBe(true);
  expect(isCapabilityFailure({ name: 'timetable', status: 'forbidden' })).toBe(
    true,
  );
});

test('placeholder zero exam IDs enrich distinct timetable periods without a shared identity', () => {
  const data = examTimetableFixture();
  const second = structuredClone(data.days[0].gridEntries[0]);
  second.ids = [201];
  second.duration = { start: '2026-10-20T10:00', end: '2026-10-20T11:30' };
  data.days[0].gridEntries.push(second);
  const timetable = normalizeTimetable(data, context);
  const exams = normalizeExams(
    [
      {
        id: 0,
        name: 'First assessment',
        examDate: 20261020,
        startTime: 800,
        endTime: 930,
        subject: 'Math',
      },
      {
        id: 0,
        name: 'Second assessment',
        examDate: 20261020,
        startTime: 1000,
        endTime: 1130,
        subject: 'Math',
      },
    ],
    context,
  );
  const reconciled = reconcileExams(timetable, exams);
  expect(reconciled.exams).toEqual([]);
  expect(reconciled.timetable.map((event) => event.sourceIds)).toEqual([
    ['lesson:101', 'lesson:102'],
    ['lesson:201'],
  ]);
  expect(reconciled.timetable.map((event) => event.values.examName)).toEqual([
    'First assessment',
    'Second assessment',
  ]);
  expect(reconcileExams([], exams).exams).toEqual(exams);
});
