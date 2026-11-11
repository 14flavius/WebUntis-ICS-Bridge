import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import type { Db } from './db.js';
import rateLimit from '@fastify/rate-limit';
import { fromNodeHeaders } from 'better-auth/node';
import { ZodError } from 'zod';
import { createAuth } from './auth.js';
import { readConfig, trustedOrigins, type Config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { AppError } from './errors.js';
import { migrateApplication } from './schema.js';
import { accountRoutes } from './routes/accounts.js';
import { feedRoutes } from './routes/feeds.js';
import { systemRoutes } from './routes/system.js';
import { adminRoutes } from './routes/admin.js';
import { roleOf } from './users.js';
import { SyncService } from './sync.js';

export async function buildApp(
  db: Db,
  config: Config = readConfig(),
  schedule = false,
) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.decorateRequest('user');
  const allowedOrigins = new Set(trustedOrigins(config));
  migrateApplication(db);
  const auth = await createAuth(db, config);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({ error: error.code });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: 'REQUEST_REJECTED' });
    console.error('Request failed; sensitive error details suppressed.');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    if (config.production)
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !allowedOrigins.has(request.headers.origin ?? '')
    )
      return reply.code(403).send({ error: 'INVALID_ORIGIN' });
    const path = request.url.split('?')[0];
    if (
      path.startsWith('/api/') &&
      !['/api/health', '/api/setup'].includes(path) &&
      !path.startsWith('/api/auth/')
    ) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      // A disabled user loses access immediately, even with a valid cookie.
      if (!session || session.user.disabled || !session.user.username)
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      request.user = {
        id: session.user.id,
        username: session.user.username,
        role: roleOf(session.user.role),
        twoFactorEnabled: !!session.user.twoFactorEnabled,
      };
      if (path.startsWith('/api/admin/') && request.user.role !== 'admin')
        return reply.code(403).send({ error: 'FORBIDDEN' });
    }
  });
  authRoutes(app, db, auth, config);
  const sync = new SyncService(db, config);
  accountRoutes(app, db, config, sync);
  feedRoutes(app, db);
  systemRoutes(app, db, sync);
  adminRoutes(app, db);
  if (schedule) app.addHook('onReady', async () => sync.start());
  app.addHook('onClose', async () => sync.stop());
  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok', application: 'WebUntis ICS Bridge' };
  });
  if (config.production) {
    await app.register(staticFiles, { root: resolve('dist/web') });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/feed/'))
        return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
