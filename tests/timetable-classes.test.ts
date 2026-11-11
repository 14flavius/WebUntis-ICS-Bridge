import { expect, test, vi } from 'vitest';
import { enrichTimetableClasses } from '../src/server/webuntis/timetable-classes.js';
import { normalizeTimetable } from '../src/server/webuntis/normalize.js';
import { eventTemplateValues } from '../src/server/webuntis/template-values.js';
import { refreshStoredLabels } from '../src/server/webuntis/stored-labels.js';
import {
  rpcTimetableSchema,
  timetableSchema,
} from '../src/server/webuntis/schemas.js';
import { WebUntisClient } from '../src/server/webuntis/client.js';
import { renderEvent } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import { context, timetableFixture } from './fixtures/events.js';
import { tokenFixture } from './fixtures/token.js';

function fixtures() {
  const timetable = structuredClone(timetableFixture);
  const entry = timetable.days[0].gridEntries[0];
  entry.ids = [101, 102];
  entry.duration.end = '2026-10-20T09:30:00';
  const periods = rpcTimetableSchema.parse(
    [101, 102].map((id, index) => ({
      id,
      date: 20261020,
      startTime: index ? 845 : 800,
      endTime: index ? 930 : 845,
      kl: [{ id: 42, name: 'C10', longname: 'Class 10' }],
    })),
  );
  return { timetable, entry, periods };
}

test('a CLASS in any REST position is used directly without additional requests', async () => {
  for (const position of ['position1', 'position4', 'position7'] as const) {
    const { timetable, entry } = fixtures();
    entry[position] = [
      {
        current: {
          type: 'CLASS',
          shortName: 'C11',
          longName: 'Class 11',
          displayName: 'C11 (Class 11)',
        },
      },
    ];
    const load = vi.fn();
    const result = await enrichTimetableClasses(
      timetableSchema.parse(timetable),
      context.timezone,
      load,
    );
    expect(load).not.toHaveBeenCalled();
    expect(
      eventTemplateValues(normalizeTimetable(result, context)[0]),
    ).toMatchObject({
      classShort: 'C11',
      classLong: 'Class 11',
      classDisplay: 'C11 (Class 11)',
    });
  }
});

test('missing classes are enriched once per window and survive storage, title and notes rendering', async () => {
  const { timetable, periods } = fixtures();
  timetable.days[0].gridEntries[0].position2 = [];
  const before = normalizeTimetable(timetable, context)[0];
  const load = vi.fn(async () => periods);
  const result = await enrichTimetableClasses(
    timetable,
    context.timezone,
    load,
  );
  const event = normalizeTimetable(timetableSchema.parse(result), context)[0];
  expect(load).toHaveBeenCalledOnce();
  expect(timetable.days[0].gridEntries[0].classDetails).toBeUndefined();
  expect(event).toMatchObject({
    sourceId: before.sourceId,
    sourceIds: before.sourceIds,
    start: before.start,
    end: before.end,
    kind: before.kind,
  });
  expect(eventTemplateValues(event)).toMatchObject({
    class: 'C10',
    classShort: 'C10',
    classLong: 'Class 10',
  });
  expect(
    refreshStoredLabels({ ...event, values: { ...event.values, class: '' } })
      .values.class,
  ).toBe('C10');
  const rendered = renderEvent(
    {
      name: 'Test',
      enabled: true,
      pastDays: 1,
      futureDays: 30,
      language: 'de',
      cancellation: 'mark',
      sources: [],
      templates: defaultTemplates('de'),
    },
    {
      ...event,
      accountId: 'fixture',
      revision: 0,
      createdAt: event.start,
      modifiedAt: event.start,
    },
  );
  expect(rendered.title).toBe('Math (C10)');
  expect(rendered.description).toContain('Klasse: C10\n');
  expect(rendered.description.match(/Klasse:/g)).toHaveLength(1);
  expect(rendered.location).toBe('101');
  expect(JSON.parse(event.source).classDetails).toEqual([
    { type: 'CLASS', shortName: 'C10', longName: 'Class 10' },
  ]);
});

test('grouped lessons retain their class across an internal school break', async () => {
  const { timetable, entry, periods } = fixtures();
  entry.ids = [101, 102, 103];
  entry.duration = { start: '2026-10-20T08:30:00', end: '2026-10-20T11:00:00' };
  periods[0].startTime = 830;
  periods[0].endTime = 915;
  periods[1].startTime = 930;
  periods[1].endTime = 1015;
  periods.push({
    ...structuredClone(periods[1]),
    id: 103,
    startTime: 1015,
    endTime: 1100,
  });
  const before = normalizeTimetable(timetable, context)[0];
  const result = await enrichTimetableClasses(
    timetable,
    context.timezone,
    async () => periods,
  );
  const events = normalizeTimetable(result, context);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    sourceId: before.sourceId,
    sourceIds: before.sourceIds,
    start: before.start,
    end: before.end,
    values: { class: 'C10' },
  });
  expect(eventTemplateValues(events[0]).classLong).toBe('Class 10');
});

test.each([
  'missing period',
  'duplicate ID',
  'different date',
  'different start',
  'different end',
  'outside span',
  'different classes',
  'hidden classes',
  'denied day',
])('does not infer a class for %s', async (variant) => {
  const { timetable, periods } = fixtures();
  if (variant === 'missing period') periods.pop();
  if (variant === 'duplicate ID') periods.push(structuredClone(periods[0]));
  if (variant === 'different date') periods[1].date = 20261021;
  if (variant === 'different start') periods[0].startTime = 815;
  if (variant === 'different end') periods[1].endTime = 915;
  if (variant === 'outside span') periods[1].endTime = 1000;
  if (variant === 'different classes')
    periods[1].kl = [{ id: 43, name: 'C11' }];
  if (variant === 'hidden classes') periods[1].kl = [];
  if (variant === 'denied day') timetable.days[0].status = 'NOT_ALLOWED';
  expect(
    await enrichTimetableClasses(
      timetable,
      context.timezone,
      async () => periods,
    ),
  ).toEqual(timetable);
});

test.each([-8509, -32601])(
  'a denied/unavailable optional class lookup (%s) retains REST and is not repeated',
  async (code) => {
    let requests = 0;
    const { timetable } = fixtures();
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
          if (new URL(url).pathname.endsWith('jsonrpc.do')) {
            const { method } = JSON.parse(String(init?.body));
            if (method === 'authenticate')
              return Response.json({
                result: { sessionId: 'fixture', personId: 42, personType: 5 },
              });
            expect(method).toBe('getTimetable');
            requests++;
            return Response.json({ error: { code, message: 'Not available' } });
          }
          if (new URL(url).pathname.endsWith('token/new'))
            return new Response(tokenFixture());
          return Response.json(timetable);
        },
      },
    );
    try {
      await client.login();
      expect(await client.timetable('2026-10-20', '2026-10-20')).toEqual(
        timetable,
      );
      expect(await client.timetable('2026-10-20', '2026-10-20')).toEqual(
        timetable,
      );
      expect(requests).toBe(1);
    } finally {
      await client.close();
    }
  },
);
