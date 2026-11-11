import type { FastifyRequest } from 'fastify';
import type { SessionUser } from '../shared/auth.js';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** Every data route is scoped to this user. Failing closed here means a route
 * can never run unscoped if the authentication hook was skipped. */
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new AppError('UNAUTHORIZED', 401);
  return request.user;
}

export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = currentUser(request);
  if (user.role !== 'admin') throw new AppError('FORBIDDEN', 403);
  return user;
}
