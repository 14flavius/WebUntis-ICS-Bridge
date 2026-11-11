import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import ICAL from 'ical.js';
import {
  holidayTimetableFixture,
  rpcHolidayFixture,
} from './fixtures/timetable-holidays.js';
import { context } from './fixtures/events.js';
import {
  timetableHolidays,
  mergeHolidays,
} from '../src/server/webuntis/holidays.js';
import { normalizeHolidays } from '../src/server/webuntis/normalize.js';
import {
  WebUntisClient,
  WebUntisError,
} from '../src/server/webuntis/client.js';
import { fetchSnapshots } from '../src/server/webuntis/snapshot.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { generateCalendar } from '../src/server/ics.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { Snapshot } from '../src/shared/events.js';

function clientFixture(denied: boolean, empty = false) {
  const client = new WebUntisClient(
    {
      ...context,
      school: 'fixture',
      server: 'https://fixture.webuntis.com',
      username: 'fixture',
      password: 'fixture',
    },
    {
      close: async () => {},
      fetch: async () => {
        throw new Error('Unexpected network request');
      },
    },
  );
  vi.spyOn(client, 'login').mockResolvedValue();
  vi.spyOn(client, 'years').mockResolvedValue([
    {
      id: 1,
      name: 'Fixture',
      dateRange: { start: '2026-01-01', end: '2026-12-31' },
    },
  ]);
  vi.spyOn(client, 'timetable').mockResolvedValue(holidayTimetableFixture());
  vi.spyOn(client, 'exams').mockResolvedValue([]);
  const holidays = vi.spyOn(client, 'holidays');
  if (denied) holidays.mockRejectedValue(new WebUntisError('forbidden'));
  else holidays.mockResolvedValue(empty ? [] : [rpcHolidayFixture]);
  return client;
}

function database() {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const accountId = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    accountId,
    'Fixture',
    'fixture',
    'https://fixture.webuntis.com',
    'fixture',
    'encrypted',
    context.timezone,
  );
  return { db, accountId };
}

function snapshot(
  events = normalizeHolidays([rpcHolidayFixture], context),
): Snapshot {
  return {
    category: 'holiday',
    start: '2026-11-02',
    end: '2026-11-06',
    events,
    confirmedEmptyDates: [],
  };
}

test('five daily backgrounds produce one full holiday, with stable UID and exclusive all-day ICS end', async () => {
  const client = clientFixture(false);
  const { db, accountId } = database();
  try {
    commitSnapshots(db, accountId, [snapshot()]);
    const original = storedEvents(db);
    const result = await fetchSnapshots(
      client,
      context,
      '2026-11-02',
      '2026-11-06',
    );
    expect(result.warnings).toEqual([]);
    const holiday = result.snapshots.find(
      (item) => item.category === 'holiday',
    )!;
    expect(holiday.events).toHaveLength(1);
    expect(holiday.events[0]).toMatchObject({
      sourceId: 'holiday:901',
      start: '2026-11-02',
      end: '2026-11-09',
      allDay: true,
    });
    commitSnapshots(db, accountId, result.snapshots);
    expect(storedEvents(db)).toEqual(original);
    const feed = saveFeed(db, {
      name: 'Holidays',
      enabled: true,
      language: 'en',
      pastDays: 14,
      futureDays: 90,
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['holiday'] }],
      templates: defaultTemplates('en'),
    });
    const now = new Date('2026-11-03T12:00:00Z');
    const first = generateCalendar(db, feed, now);
    const events = new ICAL.Component(
      ICAL.parse(first.body),
    ).getAllSubcomponents('vevent');
    expect(events).toHaveLength(1);
    const parsed = new ICAL.Event(events[0]);
    expect(parsed.startDate.isDate).toBe(true);
    expect(parsed.startDate.toString()).toBe('2026-11-02');
    expect(parsed.endDate.toString()).toBe('2026-11-09');
    commitSnapshots(db, accountId, result.snapshots);
    expect(generateCalendar(db, feed, now)).toEqual(first);
  } finally {
    await client.close();
    db.close();
  }
});

test.each(['forbidden', 'empty'] as const)(
  '%s RPC cannot turn a background observation into deletion evidence',
  async (mode) => {
    const client = clientFixture(mode === 'forbidden', mode === 'empty');
    const { db, accountId } = database();
    try {
      const existing = normalizeHolidays(
        [
          rpcHolidayFixture,
          { ...rpcHolidayFixture, id: 902, longName: 'Another holiday' },
        ],
        context,
      );
      commitSnapshots(db, accountId, [snapshot(existing)]);
      const before = storedEvents(db);
      const result = await fetchSnapshots(
        client,
        context,
        '2026-11-02',
        '2026-11-06',
      );
      const holiday = result.snapshots.find(
        (item) => item.category === 'holiday',
      )!;
      expect(holiday.deletionCoverage).toBe(false);
      for (const minute of ['01', '02', '03'])
        commitSnapshots(
          db,
          accountId,
          result.snapshots,
          `2026-11-03T12:${minute}:00.000Z`,
        );
      // Diagnostic source JSON may change formats; calendar content and revisions must not.
      expect(
        storedEvents(db).map((event) => ({ ...event, source: '' })),
      ).toEqual(before.map((event) => ({ ...event, source: '' })));
      expect(
        db
          .prepare('SELECT missingSince FROM events WHERE sourceId = ?')
          .get('holiday:902'),
      ).toEqual({ missingSince: null });
      expect(holiday.events).toHaveLength(1);
    } finally {
      await client.close();
      db.close();
    }
  },
);

test('full ranges deduplicate across windows and equivalent RPC IDs; conflicting ranges are rejected', () => {
  const observed = timetableHolidays(holidayTimetableFixture()).holidays;
  const merged = mergeHolidays(
    [rpcHolidayFixture, { ...rpcHolidayFixture, id: 903 }],
    [...observed, ...observed],
  );
  const normalized = normalizeHolidays(merged, context);
  expect(normalized).toHaveLength(1);
  expect(normalized[0].sourceIds).toEqual(['holiday:901', 'holiday:903']);
  expect(() =>
    mergeHolidays(
      [rpcHolidayFixture],
      [{ ...rpcHolidayFixture, endDate: 20261109 }],
    ),
  ).toThrow('WEBUNTIS_CONFLICTING_HOLIDAY');
});

test('unrelated backgrounds and restricted days are ignored; incomplete total ranges never shorten a holiday', () => {
  const data = holidayTimetableFixture();
  data.days[0].backEntries = [
    { type: 'UNKNOWN_BACKGROUND', title: 'Not a holiday' },
  ];
  data.days[1].status = 'NOT_ALLOWED';
  data.days[2].backEntries![0].durationTotal = null;
  data.days[3].backEntries![0].isFullDay = false;
  const result = timetableHolidays(data);
  expect(result.incomplete).toBe(true);
  expect(result.holidays).toHaveLength(1);
  expect(normalizeHolidays(result.holidays, context)[0].end).toBe('2026-11-09');
});

test('invalid holiday payloads, partial-day ranges, out-of-range dates and unknown statuses fail closed', () => {
  for (const replacement of [
    { durationTotal: { start: 'invalid', end: '2026-11-08T23:59:59' } },
    {
      durationTotal: { start: '2026-11-02T08:00', end: '2026-11-08T23:59:59' },
    },
    {
      durationTotal: { start: '2026-12-02T00:00', end: '2026-12-08T23:59:59' },
    },
    { status: 'UNKNOWN' },
    { id: null },
  ]) {
    const data = holidayTimetableFixture();
    Object.assign(data.days[0].backEntries![0], replacement);
    expect(() => timetableHolidays(data)).toThrow();
  }
});

test('an exclusive midnight range end is not expanded by an extra day', () => {
  const data = holidayTimetableFixture();
  for (const day of data.days)
    day.backEntries![0].durationTotal = {
      start: '2026-11-02T00:00',
      end: '2026-11-09T00:00',
    };
  expect(
    normalizeHolidays(timetableHolidays(data).holidays, context)[0].end,
  ).toBe('2026-11-09');
});
