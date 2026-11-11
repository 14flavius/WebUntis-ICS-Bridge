import { expect, test } from 'vitest';
import { enrichTimetableExamDetails } from '../src/server/webuntis/timetable-exam-details.js';
import { calendarEntryDetailsSchema } from '../src/server/webuntis/schemas.js';
import {
  normalizeTimetable,
  normalizeExams,
} from '../src/server/webuntis/normalize.js';
import { reconcileExams } from '../src/server/webuntis/exams.js';
import {
  WebUntisClient,
  WebUntisError,
} from '../src/server/webuntis/client.js';
import { fetchSnapshots } from '../src/server/webuntis/snapshot.js';
import { examTimetableFixture } from './fixtures/timetable-exams.js';
import { context } from './fixtures/events.js';
import { tokenFixture } from './fixtures/token.js';

function details() {
  return calendarEntryDetailsSchema.parse({
    calendarEntries: [
      {
        id: 101,
        type: 'EXAM',
        startDateTime: '2026-10-20T08:00:00',
        endDateTime: '2026-10-20T09:30:00',
        exam: {
          name: 'Algebra',
          description: 'Assessment 1',
          typeLongName: 'Written test',
        },
        homeworks: [{ text: 'Not imported' }],
        notesStaff: 'Not imported',
        students: [{ name: 'Not imported' }],
      },
    ],
  });
}

test('details enrich only an existing exam and discard unrelated private fields', async () => {
  const original = examTimetableFixture();
  const enriched = await enrichTimetableExamDetails(
    original,
    context.timezone,
    async () => details(),
  );
  expect(original.days[0].gridEntries[0].examDetails).toBeUndefined();
  expect(JSON.stringify(enriched)).not.toContain('Not imported');
  const event = normalizeTimetable(enriched, context)[0];
  expect(event).toMatchObject({
    sourceId: 'lesson:101',
    sourceIds: ['lesson:101', 'lesson:102'],
    kind: 'exam',
  });
  expect(event.values).toMatchObject({
    examName: 'Algebra',
    examType: 'Written test',
    examText: 'Test topics: algebra\nWritten assessment\nAssessment 1',
  });
  const separate = normalizeExams(
    [
      {
        id: 501,
        name: 'Algebra',
        subject: 'Math',
        examDate: 20261020,
        startTime: 800,
        endTime: 930,
        examType: 'W',
      },
    ],
    context,
  );
  const merged = reconcileExams([event], separate);
  expect(merged.exams).toEqual([]);
  expect(merged.timetable[0].values.examType).toBe('Written test');
  expect(merged.timetable[0].values.examText).toBe(event.values.examText);
});

test('fresh separate exam types replace cached codes when no detailed type is available', () => {
  const event = normalizeTimetable(examTimetableFixture(), context)[0];
  event.values.examType = 'Previous code';
  const separate = normalizeExams(
    [
      {
        id: 501,
        name: 'Algebra',
        subject: 'Math',
        examDate: 20261020,
        startTime: 800,
        endTime: 930,
        examType: 'Updated code',
      },
    ],
    context,
  );
  const merged = reconcileExams([event], separate);
  expect(merged.timetable[0].values.examType).toBe('Updated code');
});

test.each([
  'wrong ID',
  'different time',
  'different type',
  'ambiguous',
  'empty',
])('detail matching does not guess for %s', async (variant) => {
  const response = details();
  if (variant === 'wrong ID') response.calendarEntries[0].id = 999;
  if (variant === 'different time')
    response.calendarEntries[0].endDateTime = '2026-10-20T09:00:00';
  if (variant === 'different type')
    response.calendarEntries[0].type = 'NORMAL_TEACHING_PERIOD';
  if (variant === 'ambiguous')
    response.calendarEntries.push(structuredClone(response.calendarEntries[0]));
  if (variant === 'empty') response.calendarEntries = [];
  const original = examTimetableFixture();
  expect(
    await enrichTimetableExamDetails(
      original,
      context.timezone,
      async () => response,
    ),
  ).toEqual(original);
});

test('only readable, active explicit exams trigger requests; equal slots share one request', async () => {
  const timetable = examTimetableFixture();
  const original = timetable.days[0].gridEntries[0];
  timetable.days[0].gridEntries.push(
    { ...original, ids: [103] },
    { ...original, ids: [104], type: 'NORMAL_TEACHING_PERIOD' },
    { ...original, ids: [105], status: 'CANCELLED' },
  );
  timetable.days.push({
    ...timetable.days[0],
    date: '2026-10-21',
    status: 'NOT_ALLOWED',
  });
  let calls = 0;
  await enrichTimetableExamDetails(timetable, context.timezone, async () => {
    calls++;
    return details();
  });
  expect(calls).toBe(1);
});

test.each(['forbidden', 'unavailable'] as const)(
  'optional %s detail access stops probing and preserves timetable data',
  async (status) => {
    const timetable = examTimetableFixture();
    const second = structuredClone(timetable.days[0].gridEntries[0]);
    second.ids = [103];
    second.duration = { start: '2026-10-20T10:00', end: '2026-10-20T10:45' };
    timetable.days[0].gridEntries.push(second);
    let calls = 0;
    const result = await enrichTimetableExamDetails(
      timetable,
      context.timezone,
      async () => {
        calls++;
        throw new WebUntisError(status);
      },
    );
    expect(result).toEqual(timetable);
    expect(calls).toBe(1);
  },
);

test('server errors, expired authentication and malformed detail responses cannot masquerade as empty data', async () => {
  for (const status of ['server', 'authentication'] as const) {
    await expect(
      enrichTimetableExamDetails(
        examTimetableFixture(),
        context.timezone,
        async () => {
          throw new WebUntisError(status);
        },
      ),
    ).rejects.toMatchObject({ status });
  }
  await expect(
    enrichTimetableExamDetails(
      examTimetableFixture(),
      context.timezone,
      async () =>
        calendarEntryDetailsSchema.parse({
          calendarEntries: [{ exam: { name: 'Invalid' } }],
        }),
    ),
  ).rejects.toThrow();
});

test('real client request flow enriches timetable exams despite a forbidden separate endpoint', async () => {
  const paths: string[] = [];
  const client = new WebUntisClient(
    {
      ...context,
      school: 'fixture',
      server: 'https://fixture.webuntis.com',
      username: 'student',
      password: 'fixture-password',
    },
    {
      close: async () => {},
      fetch: async (url, init) => {
        const target = new URL(url);
        paths.push(target.pathname);
        if (target.pathname.endsWith('jsonrpc.do')) {
          const body = JSON.parse(String(init?.body)) as { method: string };
          return Response.json({
            result:
              body.method === 'authenticate'
                ? { sessionId: 'fixture-session', personId: 42, personType: 5 }
                : [],
          });
        }
        if (target.pathname.endsWith('token/new'))
          return new Response(tokenFixture());
        if (target.pathname.endsWith('schoolyears'))
          return Response.json([
            {
              id: 7,
              name: '2026',
              dateRange: { start: '2026-08-01', end: '2027-07-31' },
            },
          ]);
        if (target.pathname.endsWith('timetable/entries'))
          return Response.json(examTimetableFixture());
        if (target.pathname.endsWith('calendar-entry/detail')) {
          const headers = new Headers(init?.headers);
          expect(headers.get('Tenant-Id')).toBe('123');
          expect(headers.get('X-Webuntis-Api-School-Year-Id')).toBe('7');
          expect(headers.get('authorization')).toBe(`Bearer ${tokenFixture()}`);
          expect(Object.fromEntries(target.searchParams)).toEqual({
            elementId: '42',
            elementType: '5',
            startDateTime: '2026-10-20T08:00',
            endDateTime: '2026-10-20T09:30',
          });
          return Response.json(details());
        }
        expect(target.pathname).toBe('/WebUntis/api/exams');
        return new Response(null, { status: 403 });
      },
    },
  );
  try {
    const result = await fetchSnapshots(
      client,
      context,
      '2026-10-20',
      '2026-10-20',
    );
    expect(result.snapshots[0].events[0].values).toMatchObject({
      examName: 'Algebra',
      examType: 'Written test',
    });
    expect(result.warnings).toEqual([
      'EXAMS_FORBIDDEN',
      'EXAMS_TIMETABLE_FALLBACK',
    ]);
    expect(
      paths.filter((path) => path.endsWith('calendar-entry/detail')),
    ).toHaveLength(1);
    expect(paths.some((path) => path.includes('app/data'))).toBe(false);
  } finally {
    await client.close();
  }
});
