import { betterAuth } from 'better-auth';
import { twoFactor, username } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { hashPassword } from 'better-auth/crypto';
import type { Db } from './db.js';
import { trustedOrigins, type Config } from './config.js';
import {
  usernameSchema,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from '../shared/auth.js';
import { assertSetupAllowed } from './setup.js';
import { adoptLegacyData, insertUser } from './users.js';

export async function createAuth(db: Db, config: Config) {
  const auth = betterAuth({
    appName: 'WebUntis ICS Bridge',
    baseURL: config.publicUrl,
    secret: config.authSecret,
    database: db,
    trustedOrigins: trustedOrigins(config),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    user: {
      // Nullable on purpose: Better Auth adds these columns to an existing
      // table, where SQLite cannot add a NOT NULL column without a default.
      additionalFields: {
        role: { type: 'string', required: false, input: false },
        disabled: { type: 'boolean', required: false, input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: config.publicUrl.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    logger: { disabled: true },
    plugins: [
      username({
        displayUsername: false,
        usernameValidator: (value) => usernameSchema.safeParse(value).success,
      }),
      twoFactor({ issuer: 'WebUntis ICS Bridge' }),
    ],
  });
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  // Earlier versions enforced a single administrator with this index.
  db.exec('DROP INDEX IF EXISTS one_administrator');
  // Preserve an existing email-based administrator, credentials and TOTP data.
  db.prepare("UPDATE user SET username = 'admin' WHERE username IS NULL").run();
  adoptLegacyData(db);
  return auth;
}
export type Auth = Awaited<ReturnType<typeof createAuth>>;

export async function setupAdmin(db: Db, username: string, password: string) {
  const normalizedUsername = usernameSchema.parse(username);
  assertSetupAllowed(db);
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    // Hashing can cross the deadline; recheck under the same lock as insertion.
    // The recheck also guarantees that only the very first user is created here.
    assertSetupAllowed(db);
    insertUser(db, {
      username: normalizedUsername,
      passwordHash,
      role: 'admin',
    });
  }).immediate();
  adoptLegacyData(db);
}
