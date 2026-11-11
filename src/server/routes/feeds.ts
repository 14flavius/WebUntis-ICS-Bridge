import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { feedInput, PREVIEW_EVENTS_PER_KIND } from '../../shared/feeds.js';
import type { EventKind } from '../../shared/events.js';
import type { Db } from '../db.js';
import {
  assertFeedSources,
  feeds,
  getFeed,
  removeFeed,
  rotateToken,
  saveFeed,
} from '../feeds.js';
import { currentUser } from '../session.js';
import { generateCalendar, selectedEvents, renderEvent } from '../ics.js';
import { idParams } from './accounts.js';

export function feedRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/feeds', async (request) => feeds(db, currentUser(request).id));
  app.post('/api/feeds', async (request) =>
    saveFeed(
      db,
      feedInput.parse(request.body),
      undefined,
      currentUser(request).id,
    ),
  );
  app.put('/api/feeds/:id', async (request) =>
    saveFeed(
      db,
      feedInput.parse(request.body),
      idParams.parse(request.params).id,
      currentUser(request).id,
    ),
  );
  app.delete('/api/feeds/:id', async (request) => {
    removeFeed(db, idParams.parse(request.params).id, currentUser(request).id);
    return { success: true };
  });
  app.post('/api/feeds/:id/duplicate', async (request) => {
    const owner = currentUser(request).id;
    const feed = getFeed(db, idParams.parse(request.params).id, owner);
    return saveFeed(
      db,
      feedInput.parse({ ...feed, name: feed.name.slice(0, 85) + ' (copy)' }),
      undefined,
      owner,
    );
  });
  app.post('/api/feeds/:id/rotate', async (request) =>
    rotateToken(db, idParams.parse(request.params).id, currentUser(request).id),
  );
  app.post('/api/preview', async (request) => {
    const input = feedInput.parse(request.body);
    assertFeedSources(db, input.sources, currentUser(request).id);
    const counts = new Map<EventKind, number>();
    return selectedEvents(db, input)
      .sort((a, b) => a.start.localeCompare(b.start))
      .filter((event) => {
        // Common lessons must not crowd exams or holidays out of their tabs.
        const count = counts.get(event.kind) ?? 0;
        if (count >= PREVIEW_EVENTS_PER_KIND) return false;
        counts.set(event.kind, count + 1);
        return true;
      })
      .map((event) => ({
        sourceId: event.sourceId,
        accountId: event.accountId,
        kind: event.kind,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        ...renderEvent(input, event),
      }));
  });
  app.get('/feed/:token.ics', async (request, reply) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(request.params);
    const row = db
      .prepare('SELECT id FROM feeds WHERE token = ? AND enabled = 1')
      .get(token) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
    const calendar = generateCalendar(db, getFeed(db, row.id));
    reply.header('ETag', calendar.etag);
    reply.header('Last-Modified', new Date(calendar.modifiedAt).toUTCString());
    reply.header('Cache-Control', 'private, no-cache');
    const ifNoneMatch = request.headers['if-none-match'];
    const ifModifiedSince = request.headers['if-modified-since'];
    if (
      ifNoneMatch &&
      ifNoneMatch
        .split(',')
        .some(
          (value) =>
            value.trim().replace(/^W\//, '') === calendar.etag ||
            value.trim() === '*',
        )
    )
      return reply.code(304).send();
    if (
      !ifNoneMatch &&
      ifModifiedSince &&
      Date.parse(ifModifiedSince) >=
        Math.floor(Date.parse(calendar.modifiedAt) / 1000) * 1000
    )
      return reply.code(304).send();
    return reply.type('text/calendar; charset=utf-8').send(calendar.body);
  });
}
