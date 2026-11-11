import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { testConfig } from './helpers.js';
import { commitSnapshots } from '../src/server/events.js';
import { saveFeed, rotateToken } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import { eventKinds } from '../src/shared/events.js';
import { generateCalendar } from '../src/server/ics.js';
import { lessonFixture } from './fixtures/events.js';

test('valid deterministic ICS, stable UID and revisions, token rotation, HTTP cache', async () => {
  const db = openDatabase(':memory:');
  const app = await buildApp(db, testConfig());
  const accountId = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    accountId,
    'Student A',
    'school',
    'https://school.webuntis.com',
    'student',
    'encrypted',
    'Europe/Berlin',
  );
  const event = lessonFixture();
  const today = new Date().toISOString().slice(0, 10);
  event.date = today;
  event.start = `${today}T06:00:00.000Z`;
  event.end = `${today}T06:45:00.000Z`;
  commitSnapshots(db, accountId, [
    {
      category: 'lesson',
      start: today,
      end: today,
      events: [event],
      confirmedEmptyDates: [],
    },
  ]);
  let feed = saveFeed(db, {
    name: 'Calendar',
    enabled: true,
    pastDays: 14,
    futureDays: 90,
    language: 'de',
    cancellation: 'mark',
    sources: [{ accountId, kinds: [...eventKinds] }],
    templates: defaultTemplates('de'),
  });
  const first = generateCalendar(db, feed);
  expect(generateCalendar(db, feed)).toEqual(first);
  const parsed = new ICAL.Component(ICAL.parse(first.body));
  const events = parsed.getAllSubcomponents('vevent');
  expect(events).toHaveLength(1);
  const uid = events[0].getFirstPropertyValue('uid');
  expect(events[0].getFirstPropertyValue('sequence')).toBe(0);
  expect(new ICAL.Event(events[0]).startDate.toJSDate().toISOString()).toBe(
    event.start,
  );
  const url = `/feed/${feed.token}.ics`;
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => app.inject(url)),
  );
  expect(new Set(responses.map((response) => response.body)).size).toBe(1);
  expect(responses[0].headers['content-type']).toContain('text/calendar');
  expect(
    (await app.inject({ url, headers: { 'if-none-match': first.etag } }))
      .statusCode,
  ).toBe(304);
  expect(
    (
      await app.inject({
        url,
        headers: {
          'if-modified-since': responses[0].headers['last-modified'] as string,
        },
      })
    ).statusCode,
  ).toBe(304);
  feed.templates.lesson.title = 'Changed {{subject}}';
  feed = saveFeed(db, feed, feed.id);
  const changed = generateCalendar(db, feed);
  const revised = new ICAL.Component(
    ICAL.parse(changed.body),
  ).getFirstSubcomponent('vevent')!;
  expect(revised.getFirstPropertyValue('uid')).toBe(uid);
  expect(revised.getFirstPropertyValue('sequence')).toBe(1);
  expect(revised.getFirstPropertyValue('summary')).toBe('Changed Math');
  expect(changed.etag).not.toBe(first.etag);
  const rotated = rotateToken(db, feed.id);
  expect(rotated.token).not.toBe(feed.token);
  expect((await app.inject(url)).statusCode).toBe(404);
  saveFeed(db, { ...rotated, enabled: false }, feed.id);
  expect((await app.inject(`/feed/${rotated.token}.ics`)).statusCode).toBe(404);
  await app.close();
  db.close();
});

test('multiple accounts, all-day holidays, cancellation policies and escaped text parse correctly', async () => {
  const db = openDatabase(':memory:');
  const app = await buildApp(db, testConfig());
  const today = new Date().toISOString().slice(0, 10);
  const accountIds = [randomUUID(), randomUUID()];
  for (const accountId of accountIds) {
    db.prepare(
      'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
    ).run(
      accountId,
      'Student',
      'school',
      'https://school.webuntis.com',
      'student',
      'encrypted',
      'Europe/Berlin',
    );
    const event = lessonFixture();
    event.date = today;
    event.start = `${today}T06:00:00.000Z`;
    event.end = `${today}T06:45:00.000Z`;
    event.kind = 'cancelled';
    event.values.info = 'comma, semicolon; slash\\ and newline\nBEGIN:VEVENT';
    commitSnapshots(db, accountId, [
      {
        category: 'lesson',
        start: today,
        end: today,
        events: [event],
        confirmedEmptyDates: [],
      },
    ]);
  }
  const holiday = {
    ...lessonFixture(),
    sourceId: 'holiday:1',
    sourceIds: undefined,
    category: 'holiday' as const,
    kind: 'holiday' as const,
    date: today,
    allDay: true,
    start: today,
    end: new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10),
  };
  holiday.values.holidayName = 'Holiday';
  commitSnapshots(db, accountIds[0], [
    {
      category: 'holiday',
      start: today,
      end: today,
      events: [holiday],
      confirmedEmptyDates: [],
    },
  ]);
  let feed = saveFeed(db, {
    name: 'Combined',
    enabled: true,
    pastDays: 14,
    futureDays: 90,
    language: 'en',
    cancellation: 'mark',
    sources: accountIds.map((accountId) => ({
      accountId,
      kinds: [...eventKinds],
    })),
    templates: defaultTemplates('en'),
  });
  const parse = () =>
    new ICAL.Component(
      ICAL.parse(generateCalendar(db, feed).body),
    ).getAllSubcomponents('vevent');
  const events = parse();
  expect(events).toHaveLength(3);
  expect(
    new Set(events.map((event) => event.getFirstPropertyValue('uid'))).size,
  ).toBe(3);
  const lesson = events.find(
    (event) =>
      event.getFirstPropertyValue('summary') === 'Cancelled · Math · Teacher A',
  )!;
  expect(lesson.getFirstPropertyValue('status')).toBe('CONFIRMED');
  expect(lesson.getFirstPropertyValue('description')).toContain('BEGIN:VEVENT');
  const holidayComponent = events.find(
    (event) => event.getFirstPropertyValue('summary') === 'Holiday',
  )!;
  expect(new ICAL.Event(holidayComponent).startDate.isDate).toBe(true);
  expect(new ICAL.Event(holidayComponent).endDate.toString()).toBe(holiday.end);
  feed = saveFeed(db, { ...feed, cancellation: 'cancel' }, feed.id);
  expect(
    parse().filter(
      (event) => event.getFirstPropertyValue('status') === 'CANCELLED',
    ),
  ).toHaveLength(2);
  feed = saveFeed(db, { ...feed, cancellation: 'omit' }, feed.id);
  expect(parse()).toHaveLength(1);
  await app.close();
  db.close();
});
