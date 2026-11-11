import { expect, test } from 'vitest';
import { DateTime } from 'luxon';
import { windows, fetchSnapshots } from '../src/server/webuntis/snapshot.js';
import { WebUntisClient } from '../src/server/webuntis/client.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { identityAccount, identityDatabase } from './fixtures/exam-identity.js';
import { context, lessonFixture } from './fixtures/events.js';
import { tokenFixture } from './fixtures/token.js';

const years = [
  {
    id: 25,
    name: '2026/27',
    dateRange: { start: '2026-09-15', end: '2027-07-30' },
  },
  {
    id: 22,
    name: '2025/26',
    dateRange: { start: '2025-09-16', end: '2026-07-31' },
  },
];

test('school-year windows skip summer gaps and clip uncovered edges in either input order', () => {
  const expected = [
    { start: '2026-07-30', end: '2026-07-31', yearId: '22' },
    { start: '2026-09-15', end: '2026-09-18', yearId: '25' },
  ];
  expect(windows('2026-07-30', '2026-09-18', years)).toEqual(expected);
  expect(windows('2026-07-30', '2026-09-18', [...years].reverse())).toEqual(
    expected,
  );
  expect(windows('2026-08-10', '2026-09-18', years)).toEqual([expected[1]]);
  expect(windows('2026-07-30', '2026-08-10', years)).toEqual([expected[0]]);
  expect(windows('2026-05-12', '2027-05-07', years)).toHaveLength(46);
});

test.each([
  ['2026-08-01', '2026-09-14'],
  ['2028-01-01', '2028-01-02'],
])(
  'a wholly unavailable range %s–%s still fails without fabricating a school year',
  (start, end) => {
    expect(() => windows(start, end, years)).toThrow(
      'WEBUNTIS_SCHOOLYEAR_MISSING',
    );
    expect(() => windows(start, end, [])).toThrow(
      'WEBUNTIS_SCHOOLYEAR_MISSING',
    );
  },
);

test('sync requests both sides of a summer gap with matching year headers and preserves unobserved events', async () => {
  const calls: { start: string; end: string; year: string | null }[] = [];
  const client = new WebUntisClient(
    {
      ...context,
      school: 'fixture',
      server: 'https://fixture.webuntis.com',
      username: 'student',
      password: 'fixture',
    },
    {
      close: async () => {},
      fetch: async (url, init) => {
        const target = new URL(url);
        if (target.pathname.endsWith('jsonrpc.do')) {
          const request = JSON.parse(String(init?.body)) as { method: string };
          if (request.method === 'authenticate')
            return Response.json({
              result: { sessionId: 'fixture', personId: 42, personType: 5 },
            });
          expect(request.method).toBe('getHolidays');
          return Response.json({ result: [] });
        }
        if (target.pathname.endsWith('token/new'))
          return new Response(tokenFixture());
        if (target.pathname.endsWith('schoolyears'))
          return Response.json(years);
        if (target.pathname.endsWith('timetable/entries')) {
          const start = target.searchParams.get('start')!;
          const end = target.searchParams.get('end')!;
          calls.push({
            start,
            end,
            year: new Headers(init?.headers).get(
              'X-Webuntis-Api-School-Year-Id',
            ),
          });
          const days = [];
          for (
            let day = DateTime.fromISO(start);
            day.toISODate()! <= end;
            day = day.plus({ days: 1 })
          ) {
            days.push({
              date: day.toISODate(),
              status: 'NO_DATA',
              gridEntries: [],
            });
          }
          return Response.json({ days });
        }
        if (target.pathname.endsWith('/exams'))
          return Response.json({ data: { exams: [] } });
        throw new Error('Unexpected fixture endpoint');
      },
    },
  );
  const db = identityDatabase();
  try {
    const id = identityAccount(db);
    const date = '2026-08-10';
    const historical = {
      ...lessonFixture(),
      date,
      start: `${date}T06:00:00.000Z`,
      end: `${date}T06:45:00.000Z`,
    };
    commitSnapshots(db, id, [
      {
        category: 'lesson',
        start: date,
        end: date,
        events: [historical],
        confirmedEmptyDates: [],
      },
    ]);
    const before = storedEvents(db);
    const result = await fetchSnapshots(
      client,
      context,
      '2026-07-30',
      '2026-09-18',
    );
    expect(result.warnings).toEqual(['SCHOOLYEAR_RANGE_LIMITED']);
    expect(calls).toEqual([
      { start: '2026-07-30', end: '2026-07-31', year: '22' },
      { start: '2026-09-15', end: '2026-09-18', year: '25' },
    ]);
    const dated = result.snapshots.filter(
      (snapshot) => snapshot.category !== 'holiday',
    );
    expect(
      dated.every(
        (snapshot) =>
          snapshot.end < '2026-08-01' || snapshot.start > '2026-09-14',
      ),
    ).toBe(true);
    commitSnapshots(db, id, result.snapshots, '2026-11-08T08:00:00Z');
    commitSnapshots(db, id, result.snapshots, '2026-11-08T08:02:00Z');
    expect(storedEvents(db)).toEqual(before);
    expect(
      db.prepare('SELECT missingSince FROM events WHERE accountId=?').get(id),
    ).toEqual({ missingSince: null });
  } finally {
    await client.close();
    db.close();
  }
});
