import { createHash } from 'node:crypto';
import ical, { ICalEventStatus } from 'ical-generator';
import { DateTime } from 'luxon';
import type { FeedInput, Feed } from '../shared/feeds.js';
import type { StoredEvent } from '../shared/events.js';
import { renderTemplate } from '../shared/templates.js';
import type { Db } from './db.js';
import { calendarEvents } from './calendar-events.js';
import { eventTemplateValues } from './webuntis/template-values.js';
import { calendarTimezone, exportTimezone } from './ical-timezone.js';

export function eventUid(feedId: string, event: StoredEvent): string {
  const hash = createHash('sha256')
    .update(`${event.accountId}:${event.sourceId}`)
    .digest('hex');
  return `${feedId}-${hash}@webuntis-ics-bridge`;
}
export function renderEvent(feed: FeedInput, event: StoredEvent) {
  const template = feed.templates[event.kind];
  const labels = {
    de: {
      lesson: 'Unterricht',
      cancelled: 'Entfällt',
      substitution: 'Vertretung',
      exam: 'Prüfung',
      holiday: 'Ferien',
    },
    en: {
      lesson: 'Lesson',
      cancelled: 'Cancelled',
      substitution: 'Substitution',
      exam: 'Exam',
      holiday: 'Holiday',
    },
  };
  const values = {
    ...eventTemplateValues(event),
    status: labels[feed.language][event.kind],
  };
  if (event.kind === 'exam' && !values.examName)
    values.examName = labels[feed.language].exam;
  return {
    title: renderTemplate(template.title, values),
    description: renderTemplate(template.description, values),
    location: renderTemplate(template.location, values),
  };
}
export function selectedEvents(
  db: Db,
  feed: FeedInput,
  now = new Date(),
): StoredEvent[] {
  return calendarEvents(db).filter((event) => {
    const source = feed.sources.find(
      (source) => source.accountId === event.accountId,
    );
    if (!source?.kinds.includes(event.kind)) return false;
    if (event.kind === 'cancelled' && feed.cancellation === 'omit')
      return false;
    const today = DateTime.fromJSDate(now)
      .setZone(event.timezone)
      .startOf('day');
    const first = today.minus({ days: feed.pastDays }).toISODate()!;
    const last = today.plus({ days: feed.futureDays }).toISODate()!;
    return (
      event.date <= last &&
      (event.allDay ? event.end > first : event.date >= first)
    );
  });
}
interface RenderState {
  hash: string;
  sequence: number;
  modifiedAt: string;
}
interface StateWrite {
  uid: string;
  hash: string;
  sequence: number;
  modifiedAt: string;
}
interface RenderResult {
  body: string;
  etag: string;
  modifiedAt: string;
  writes: StateWrite[];
  publishChanged: boolean;
}

/** Render read-only and collect the state updates instead of writing them.
 * better-sqlite3 runs synchronously on a single connection, so this whole pass
 * already sees a consistent snapshot without holding a write transaction. The
 * ETag is always recomputed from the live data, so a steady calendar poll stays
 * correct while avoiding stale conditional responses. */
function computeCalendar(db: Db, feed: Feed, now: Date): RenderResult {
  const nowIso = now.toISOString();
  const events = selectedEvents(db, feed, now);
  const zones = [
    ...new Set(
      events
        .filter((event) => !event.allDay)
        .map((event) => exportTimezone(event.timezone)),
    ),
  ];
  const calendar = ical({
    name: feed.name,
    prodId: {
      company: 'WebUntis ICS Bridge',
      product: 'webuntis-ics-bridge',
      language: feed.language.toUpperCase(),
    },
    ttl: 600,
    // A calendar-level zone also changes DTSTAMP/CREATED/LAST-MODIFIED
    // in ical-generator. Those must stay UTC; only event times get TZID.
    timezone: {
      name: null,
      generator: calendarTimezone,
    },
    x: zones.length === 1 ? { 'X-WR-TIMEZONE': zones[0] } : {},
  });
  const writes: StateWrite[] = [];
  for (const event of events) {
    const timezone = event.allDay ? null : exportTimezone(event.timezone);
    const rendered = renderEvent(feed, event);
    const uid = eventUid(feed.id, event);
    const cancelled =
      event.kind === 'cancelled' && feed.cancellation === 'cancel';
    const signature = createHash('sha256')
      .update(
        JSON.stringify({
          ...rendered,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          timezone: timezone ?? undefined,
          cancelled,
        }),
      )
      .digest('hex');
    const old = db
      .prepare(
        'SELECT hash, sequence, modifiedAt FROM feed_event_state WHERE feedId = ? AND uid = ?',
      )
      .get(feed.id, uid) as RenderState | undefined;
    const changed = old?.hash !== signature;
    const sequence = (old?.sequence ?? -1) + Number(changed);
    const modifiedAt = changed ? nowIso : old!.modifiedAt;
    if (changed) writes.push({ uid, hash: signature, sequence, modifiedAt });
    calendar.createEvent({
      id: uid,
      start: DateTime.fromISO(event.start, { zone: 'utc' }),
      end: DateTime.fromISO(event.end, { zone: 'utc' }),
      timezone,
      allDay: event.allDay,
      summary: rendered.title,
      description: rendered.description,
      location: rendered.location,
      sequence,
      stamp: new Date(modifiedAt),
      lastModified: new Date(modifiedAt),
      created: new Date(event.createdAt),
      status: cancelled ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
    });
  }
  const body = calendar.toString();
  const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
  const previous = db
    .prepare('SELECT publishedHash, publishedAt FROM feeds WHERE id = ?')
    .get(feed.id) as {
    publishedHash: string | null;
    publishedAt: string | null;
  };
  const publishChanged = previous.publishedHash !== etag;
  const modifiedAt = publishChanged ? nowIso : previous.publishedAt!;
  return { body, etag, modifiedAt, writes, publishChanged };
}
export function generateCalendar(db: Db, feed: Feed, now = new Date()) {
  const render = computeCalendar(db, feed, now);
  // Only an actual change takes a write lock; unchanged polls stay read-only.
  if (render.writes.length || render.publishChanged)
    db.transaction(() => {
      for (const write of render.writes)
        db.prepare(
          `INSERT INTO feed_event_state (feedId, uid, hash, sequence, modifiedAt) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(feedId, uid) DO UPDATE SET hash=excluded.hash, sequence=excluded.sequence, modifiedAt=excluded.modifiedAt`,
        ).run(feed.id, write.uid, write.hash, write.sequence, write.modifiedAt);
      if (render.publishChanged)
        db.prepare(
          'UPDATE feeds SET publishedHash = ?, publishedAt = ? WHERE id = ?',
        ).run(render.etag, render.modifiedAt, feed.id);
    }).immediate();
  return {
    body: render.body,
    etag: render.etag,
    modifiedAt: render.modifiedAt,
  };
}
