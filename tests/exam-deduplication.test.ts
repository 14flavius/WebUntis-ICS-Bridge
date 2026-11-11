import { afterEach, beforeEach, expect, test } from 'vitest';
import ICAL from 'ical.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import { examIdentities } from '../src/server/exam-identities.js';
import { reconcileExams } from '../src/server/webuntis/exams.js';
import { matchExams } from '../src/server/webuntis/exam-matching.js';
import { normalizeTimetable } from '../src/server/webuntis/normalize.js';
import type { Db } from '../src/server/db.js';
import { context } from './fixtures/events.js';
import { examTimetableFixture } from './fixtures/timetable-exams.js';
import {
  identityDatabase,
  identityAccount,
  separateExam,
  timetableExam,
  examSnapshots,
} from './fixtures/exam-identity.js';

let db: Db;
let accountId: string;
beforeEach(() => {
  db = identityDatabase();
  accountId = identityAccount(db);
});
afterEach(() => db.close());

test('separate and timetable exams produce one event, including short/long subject names', () => {
  for (const id of [0, 501, 0]) {
    const snapshots = examSnapshots([separateExam({ id })], {
      lessons: [timetableExam()],
    });
    expect(commitSnapshots(db, accountId, snapshots).warnings).toEqual([]);
    expect(storedEvents(db)).toHaveLength(1);
    expect(storedEvents(db)[0]).toMatchObject({
      sourceId: 'lesson:101',
      category: 'lesson',
      values: { examName: 'Algebra test', subject: 'Mathematics' },
    });
  }
  expect(examIdentities(db, accountId)).toHaveLength(1);
});

test('a previously standalone fallback keeps its UID when a matching timetable period becomes available', () => {
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  const original = storedEvents(db)[0];
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam()], { lessons: [timetableExam()] }),
  );
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0]).toMatchObject({
    sourceId: original.sourceId,
    category: 'lesson',
  });
  // Separate endpoint subsequently unavailable: the timetable alias still maps
  // to the same published fallback UID.
  const lessonsOnly = examSnapshots([], { lessons: [timetableExam()] }).filter(
    (snapshot) => snapshot.category === 'lesson',
  );
  commitSnapshots(db, accountId, lessonsOnly);
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0].sourceId).toBe(original.sourceId);
});

test('a restricted historical timetable reuses the saved enriched lesson without creating a duplicate', () => {
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam()], { lessons: [timetableExam()] }),
  );
  const original = storedEvents(db)[0];
  const snapshot = examSnapshots([separateExam()]);
  const unchanged = structuredClone(snapshot);
  expect(commitSnapshots(db, accountId, snapshot).warnings).toEqual([]);
  expect(storedEvents(db)).toEqual([original]);
  expect(snapshot).toEqual(unchanged);
  expect(examIdentities(db, accountId)).toHaveLength(1);
  expect(
    db
      .prepare(
        "SELECT count(*) AS count FROM sync_coverage WHERE category='lesson'",
      )
      .get(),
  ).toEqual({ count: 1 });
});

test('previously published duplicates consolidate atomically when the saved timetable supplies the missing link', () => {
  // Simulate records published before cached-timetable reconciliation existed.
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  commitSnapshots(
    db,
    accountId,
    examSnapshots([], { lessons: [timetableExam()] }).filter(
      (snapshot) => snapshot.category === 'lesson',
    ),
  );
  expect(storedEvents(db)).toHaveLength(2);
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0].sourceId).toBe('lesson:101');
  const original = storedEvents(db)[0];
  commitSnapshots(db, accountId, examSnapshots([separateExam()]));
  expect(storedEvents(db)).toEqual([original]);
});

test('fresh classification overrides cached exams; cancellation is not replaced by a stale separate exam', () => {
  commitSnapshots(
    db,
    accountId,
    examSnapshots([separateExam()], { lessons: [timetableExam()] }),
  );
  const cancelled = { ...timetableExam(), kind: 'cancelled' as const };
  const snapshots = examSnapshots([separateExam()], { lessons: [cancelled] });
  const history = examIdentities(db, accountId);
  expect(
    matchExams(snapshots[1].examCandidates!, history, [cancelled]).ambiguous
      .size,
  ).toBe(1);
  expect(commitSnapshots(db, accountId, snapshots).warnings).toContain(
    'EXAMS_AMBIGUOUS',
  );
  expect(storedEvents(db)).toHaveLength(1);
  expect(storedEvents(db)[0]).toMatchObject({
    sourceId: 'lesson:101',
    kind: 'cancelled',
  });
});

test('a unique all-day exam or shared-boundary period enriches the timetable instead of adding a duplicate', () => {
  for (const separate of [
    separateExam({ startTime: undefined, endTime: undefined }),
    separateExam({ endTime: 845 }),
    separateExam({ endTime: 1000 }),
  ]) {
    const reconciled = reconcileExams([timetableExam()], [separate], '2026');
    expect(reconciled.exams).toEqual([]);
    expect(reconciled.timetable).toHaveLength(1);
    expect(reconciled.identityCandidates[0].targetIds).toEqual([
      'lesson:101',
      'lesson:102',
    ]);
  }
});

test('overlap alone is not enough; ambiguous additional observations do not publish new duplicates', () => {
  const overlap = separateExam({ startTime: 830, endTime: 1000 });
  for (const id of [0, 501]) {
    const observation = { ...overlap, sourceId: `exam:${id}` };
    const result = commitSnapshots(
      db,
      accountId,
      examSnapshots([observation], { lessons: [timetableExam()] }),
    );
    expect(result.warnings).toContain('EXAMS_AMBIGUOUS');
    expect(storedEvents(db)).toHaveLength(1);
    expect(storedEvents(db)[0].sourceId).toBe('lesson:101');
  }
});

test('two same-subject timetable exams prevent guessing an all-day relationship; unrelated exams still import', () => {
  const second = {
    ...timetableExam(),
    sourceId: 'lesson:201',
    sourceIds: ['lesson:201'],
    start: '2026-10-20T09:00:00.000Z',
    end: '2026-10-20T10:30:00.000Z',
  };
  const exams = [
    separateExam({ startTime: undefined, endTime: undefined }),
    separateExam({ subject: 'Physics', name: 'Mechanics test' }),
  ];
  expect(
    commitSnapshots(
      db,
      accountId,
      examSnapshots(exams, { lessons: [timetableExam(), second] }),
    ).warnings,
  ).toContain('EXAMS_AMBIGUOUS');
  expect(storedEvents(db)).toHaveLength(3);
  expect(
    storedEvents(db)
      .filter((event) => event.category === 'exam')
      .map((event) => event.values.subject),
  ).toEqual(['Physics']);
});

test('a separate exam spanning two changed timetable periods adds no overlapping ICS event', () => {
  const timetable = examTimetableFixture();
  const first = timetable.days[0].gridEntries[0];
  first.ids = [101];
  first.duration.end = '2026-10-20T08:45';
  first.examDetails = { name: 'Algebra test', typeLongName: 'Written' };
  const second = structuredClone(first);
  second.ids = [102];
  second.status = 'CHANGED';
  second.duration = {
    start: '2026-10-20T08:45',
    end: '2026-10-20T09:30',
  };
  second.position2 = [
    {
      current: { type: 'ROOM', shortName: '101' },
      removed: { type: 'ROOM', shortName: '102' },
    },
  ];
  timetable.days[0].gridEntries.push(second);
  const lessons = normalizeTimetable(timetable, context);
  const feed = saveFeed(db, {
    name: 'Exam sections',
    enabled: true,
    pastDays: 14,
    futureDays: 90,
    language: 'en',
    cancellation: 'mark',
    sources: [{ accountId, kinds: ['exam'] }],
    templates: defaultTemplates('en'),
  });
  const now = new Date('2026-10-20T05:00:00Z');
  let firstBody: string | undefined;
  for (const id of [0, 501, 0]) {
    const result = commitSnapshots(
      db,
      accountId,
      examSnapshots([separateExam({ id })], { lessons }),
      now.toISOString(),
    );
    expect(result.warnings).toContain('EXAMS_AMBIGUOUS');
    expect(storedEvents(db).map((event) => event.sourceId)).toEqual([
      'lesson:101',
      'lesson:102',
    ]);
    const body = generateCalendar(db, feed, now).body;
    const components = new ICAL.Component(ICAL.parse(body)).getAllSubcomponents(
      'vevent',
    );
    expect(components).toHaveLength(2);
    expect(
      new Set(components.map((event) => event.getFirstPropertyValue('uid')))
        .size,
    ).toBe(2);
    const events = components.map((component) => new ICAL.Event(component));
    expect(
      events.map((event) => event.startDate.toJSDate().toISOString()),
    ).toEqual(['2026-10-20T06:00:00.000Z', '2026-10-20T06:45:00.000Z']);
    expect(
      events.map((event) => event.endDate.toJSDate().toISOString()),
    ).toEqual(['2026-10-20T06:45:00.000Z', '2026-10-20T07:30:00.000Z']);
    expect(events.map((event) => event.location)).toEqual(['101', '101']);
    expect(
      components.map((event) => event.getFirstPropertyValue('sequence')),
    ).toEqual([0, 0]);
    if (firstBody) expect(body).toBe(firstBody);
    firstBody = body;
  }
});
