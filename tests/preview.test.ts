import { expect, test } from 'vitest';
import Fastify from 'fastify';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { feedRoutes } from '../src/server/routes/feeds.js';
import { commitSnapshots } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import {
  eventKinds,
  type CalendarEvent,
  type StoredEvent,
} from '../src/shared/events.js';
import { identityAccount, identityDatabase } from './fixtures/exam-identity.js';
import { lessonFixture } from './fixtures/events.js';
import { actAsTestUser } from './helpers.js';

type Preview = Pick<StoredEvent, 'accountId' | 'kind' | 'start'>;

test('preview includes every selected kind after more than 100 lessons without limiting ICS', async () => {
  const db = identityDatabase();
  const app = Fastify();
  actAsTestUser(app, db);
  feedRoutes(app, db);
  try {
    const accountId = identityAccount(db);
    const otherId = identityAccount(db);
    const today = DateTime.utc().startOf('day');
    const events: CalendarEvent[] = Array.from({ length: 105 }, (_, index) => {
      const start = today.plus({
        days: Math.floor(index / 7),
        hours: 7 + (index % 7),
      });
      return {
        ...lessonFixture(),
        sourceId: `lesson:${index + 1}`,
        sourceIds: [`lesson:${index + 1}`],
        date: start.toISODate()!,
        start: start.toISO()!,
        end: start.plus({ minutes: 45 }).toISO()!,
      };
    });
    for (const kind of eventKinds.filter((kind) => kind !== 'lesson')) {
      for (let index = 0; index < 8; index++) {
        const start = today.plus({ days: 20 + index, hours: 8 });
        const holiday = kind === 'holiday';
        events.push({
          ...lessonFixture(),
          sourceId: `${kind}:${index}`,
          sourceIds: [`${kind}:${index}`],
          kind,
          category: holiday ? 'holiday' : 'lesson',
          date: start.toISODate()!,
          allDay: holiday,
          start: holiday ? start.toISODate()! : start.toISO()!,
          end: holiday
            ? start.plus({ days: 1 }).toISODate()!
            : start.plus({ minutes: 45 }).toISO()!,
        });
      }
    }
    for (const id of [accountId, otherId]) {
      commitSnapshots(
        db,
        id,
        (['lesson', 'holiday'] as const).map((category) => ({
          category,
          start: today.toISODate()!,
          end: today.plus({ days: 30 }).toISODate()!,
          events: events.filter((event) => event.category === category),
          confirmedEmptyDates: [],
        })),
      );
    }
    const feed = saveFeed(db, {
      name: 'Large calendar',
      enabled: true,
      pastDays: 1,
      futureDays: 30,
      language: 'en',
      cancellation: 'mark',
      sources: [{ accountId, kinds: [...eventKinds] }],
      templates: defaultTemplates('en'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: feed,
    });
    expect(response.statusCode).toBe(200);
    const preview = response.json<Preview[]>();
    for (const kind of eventKinds)
      expect(preview.filter((event) => event.kind === kind)).toHaveLength(4);
    expect(preview.every((event) => event.accountId === accountId)).toBe(true);
    expect(preview.map((event) => event.start)).toEqual(
      preview.map((event) => event.start).sort(),
    );
    const filtered = await app.inject({
      method: 'POST',
      url: '/api/preview',
      payload: {
        ...feed,
        cancellation: 'omit',
        sources: [{ accountId, kinds: ['cancelled', 'exam', 'holiday'] }],
      },
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      new Set(filtered.json<Preview[]>().map((event) => event.kind)),
    ).toEqual(new Set(['exam', 'holiday']));
    const calendar = await app.inject(`/feed/${feed.token}.ics`);
    expect(calendar.statusCode).toBe(200);
    const exported = new ICAL.Component(
      ICAL.parse(calendar.body),
    ).getAllSubcomponents('vevent');
    // Each timetable exam now also supplies its independently visible lesson.
    const expectedCount =
      events.length + events.filter((event) => event.kind === 'exam').length;
    expect(exported).toHaveLength(expectedCount);
    expect(
      new Set(exported.map((event) => event.getFirstPropertyValue('uid'))).size,
    ).toBe(expectedCount);
  } finally {
    await app.close();
    db.close();
  }
});
