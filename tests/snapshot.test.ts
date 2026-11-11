import { tokenFixture } from './fixtures/token.js';
import { expect, test } from 'vitest';
import { WebUntisClient } from '../src/server/webuntis/client.js';
import { fetchSnapshots } from '../src/server/webuntis/snapshot.js';
import { context, timetableFixture } from './fixtures/events.js';
import { examTimetableFixture } from './fixtures/timetable-exams.js';
import type { Timetable } from '../src/server/webuntis/schemas.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { lessonFixture } from './fixtures/events.js';

function fixtureClient(
  options: {
    deniedExams?: boolean;
    missingDays?: boolean;
    missingDate?: string;
    timetableExams?: boolean;
    zeroExamId?: boolean;
    timetable?: Timetable;
    examsStatus?: number;
    examsResponse?: unknown;
  } = {},
) {
  const paths: string[] = [];
  const client = new WebUntisClient(
    {
      ...context,
      school: 'fixture-school',
      server: 'https://fixture-school.webuntis.com',
      username: 'student',
      password: 'fixture-password',
    },
    {
      close: async () => {},
      fetch: async (url, init) => {
        const target = new URL(url);
        paths.push(target.pathname + target.search);
        if (target.pathname.endsWith('jsonrpc.do')) {
          const body = JSON.parse(String(init?.body)) as { method: string };
          if (body.method === 'authenticate')
            return Response.json({
              result: {
                sessionId: 'fixture-session',
                personId: 42,
                personType: 5,
              },
            });
          if (body.method === 'getTimetable')
            return Response.json({ result: [] });
          expect(body.method).toBe('getHolidays');
          return Response.json({
            result: [
              {
                id: 1,
                name: 'Holiday',
                startDate: 20261023,
                endDate: 20261025,
              },
            ],
          });
        }
        if (target.pathname.endsWith('token/new'))
          return new Response(tokenFixture());
        expect(target.pathname).not.toContain('app/data');
        if (target.pathname.endsWith('calendar-entry/detail'))
          return new Response(null, { status: 404 });
        if (target.pathname.endsWith('schoolyears'))
          return Response.json([
            {
              id: 2,
              name: '2026',
              dateRange: {
                start: options.timetable?.days[0].date ?? '2026-10-20',
                end: options.timetable?.days.at(-1)?.date ?? '2026-10-20',
              },
            },
          ]);
        if (target.pathname.endsWith('timetable/entries')) {
          expect(new Headers(init?.headers).get('Tenant-Id')).toBe('123');
          expect(
            new Headers(init?.headers).get('X-Webuntis-Api-School-Year-Id'),
          ).toBe('2');
          expect(target.searchParams.get('format')).toBe('1');
          expect(target.searchParams.get('layout')).toBe('START_TIME');
          expect(target.searchParams.get('resources')).toBe('42');
          let timetable = options.timetableExams
            ? examTimetableFixture()
            : timetableFixture;
          if (options.timetable) timetable = options.timetable;
          if (options.missingDate)
            timetable = {
              days: timetable.days.filter(
                (day) => day.date !== options.missingDate,
              ),
            };
          return Response.json(options.missingDays ? { days: [] } : timetable);
        }
        if (options.deniedExams) return new Response(null, { status: 403 });
        if (options.examsStatus)
          return new Response(null, { status: options.examsStatus });
        if (options.examsResponse !== undefined)
          return Response.json(options.examsResponse);
        return Response.json({
          data: {
            exams: [
              {
                id: options.zeroExamId ? 0 : 3,
                name: 'Own exam',
                examDate: 20261020,
                assignedStudents: [{ id: 42 }],
              },
              {
                id: 4,
                name: 'Other student',
                examDate: 20261020,
                assignedStudents: [{ id: 99 }],
              },
            ],
          },
        });
      },
    },
  );
  return { client, paths };
}

test('validated windows include assigned exams and holidays, clipping unpublished school years', async () => {
  const { client, paths } = fixtureClient();
  const result = await fetchSnapshots(
    client,
    context,
    '2026-10-19',
    '2026-10-22',
  );
  expect(result.warnings).toEqual(['SCHOOLYEAR_RANGE_LIMITED']);
  expect(result.snapshots.map((snapshot) => snapshot.category)).toEqual([
    'lesson',
    'exam',
    'holiday',
  ]);
  expect(
    result.snapshots[1].events.map((event) => event.values.examName),
  ).toEqual(['Own exam']);
  expect(
    paths.some((path) => path.includes('start=2026-10-20&end=2026-10-20')),
  ).toBe(true);
  await client.close();
});

test('an empty timetable has no coverage instead of confirming deletion', async () => {
  const { client } = fixtureClient({ missingDays: true });
  const result = await fetchSnapshots(
    client,
    context,
    '2026-10-20',
    '2026-10-20',
  );
  expect(result.warnings).toContain('TIMETABLE_DAYS_MISSING');
  expect(
    result.snapshots.some((snapshot) => snapshot.category === 'lesson'),
  ).toBe(false);
  await client.close();
});

test('unavailable optional data has no coverage and cannot clear previous exams', async () => {
  const { client } = fixtureClient({ deniedExams: true, timetableExams: true });
  const result = await fetchSnapshots(
    client,
    context,
    '2026-10-20',
    '2026-10-20',
  );
  expect(result.warnings).toEqual([
    'EXAMS_FORBIDDEN',
    'EXAMS_TIMETABLE_FALLBACK',
  ]);
  expect(result.snapshots.map((snapshot) => snapshot.category)).toEqual([
    'lesson',
    'exam',
    'holiday',
  ]);
  expect(result.snapshots[1]).toMatchObject({
    deletionCoverage: false,
    examFeed: { source: 'timetable', dates: ['2026-10-20'], events: [] },
  });
  expect(result.snapshots[0].events[0]).toMatchObject({
    kind: 'exam',
    category: 'lesson',
    values: { examText: 'Test topics: algebra\nWritten assessment' },
  });
  await client.close();
});

test.each(['NOT_ALLOWED_FOR_RESOURCE', 'NOT_ALLOWED', 'omitted'])(
  '%s dates exclude coverage while readable dates sync and confirmed empty dates can retire events',
  async (status) => {
    const timetable = structuredClone(timetableFixture);
    timetable.days.unshift({
      date: '2026-10-19',
      status: status === 'omitted' ? 'REGULAR' : status,
      gridEntries: [],
    });
    timetable.days.push({
      date: '2026-10-21',
      status: 'NO_DATA',
      gridEntries: [],
    });
    const { client } = fixtureClient({
      timetable,
      deniedExams: true,
      missingDate: status === 'omitted' ? '2026-10-19' : undefined,
    });
    const db = openDatabase(':memory:');
    migrateApplication(db);
    db.prepare(
      'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'account',
      'Student',
      'fixture',
      'https://fixture.webuntis.com',
      'student',
      'encrypted',
      context.timezone,
    );
    try {
      const existing = ['2026-10-19', '2026-10-21'].map((date, index) => ({
        ...lessonFixture(),
        sourceId: `lesson:${900 + index}`,
        sourceIds: [`lesson:${900 + index}`],
        date,
        start: `${date}T06:00:00.000Z`,
        end: `${date}T06:45:00.000Z`,
      }));
      commitSnapshots(
        db,
        'account',
        [
          {
            category: 'lesson',
            start: '2026-10-19',
            end: '2026-10-21',
            events: existing,
            confirmedEmptyDates: [],
          },
        ],
        '2026-10-20T05:00:00.000Z',
      );
      const original = storedEvents(db).find(
        (event) => event.date === '2026-10-19',
      );
      const result = await fetchSnapshots(
        client,
        context,
        '2026-10-19',
        '2026-10-21',
      );
      expect(result.warnings).toEqual([
        status === 'omitted'
          ? 'TIMETABLE_DAYS_MISSING'
          : 'TIMETABLE_RANGE_RESTRICTED',
        'EXAMS_FORBIDDEN',
        'EXAMS_TIMETABLE_FALLBACK',
      ]);
      expect(
        result.snapshots.find((snapshot) => snapshot.examFeed)?.examFeed?.dates,
      ).toEqual(['2026-10-20', '2026-10-21']);
      const lessons = result.snapshots.filter(
        (snapshot) => snapshot.category === 'lesson',
      );
      expect(lessons.map(({ start, end }) => [start, end])).toEqual([
        ['2026-10-20', '2026-10-20'],
        ['2026-10-21', '2026-10-21'],
      ]);
      for (const stamp of ['05:01', '05:02', '05:03']) {
        commitSnapshots(
          db,
          'account',
          result.snapshots,
          `2026-10-20T${stamp}:00.000Z`,
        );
      }
      const stored = storedEvents(db).filter(
        (event) => event.category === 'lesson',
      );
      expect(stored).toHaveLength(2);
      expect(stored.find((event) => event.date === '2026-10-19')).toEqual(
        original,
      );
      expect(
        stored.find((event) => event.date === '2026-10-20')?.revision,
      ).toBe(0);
      expect(
        db
          .prepare('SELECT missingSince FROM events WHERE sourceId = ?')
          .get('lesson:900'),
      ).toEqual({ missingSince: null });
    } finally {
      await client.close();
      db.close();
    }
  },
);

test('a wholly restricted timetable produces no lesson coverage or confirmed deletions', async () => {
  const timetable = structuredClone(timetableFixture);
  timetable.days[0] = {
    date: '2026-10-20',
    status: 'NOT_ALLOWED_FOR_RESOURCE',
    gridEntries: [],
  };
  const { client } = fixtureClient({ timetable });
  try {
    const result = await fetchSnapshots(
      client,
      context,
      '2026-10-20',
      '2026-10-20',
    );
    expect(result.warnings).toContain('TIMETABLE_RANGE_RESTRICTED');
    expect(
      result.snapshots.some((snapshot) => snapshot.category === 'lesson'),
    ).toBe(false);
  } finally {
    await client.close();
  }
});

test('unknown day statuses still reject the snapshot instead of being treated as restrictions', async () => {
  const timetable = structuredClone(timetableFixture);
  timetable.days[0].status = 'UNEXPECTED_SERVER_STATE';
  const { client } = fixtureClient({ timetable });
  try {
    await expect(
      fetchSnapshots(client, context, '2026-10-20', '2026-10-20'),
    ).rejects.toMatchObject({ code: 'WEBUNTIS_INCOMPLETE_DAY' });
  } finally {
    await client.close();
  }
});

test('placeholder exam IDs are passed to transactional matching, never published directly', async () => {
  const { client } = fixtureClient({ zeroExamId: true });
  try {
    const result = await fetchSnapshots(
      client,
      context,
      '2026-10-20',
      '2026-10-20',
    );
    expect(result.warnings).toEqual([]);
    expect(result.snapshots.map((snapshot) => snapshot.category)).toEqual([
      'lesson',
      'exam',
      'holiday',
    ]);
    expect(result.snapshots[1].events).toEqual([]);
    expect(result.snapshots[1].examCandidates).toMatchObject([
      {
        schoolYearId: '2',
        event: { sourceId: 'exam:0', values: { examName: 'Own exam' } },
      },
    ]);
  } finally {
    await client.close();
  }
});

test('explicit timetable selection skips the separate exam HTTP request', async () => {
  const { client, paths } = fixtureClient({ timetableExams: true });
  try {
    const result = await fetchSnapshots(
      client,
      { ...context, examSource: 'timetable' },
      '2026-10-20',
      '2026-10-20',
    );
    expect(paths.some((path) => path.includes('/api/exams'))).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(
      result.snapshots.find((snapshot) => snapshot.examFeed)?.examFeed,
    ).toMatchObject({
      source: 'timetable',
      dates: ['2026-10-20'],
      events: [],
    });
    expect(result.snapshots[0].events[0].kind).toBe('exam');
  } finally {
    await client.close();
  }
});

test.each([
  { name: 'unavailable', examsStatus: 404 },
  { name: 'server error', examsStatus: 500 },
  { name: 'invalid response', examsResponse: { data: { exams: 'invalid' } } },
  {
    name: 'incomplete time',
    examsResponse: {
      data: {
        exams: [{ id: 1, name: 'Test', examDate: 20261020, startTime: 800 }],
      },
    },
  },
  {
    name: 'outside requested dates',
    examsResponse: {
      data: { exams: [{ id: 1, name: 'Test', examDate: 20261021 }] },
    },
  },
  {
    name: 'conflicting native IDs',
    examsResponse: {
      data: {
        exams: [
          { id: 1, name: 'First', examDate: 20261020 },
          { id: 1, name: 'Second', examDate: 20261020 },
        ],
      },
    },
  },
])(
  '$name in the Exams tab falls back without losing valid timetable data',
  async (options) => {
    const { client } = fixtureClient({ ...options, timetableExams: true });
    try {
      const result = await fetchSnapshots(
        client,
        context,
        '2026-10-20',
        '2026-10-20',
      );
      expect(result.warnings).toContain('EXAMS_TIMETABLE_FALLBACK');
      expect(result.snapshots[0].events[0].kind).toBe('exam');
      expect(
        result.snapshots.find((snapshot) => snapshot.examFeed),
      ).toMatchObject({
        events: [],
        deletionCoverage: false,
        examFeed: { source: 'timetable', dates: ['2026-10-20'] },
      });
    } finally {
      await client.close();
    }
  },
);

test('a valid empty Exams tab is a successful source, not a fallback condition', async () => {
  const { client } = fixtureClient({
    examsResponse: { data: { exams: [] } },
    timetableExams: true,
  });
  try {
    const result = await fetchSnapshots(
      client,
      context,
      '2026-10-20',
      '2026-10-20',
    );
    expect(result.warnings).toEqual([]);
    expect(
      result.snapshots.find((snapshot) => snapshot.examFeed)?.examFeed,
    ).toEqual({
      source: 'exams',
      schoolYearId: '2',
      dates: ['2026-10-20'],
      events: [],
    });
  } finally {
    await client.close();
  }
});
