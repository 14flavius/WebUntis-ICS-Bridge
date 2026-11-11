import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createUserInput,
  passwordResetInput,
  updateUserInput,
} from '../../shared/auth.js';
import type { Db } from '../db.js';
import { requireAdmin } from '../session.js';
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  resetUserTwoFactor,
  updateUser,
} from '../users.js';

const userParams = z.object({ id: z.string().min(1).max(100) });
const sensitive = {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
};

/** User administration. Administrators manage identities and access here but
 * never read another user's WebUntis accounts, events or feed links. */
export function adminRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/admin/users', async (request) => {
    requireAdmin(request);
    return listUsers(db);
  });
  app.post('/api/admin/users', sensitive, async (request, reply) => {
    requireAdmin(request);
    const user = await createUser(db, createUserInput.parse(request.body));
    return reply.code(201).send(user);
  });
  app.put('/api/admin/users/:id', async (request) => {
    const actor = requireAdmin(request);
    return updateUser(
      db,
      actor.id,
      userParams.parse(request.params).id,
      updateUserInput.parse(request.body),
    );
  });
  app.post('/api/admin/users/:id/password', sensitive, async (request) => {
    requireAdmin(request);
    await resetUserPassword(
      db,
      userParams.parse(request.params).id,
      passwordResetInput.parse(request.body).password,
    );
    return { success: true };
  });
  app.post('/api/admin/users/:id/two-factor/reset', async (request) => {
    requireAdmin(request);
    resetUserTwoFactor(db, userParams.parse(request.params).id);
    return { success: true };
  });
  app.delete('/api/admin/users/:id', async (request) => {
    const actor = requireAdmin(request);
    deleteUser(db, actor.id, userParams.parse(request.params).id);
    return { success: true };
  });
}
