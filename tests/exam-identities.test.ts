import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import ICAL from 'ical.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { examIdentities } from '../src/server/exam-identities.js';
import { matchExams } from '../src/server/webuntis/exam-matching.js';
import { saveFeed } from '../src/server/feeds.js';
import { eventUid, generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { Db } from '../src/server/db.js';
import {
  identityDatabase,
  identityAccount,
  separateExam,
  examSnapshots,
} from './fixtures/exam-identity.js';

let db: Db;
let accountId: string;
beforeEach(() => {
  db = identityDatabase();
  accountId = identityAccount(db);
});
afterEach(() => db.close());

test('distinct zero-ID exams keep independent identities and unchanged ICS across response reordering', () => {
  const exams = [
    separateExam(),
    separateExam({ name: 'Mechanics test', subject: 'Physics' }),
  ];
  const snapshots = examSnapshots(exams);
  const original = structuredClone(snapshots);
  expect(commitSnapshots(db, accountId, snapshots).warnings).toEqual([]);
  expect(snapshots).toEqual(original);
  const initial = storedEvents(db);
  expect(initial).toHaveLength(2);
  expect(new Set(initial.map((event) => event.sourceId)).size).toBe(2);
  expect(
    initial.every((event) => event.sourceId.startsWith('exam-local:')),
  ).toBe(true);
  const feed = saveFeed(db, {
    name: 'Exams',
    enabled: true,
    pastDays: 30,
    futureDays: 90,
    language: 'en',
    cancellation: 'mark',
    sources: [{ accountId, kinds: ['exam'] }],
    templates: defaultTemplates('en'),
  });
  const now = new Date('2026-10-20T05:00:00Z');
  const calendar = generateCalendar(db, feed, now);
  commitSnapshots(db, accountId, examSnapshots([...exams].reverse()));
  expect(storedEvents(db)).toEqual(initial);
  expect(generateCalendar(db, feed, now)).toEqual(calendar);
  const events = new ICAL.Component(
    ICAL.parse(calendar.body),
  ).getAllSubcomponents('vevent');
  expect(events).toHaveLength(2);
  expect(
    new Set(events.map((event) => event.getFirstPropertyValue('uid'))).size,
  ).toBe(2);
  expect(
    db.prepare("SELECT * FROM event_aliases WHERE originalId='exam:0'").all(),
  ).toEqual([]);
});

test('notes, room, teacher, a timed rename and a move across windows preserve the published UID', () => {
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam()], { end: '2026-10-21' }),
  );
  const initial = storedEvents(db)[0];
  const changed = separateExam({
    name: 'Algebra assessment',
    text: 'New topics',
    rooms: ['204'],
    teachers: ['Teacher B'],
  });
  commitSnapshots(db, accountId, examSnapshots([changed]));
  expect(storedEvents(db)[0]).toMatchObject({
    sourceId: initial.sourceId,
    revision: 1,
    values: { room: '204', teacher: 'Teacher B' },
  });
  const moved = separateExam({
    name: 'Algebra assessment',
    examDate: 20261027,
    startTime: 1000,
    endTime: 1130,
  });
  commitSnapshots(db, accountId, [
    ...examSnapshots([], { end: '2026-10-21' }),
    ...examSnapshots([moved], { start: '2026-10-22' }),
  ]);
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0]).toMatchObject({
    sourceId: initial.sourceId,
    date: '2026-10-27',
    start: '2026-10-27T09:00:00.000Z',
  });
  expect(eventUid('feed', storedEvents(db)[0])).toBe(eventUid('feed', initial));
});

test('zero-to-native-to-zero ID changes retain the same calendar UID', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const initial = storedEvents(db)[0];
  for (const id of [501, 0, 501]) {
    commitSnapshots(db, accountId, examSnapshots([separateExam({ id })]));
    expect(storedEvents(db)).toHaveLength(1);
    expect(storedEvents(db)[0].sourceId).toBe(initial.sourceId);
  }
  expect(examIdentities(db, accountId)).toHaveLength(1);
});

test('actual source IDs stay authoritative even for identically named simultaneous exams', () => {
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam({ id: 501 }), separateExam({ id: 502 })]),
  );
  expect(storedEvents(db).map((event) => event.sourceId)).toEqual([
    'exam:501',
    'exam:502',
  ]);
  const changed = separateExam({
    id: 501,
    examDate: 20261125,
    name: 'Completely changed',
    subject: 'Other subject',
  });
  commitSnapshots(
    db,
    accountId,
    examSnapshots([changed, separateExam({ id: 502 })]),
  );
  expect(storedEvents(db)).toHaveLength(2);
  expect(
    storedEvents(db).find((event) => event.sourceId === 'exam:501')?.values
      .examName,
  ).toBe('Completely changed');
});

test('ambiguous moves preserve every possible history without adding a guessed third exam', () => {
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam(), separateExam({ examDate: 20261022 })]),
  );
  const initial = storedEvents(db);
  const observations = examSnapshots([separateExam({ examDate: 20261021 })]);
  for (const now of ['2026-10-20T10:00:00Z', '2026-10-20T10:10:00Z']) {
    expect(
      commitSnapshots(db, accountId, observations, now).warnings,
    ).toContain('EXAMS_AMBIGUOUS');
    expect(storedEvents(db)).toEqual(initial);
  }
  expect(examIdentities(db, accountId)).toHaveLength(2);
  expect(db.prepare('SELECT DISTINCT missingSince FROM events').all()).toEqual([
    { missingSince: null },
  ]);
});

test('duplicates and insufficient identity data withhold only uncertain entries', () => {
  const exams = [
    separateExam(),
    separateExam({ text: 'Conflicting copy' }),
    separateExam({ subject: '', name: 'Unknown subject' }),
    separateExam({ subject: 'Physics', name: 'Mechanics test' }),
  ];
  expect(
    commitSnapshots(db, accountId, examSnapshots(exams)).warnings,
  ).toContain('EXAMS_AMBIGUOUS');
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0].values.subject).toBe('Physics');
  commitSnapshots(db, accountId, examSnapshots(exams.reverse()));
  expect(examIdentities(db, accountId)).toHaveLength(1);
});

test('changing name and date together is not guessed; exact matches take precedence independent of input order', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const initial = storedEvents(db)[0];
  expect(
    commitSnapshots(
      db,
      accountId,
      examSnapshots([separateExam({ name: 'New name', examDate: 20261021 })]),
    ).warnings,
  ).toContain('EXAMS_AMBIGUOUS');
  expect(storedEvents(db)).toEqual([initial]);
  const newExam = separateExam({ name: 'New assessment', examDate: 20261022 });
  commitSnapshots(db, accountId, examSnapshots([newExam, separateExam()]));
  const both = storedEvents(db);
  expect(both).toHaveLength(2);
  commitSnapshots(db, accountId, examSnapshots([separateExam(), newExam]));
  expect(storedEvents(db)).toEqual(both);
});

test('bounded matching never crosses accounts or school years and all-day exams remain valid', () => {
  const event = separateExam({ startTime: undefined, endTime: undefined });
  commitSnapshots(db, accountId, examSnapshots([event]));
  const previous = examIdentities(db, accountId);
  const incoming = examSnapshots([event])[0].examCandidates!;
  const otherYear = { ...incoming[0], schoolYearId: '2027' };
  expect(matchExams([otherYear], previous).matches.size).toBe(0);
  const far = examSnapshots([separateExam({ examDate: 20261104 })])[0]
    .examCandidates!;
  expect(matchExams(far, previous).matches.size).toBe(0);
  const otherAccount = identityAccount(db);
  commitSnapshots(db, otherAccount, examSnapshots([event]));
  expect(new Set(storedEvents(db).map((stored) => stored.sourceId)).size).toBe(
    2,
  );
  expect(storedEvents(db)[0]).toMatchObject({
    allDay: true,
    start: '2026-10-20',
    end: '2026-10-21',
  });
});

test('missing placeholder exams are retained even when another exam appears on that date', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const initial = storedEvents(db)[0];
  const other = separateExam({
    id: 502,
    subject: 'Physics',
    name: 'Mechanics test',
  });
  for (const now of ['2026-10-20T10:00:00Z', '2026-10-20T10:10:00Z'])
    commitSnapshots(db, accountId, examSnapshots([other]), now);
  expect(storedEvents(db)).toContainEqual(initial);
  expect(
    db
      .prepare('SELECT missingSince FROM events WHERE sourceId=?')
      .get(initial.sourceId),
  ).toEqual({ missingSince: null });
});

test('identity allocation and event publication roll back together on invalid snapshots and conflicting native IDs', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const initial = storedEvents(db);
  const history = examIdentities(db, accountId);
  const snapshots = examSnapshots([
    separateExam({ subject: 'Physics', name: 'Mechanics test' }),
  ]);
  snapshots.push({
    category: 'lesson',
    start: '2026-10-01',
    end: '2026-10-02',
    events: [separateExam()],
    confirmedEmptyDates: [],
  });
  expect(() => commitSnapshots(db, accountId, snapshots)).toThrow(
    'WEBUNTIS_OUTSIDE_WINDOW',
  );
  expect(() =>
    commitSnapshots(
      db,
      accountId,
      examSnapshots([
        separateExam({ id: 501 }),
        separateExam({ id: 501, name: 'Conflict' }),
      ]),
    ),
  ).toThrow('WEBUNTIS_CONFLICTING_ID');
  expect(storedEvents(db)).toEqual(initial);
  expect(examIdentities(db, accountId)).toEqual(history);
});

test('saved mappings survive a database reopen and additive migrations', () => {
  mkdirSync('.cache/tests', { recursive: true });
  const path = resolve(
    mkdtempSync('.cache/tests/exam-identities-'),
    'bridge.sqlite',
  );
  let persisted = identityDatabase(path);
  const id = identityAccount(persisted);
  commitSnapshots(persisted, id, examSnapshots([separateExam()]));
  const original = storedEvents(persisted)[0];
  persisted.close();
  persisted = identityDatabase(path);
  try {
    commitSnapshots(
      persisted,
      id,
      examSnapshots([separateExam({ examDate: 20261021 })]),
    );
    expect(storedEvents(persisted)[0].sourceId).toBe(original.sourceId);
    expect(examIdentities(persisted, id)).toHaveLength(1);
  } finally {
    persisted.close();
  }
});
