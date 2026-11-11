import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountInput } from '../../shared/types.js';
import {
  accounts,
  accountCredentials,
  assertAccountOwner,
  saveAccount,
  testConnection,
  removeAccount,
  testAccountDraft,
} from '../accounts.js';
import type { Db } from '../db.js';
import type { Config } from '../config.js';
import { WebUntisClient } from '../webuntis/client.js';
import { searchSchools } from '../webuntis/schools.js';
import type { SyncService } from '../sync.js';
import { cachedTimetableExams, examIdentities } from '../exam-identities.js';
import { currentUser } from '../session.js';
export const idParams = z.object({ id: z.uuid() });
export function accountRoutes(
  app: FastifyInstance,
  db: Db,
  config: Config,
  sync: SyncService,
) {
  app.get('/api/accounts', async (request) =>
    accounts(db, currentUser(request).id),
  );
  app.get('/api/schools', async (request) => {
    currentUser(request);
    return searchSchools(
      z.object({ q: z.string().min(3).max(150) }).parse(request.query).q,
    );
  });
  app.post('/api/accounts', async (request, reply) => {
    const id = await saveAccount(
      db,
      accountInput.parse(request.body),
      config.encryptionKey,
      undefined,
      currentUser(request).id,
    );
    sync.startAccount(id);
    return reply.code(201).send({ id });
  });
  app.post(
    '/api/accounts/test',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      currentUser(request);
      return testAccountDraft(
        accountInput.required({ password: true }).parse(request.body),
      );
    },
  );
  app.put('/api/accounts/:id', async (request) => {
    const id = idParams.parse(request.params).id;
    const owner = currentUser(request).id;
    const previous = accounts(db, owner).find((account) => account.id === id);
    const input = accountInput.parse(request.body);
    await saveAccount(db, input, config.encryptionKey, id, owner);
    if (input.examSource && input.examSource !== previous?.examSource)
      sync.startAccount(id, { restartActive: true });
    return { id };
  });
  app.delete('/api/accounts/:id', async (request) => {
    removeAccount(
      db,
      idParams.parse(request.params).id,
      currentUser(request).id,
    );
    return { success: true };
  });
  app.post('/api/accounts/:id/test', async (request) => {
    const id = idParams.parse(request.params).id;
    assertAccountOwner(db, id, currentUser(request).id);
    const credentials = accountCredentials(db, id, config.encryptionKey);
    const client = new WebUntisClient(credentials);
    try {
      // A connectivity sample is not a sync and must never overwrite its
      // warnings, timestamps or a concurrently committed result.
      return await testConnection(client, credentials.timezone, {
        previousExams: examIdentities(db, id),
        timetable: cachedTimetableExams(db, id),
      });
    } finally {
      await client.close();
    }
  });
}
