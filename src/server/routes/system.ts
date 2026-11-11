import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { SyncService } from '../sync.js';
import { accounts, assertAccountOwner } from '../accounts.js';
import { idParams } from './accounts.js';
import { calendarEvents } from '../calendar-events.js';
import { currentUser, requireAdmin } from '../session.js';
import { APP_VERSION } from '../../shared/version.js';

export function systemRoutes(app: FastifyInstance, db: Db, sync: SyncService) {
  app.get('/api/status', async (request) => {
    const owner = currentUser(request).id;
    const own = accounts(db, owner);
    const ownIds = new Set(own.map((account) => account.id));
    return {
      accounts: own,
      activeFeeds: (
        db
          .prepare(
            'SELECT count(*) AS count FROM feeds WHERE enabled = 1 AND ownerId = ?',
          )
          .get(owner) as { count: number }
      ).count,
      events: calendarEvents(db).filter((event) => ownIds.has(event.accountId))
        .length,
      syncing: sync.active().filter((id) => ownIds.has(id)),
    };
  });
  app.get('/api/settings', async (request) => {
    currentUser(request);
    return {
      ...(db
        .prepare('SELECT intervalMinutes FROM settings WHERE id = 1')
        .get() as object),
      version: APP_VERSION,
      node: process.version,
      database: 'SQLite',
    };
  });
  // The interval drives one scheduler for every user, so only administrators
  // may change it.
  app.put('/api/settings', async (request) => {
    requireAdmin(request);
    const input = z
      .object({ intervalMinutes: z.number().int().min(5).max(1440) })
      .parse(request.body);
    db.prepare('UPDATE settings SET intervalMinutes = ? WHERE id = 1').run(
      input.intervalMinutes,
    );
    return input;
  });
  app.post('/api/sync', async (request) => {
    const own = accounts(db, currentUser(request).id);
    await sync.syncAccounts(own.map((account) => account.id));
    return { success: true };
  });
  app.post('/api/accounts/:id/sync', async (request) => {
    const id = idParams.parse(request.params).id;
    assertAccountOwner(db, id, currentUser(request).id);
    await sync.syncAccount(id);
    return { success: true };
  });
}
