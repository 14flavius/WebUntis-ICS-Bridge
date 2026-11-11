import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { setupAdmin } from '../auth.js';
import { setupStatus } from '../setup.js';
import {
  PASSWORD_MAX_LENGTH,
  setupInput,
  usernameSchema,
} from '../../shared/auth.js';
import { currentUser } from '../session.js';
import { isUserDisabled } from '../users.js';
import type { Db } from '../db.js';
import type { Config } from '../config.js';

const allowedAuthPaths = new Set([
  '/sign-in/username',
  '/sign-out',
  '/get-session',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
]);

export function authRoutes(
  app: FastifyInstance,
  db: Db,
  auth: Auth,
  config: Config,
) {
  app.get('/api/setup', async () => setupStatus(db));
  app.post(
    '/api/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = setupInput.parse(request.body);
      await setupAdmin(db, input.username, input.password);
      return reply.code(201).send({ success: true });
    },
  );
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const path = new URL(request.url, config.publicUrl).pathname.slice(
        '/api/auth'.length,
      );
      if (!allowedAuthPaths.has(path))
        return reply.code(404).send({ error: 'NOT_FOUND' });
      if (path === '/sign-in/username') {
        const credentials = z
          .object({
            username: usernameSchema,
            password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
          })
          .parse(request.body);
        // Same answer as a wrong password, so the state is not disclosed.
        if (isUserDisabled(db, credentials.username))
          return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
        request.body = credentials;
      }
      const response = await auth.handler(
        new Request(new URL(request.url, config.publicUrl), {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
  app.get('/api/me', async (request) => currentUser(request));
}
