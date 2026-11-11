import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import { WebUntisClient } from '../src/server/webuntis/client.js';
import { fetchSnapshots } from '../src/server/webuntis/snapshot.js';
import {
  normalizeRpc,
  normalizeExams,
} from '../src/server/webuntis/normalize.js';
import {
  rpcTimetableSchema,
  examsSchema,
} from '../src/server/webuntis/schemas.js';
import { tokenFixture } from './fixtures/token.js';
import { context } from './fixtures/events.js';
import {
  identityDatabase,
  identityAccount,
  examSnapshots,
} from './fixtures/exam-identity.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { generateCalendar } from '../src/server/ics.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';

const credentials = {
  ...context,
  school: 'fixture-school',
  server: 'https://fixture.webuntis.com',
  username: 'student',
  password: 'fixture-password',
};
const rpcRecord = {
  id: 101,
  date: 20261020,
  startTime: 800,
  endTime: 845,
  su: [{ id: 1, name: 'MA', longname: 'Mathematics' }],
  ro: [{ id: 2, name: '201', longname: 'Laboratory' }],
  kl: [{ id: 3, name: 'IT1', longname: 'Class description' }],
  info: 'Bring calculator',
  lstext: 'Bring calculator',
  substText: 'New room',
};

test('REST denial falls back to RPC with hidden teachers, class names and complete nonduplicated notes', async () => {
  const methods: string[] = [];
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('token/new')) return new Response(tokenFixture());
      if (path.endsWith('schoolyears'))
        return Response.json([
          {
            id: 1,
            name: 'Fixture',
            dateRange: { start: '2026-01-01', end: '2026-12-31' },
          },
        ]);
      if (path.endsWith('timetable/entries'))
        return new Response(null, { status: 403 });
      expect(path).toBe('/WebUntis/jsonrpc.do');
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { options?: object };
      };
      methods.push(body.method);
      if (body.method === 'authenticate')
        return Response.json({
          result: { sessionId: 'fixture-session', personId: 42, personType: 5 },
        });
      if (body.method === 'getTimetable') {
        expect(body.params.options).toMatchObject({
          element: { id: 42, type: 5 },
          startDate: 20261020,
          endDate: 20261020,
          klasseFields: ['id', 'name', 'longname'],
          showInfo: true,
        });
        return Response.json({ result: [rpcRecord] });
      }
      expect(body.method).toBe('getHolidays');
      return Response.json({ result: [] });
    },
  });
  const db = identityDatabase();
  const accountId = identityAccount(db);
  try {
    const result = await fetchSnapshots(
      client,
      { ...context, examSource: 'timetable' },
      '2026-10-20',
      '2026-10-20',
    );
    expect(result.warnings).toEqual(['RPC_FALLBACK']);
    expect(methods).toEqual(['authenticate', 'getTimetable', 'getHolidays']);
    commitSnapshots(db, accountId, result.snapshots);
    expect(storedEvents(db)).toHaveLength(1);
    expect(storedEvents(db)[0]).toMatchObject({
      sourceId: 'lesson:101',
      start: '2026-10-20T06:00:00.000Z',
      end: '2026-10-20T06:45:00.000Z',
      values: {
        teacher: '',
        class: 'IT1',
        room: '201',
        info: 'Bring calculator\nNew room',
      },
    });
    const previous = storedEvents(db);
    commitSnapshots(db, accountId, result.snapshots);
    expect(storedEvents(db)).toEqual(previous);
  } finally {
    await client.close();
    db.close();
  }
});

test('missing RPC resource lists are allowed, while null or malformed resources still fail validation', () => {
  const data = rpcTimetableSchema.parse([
    {
      id: 9,
      date: 20261020,
      startTime: 800,
      endTime: 845,
      info: 'Published note',
    },
  ]);
  expect(data[0]).toMatchObject({ su: [], te: [], ro: [] });
  expect(normalizeRpc(data, context)[0].values.info).toBe('Published note');
  for (const field of ['su', 'te', 'ro']) {
    for (const value of [null, 'redacted', [{ name: 'Missing ID' }]]) {
      expect(() =>
        rpcTimetableSchema.parse([{ ...rpcRecord, [field]: value }]),
      ).toThrow();
    }
  }
  expect(() =>
    rpcTimetableSchema.parse([{ ...rpcRecord, id: undefined }]),
  ).toThrow();
  expect(() =>
    normalizeRpc(
      rpcTimetableSchema.parse([{ ...rpcRecord, endTime: 700 }]),
      context,
    ),
  ).toThrow();
});

test('unknown RPC statuses fail closed and labelled resources alone never imply exams', () => {
  const lesson = rpcTimetableSchema.parse([
    { ...rpcRecord, activityType: 'Unterricht', info: 'Exam preparation' },
  ]);
  expect(normalizeRpc(lesson, context)[0].kind).toBe('lesson');
  expect(() =>
    normalizeRpc(
      rpcTimetableSchema.parse([{ ...rpcRecord, code: 'unexpected' }]),
      context,
    ),
  ).toThrow();
});

test('school routing cookies stay per account, encoded and bound to the selected school', async () => {
  for (const school of ['School A', 'Schule Ä & B']) {
    const cookies: string[] = [];
    const client = new WebUntisClient(
      { ...credentials, school },
      {
        close: async () => {},
        fetch: async (url, init) => {
          expect(new URL(url).searchParams.get('school')).toBe(school);
          const body = JSON.parse(String(init?.body)) as { method: string };
          if (body.method === 'authenticate')
            return Response.json({
              result: {
                sessionId: 'fixture-session',
                personId: 42,
                personType: 5,
              },
            });
          cookies.push(new Headers(init?.headers).get('cookie') ?? '');
          return Response.json({ result: [] });
        },
      },
    );
    try {
      await client.login();
      await client.holidays();
      await client.login();
      await client.holidays();
      expect(cookies).toEqual(
        Array(2).fill(
          `JSESSIONID=fixture-session; schoolname=${encodeURIComponent('_' + Buffer.from(school).toString('base64'))}`,
        ),
      );
    } finally {
      await client.close();
    }
  }
});

test('exam requests explicitly omit grades, retain classes and still filter assigned students', async () => {
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith('jsonrpc.do'))
        return Response.json({
          result: { sessionId: 'fixture-session', personId: 42, personType: 5 },
        });
      if (target.pathname.endsWith('token/new'))
        return new Response(tokenFixture());
      expect(target.pathname).toBe('/WebUntis/api/exams');
      expect(Object.fromEntries(target.searchParams)).toEqual({
        startDate: '20261020',
        endDate: '20261021',
        klasseId: '-1',
        withGrades: 'false',
      });
      return Response.json({
        data: {
          exams: [
            {
              id: 1,
              name: 'Own exam',
              examDate: 20261020,
              studentClass: ['IT1', 'IT2', 'IT1'],
              grade: 'private-grade',
              assignedStudents: [{ id: 42, displayName: 'private-name' }],
            },
            {
              id: 2,
              name: 'Other exam',
              examDate: 20261020,
              assignedStudents: [{ id: 99 }],
            },
          ],
        },
      });
    },
  });
  try {
    await client.login();
    const data = await client.exams('2026-10-20', '2026-10-21');
    expect(data).toHaveLength(1);
    const event = normalizeExams(data, context)[0];
    expect(event.values.class).toBe('IT1, IT2');
    expect(event.source).not.toContain('private');
    expect(() =>
      examsSchema.parse({
        data: { exams: [{ ...data[0], studentClass: [42] }] },
      }),
    ).toThrow();
  } finally {
    await client.close();
  }
});

test('new exam class values appear in parsed ICS without changing the calendar UID', () => {
  const db = identityDatabase();
  const accountId = identityAccount(db);
  const before = normalizeExams(
    [{ id: 7, name: 'Assessment', subject: 'Math', examDate: 20261020 }],
    context,
  )[0];
  const after = normalizeExams(
    [
      {
        id: 7,
        name: 'Assessment',
        subject: 'Math',
        examDate: 20261020,
        studentClass: ['IT1', 'IT2'],
      },
    ],
    context,
  )[0];
  const snapshot = (event: typeof before) => {
    const data = examSnapshots([event]);
    data[0].examFeed = {
      source: 'exams',
      schoolYearId: '2026',
      dates: [event.date],
      events: [event],
    };
    return data;
  };
  try {
    const templates = defaultTemplates('en');
    templates.exam.description = '{{class}}';
    const feed = saveFeed(db, {
      name: 'Class fields',
      enabled: true,
      pastDays: 10,
      futureDays: 30,
      language: 'en',
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['exam'] }],
      templates,
    });
    const now = new Date('2026-10-20T05:00:00Z');
    const parse = () =>
      new ICAL.Component(
        ICAL.parse(generateCalendar(db, feed, now).body),
      ).getFirstSubcomponent('vevent')!;
    commitSnapshots(db, accountId, snapshot(before));
    const original = parse();
    commitSnapshots(db, accountId, snapshot(after));
    const changed = parse();
    expect(changed.getFirstPropertyValue('uid')).toBe(
      original.getFirstPropertyValue('uid'),
    );
    expect(changed.getFirstPropertyValue('description')).toBe('IT1, IT2');
    expect(changed.getFirstPropertyValue('sequence')).toBe(1);
    commitSnapshots(db, accountId, snapshot(after));
    expect(parse().getFirstPropertyValue('sequence')).toBe(1);
  } finally {
    db.close();
  }
});
