import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import { eventUid, generateCalendar, renderEvent } from '../src/server/ics.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import { identityAccount, identityDatabase } from './fixtures/exam-identity.js';
import { lessonFixture } from './fixtures/events.js';

test('named zones preserve instants through DST, midnight and aliases in a mixed-account calendar', () => {
  const db = identityDatabase();
  const cases = [
    ['Europe/Berlin', '2026-03-28T08:30'],
    ['Europe/Berlin', '2026-03-29T08:30'],
    ['Europe/Berlin', '2026-10-24T08:30'],
    ['Europe/Berlin', '2026-10-25T08:30'],
    ['America/New_York', '2026-11-02T23:30'],
    ['Europe/Busingen', '2026-11-16T17:30'],
    ['Asia/Kolkata', '2026-11-16T00:15'],
  ];
  try {
    const expected = cases.map(([timezone, local], index) => {
      const accountId = identityAccount(db);
      const start = DateTime.fromISO(local, { zone: timezone });
      const event = {
        ...lessonFixture(),
        sourceId: `lesson:${index}`,
        sourceIds: undefined,
        timezone,
        date: local.slice(0, 10),
        start: start.toUTC().toISO()!,
        end: start.plus({ minutes: 45 }).toUTC().toISO()!,
      };
      event.values.subjectShort = `Case ${index}`;
      event.values.subject = `Case ${index}`;
      event.source = '{}';
      commitSnapshots(db, accountId, [
        {
          category: 'lesson',
          start: event.date,
          end: event.date,
          events: [event],
          confirmedEmptyDates: [],
        },
      ]);
      return { accountId, event, local };
    });
    const feed = saveFeed(db, {
      name: 'Zones',
      enabled: true,
      pastDays: 365,
      futureDays: 365,
      language: 'de',
      cancellation: 'mark',
      sources: expected.map(({ accountId }) => ({
        accountId,
        kinds: ['lesson'],
      })),
      templates: defaultTemplates('de'),
    });
    const now = new Date('2026-07-01T12:00:00Z');
    const output = generateCalendar(db, feed, now);
    const parsed = new ICAL.Component(ICAL.parse(output.body));
    expect(parsed.getFirstPropertyValue('x-wr-timezone')).toBeNull();
    expect(parsed.getAllSubcomponents('vtimezone')).toHaveLength(4);
    for (const component of parsed.getAllSubcomponents('vevent')) {
      const item = expected.find(({ event }) =>
        String(component.getFirstPropertyValue('summary')).startsWith(
          event.values.subject,
        ),
      )!;
      const event = new ICAL.Event(component);
      expect(component.getFirstProperty('dtstart')!.getParameter('tzid')).toBe(
        item.event.timezone,
      );
      expect(event.startDate.toString()).toBe(`${item.local}:00`);
      expect(event.startDate.toJSDate().toISOString()).toBe(item.event.start);
      expect(event.endDate.toJSDate().toISOString()).toBe(item.event.end);
    }
    expect(generateCalendar(db, feed, now)).toEqual(output);
  } finally {
    db.close();
  }
});

test.each(['Europe/Berlin', 'America/New_York', 'europe/berlin', 'UTC'])(
  'switching to %s retains UID, advances sequence once and leaves all-day dates intact',
  (timezone) => {
    const db = identityDatabase();
    try {
      const accountId = identityAccount(db);
      const lesson = lessonFixture();
      lesson.timezone = timezone;
      const holiday = {
        ...lesson,
        category: 'holiday' as const,
        kind: 'holiday' as const,
        sourceId: 'holiday:1',
        sourceIds: undefined,
        allDay: true,
        start: '2026-10-20',
        end: '2026-10-22',
      };
      commitSnapshots(
        db,
        accountId,
        [lesson, holiday].map((event) => ({
          category: event.category,
          start: event.date,
          end: event.date,
          events: [event],
          confirmedEmptyDates: [],
        })),
      );
      const feed = saveFeed(db, {
        name: 'Berlin',
        enabled: true,
        pastDays: 14,
        futureDays: 90,
        language: 'de',
        cancellation: 'mark',
        sources: [{ accountId, kinds: ['lesson', 'holiday'] }],
        templates: defaultTemplates('de'),
      });
      const now = new Date('2026-10-20T05:00:00Z');
      const before = generateCalendar(db, feed, now);
      const stored = storedEvents(db).find((event) => !event.allDay)!;
      const legacyHash = createHash('sha256')
        .update(
          JSON.stringify({
            ...renderEvent(feed, stored),
            start: stored.start,
            end: stored.end,
            allDay: false,
            cancelled: false,
          }),
        )
        .digest('hex');
      db.prepare(
        'UPDATE feed_event_state SET hash = ? WHERE feedId = ? AND uid = ?',
      ).run(legacyHash, feed.id, eventUid(feed.id, stored));
      const after = generateCalendar(db, feed, now);
      const parsed = new ICAL.Component(ICAL.parse(after.body));
      const events = parsed.getAllSubcomponents('vevent');
      expect(parsed.getFirstPropertyValue('x-wr-timezone')).toBe(
        timezone === 'europe/berlin' ? 'Europe/Berlin' : timezone,
      );
      const timed = events.find(
        (component) => !new ICAL.Event(component).startDate.isDate,
      )!;
      expect(timed.getFirstPropertyValue('sequence')).toBe(1);
      for (const component of events) {
        for (const property of ['dtstamp', 'created', 'last-modified']) {
          const timestamp = component.getFirstPropertyValue(
            property,
          ) as ICAL.Time;
          expect(timestamp.toString()).toMatch(/Z$/);
        }
        const stamp = component.getFirstPropertyValue('dtstamp') as ICAL.Time;
        expect(stamp.toJSDate().toISOString()).toBe(now.toISOString());
      }
      const originalUids = new ICAL.Component(ICAL.parse(before.body))
        .getAllSubcomponents('vevent')
        .map((component) => component.getFirstPropertyValue('uid'));
      expect(
        events.map((component) => component.getFirstPropertyValue('uid')),
      ).toEqual(originalUids);
      const allDay = events.find(
        (component) => new ICAL.Event(component).startDate.isDate,
      )!;
      expect(
        allDay.getFirstProperty('dtstart')!.getParameter('tzid'),
      ).toBeUndefined();
      expect(new ICAL.Event(allDay).startDate.toString()).toBe(holiday.start);
      expect(new ICAL.Event(allDay).endDate.toString()).toBe(holiday.end);
      expect(allDay.getFirstPropertyValue('sequence')).toBe(0);
      expect(generateCalendar(db, feed, now)).toEqual(after);
    } finally {
      db.close();
    }
  },
);
