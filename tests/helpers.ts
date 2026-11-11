import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/server/config.js';
import type { Db } from '../src/server/db.js';
import '../src/server/session.js';
export function testConfig(): Config {
  return {
    publicUrl: 'http://127.0.0.1:5173',
    authSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('hex'),
    production: false,
  };
}

const TEST_USER_ID = 'test-user';
/** Route-level tests skip Better Auth: every request acts as one user who owns
 * all fixture rows, including rows seeded directly without an owner. */
export function actAsTestUser(app: FastifyInstance, db: Db) {
  app.addHook('onRequest', async (request) => {
    for (const table of ['webuntis_accounts', 'feeds'])
      db.prepare(`UPDATE ${table} SET ownerId = ? WHERE ownerId IS NULL`).run(
        TEST_USER_ID,
      );
    request.user = {
      id: TEST_USER_ID,
      username: 'test-user',
      role: 'admin',
      twoFactorEnabled: false,
    };
  });
}
