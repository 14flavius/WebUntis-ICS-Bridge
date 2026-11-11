import { afterEach, expect, test, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { hashPassword } from 'better-auth/crypto';
import { openDatabase } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { setupAdmin } from '../src/server/auth.js';
import { testConfig } from './helpers.js';

afterEach(() => vi.restoreAllMocks());
const credentials = {
  username: 'My-Admin',
  password: 'Setup-test-password-123!',
};

test('setup expires at two hours, reload cannot reopen it, restart can, and existing admin login stays available', async () => {
  const uptime = vi.spyOn(process, 'uptime').mockReturnValue(0);
  const db = openDatabase(':memory:');
  const config = testConfig();
  let app = await buildApp(db, config);
  const setupRequest = () =>
    app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { origin: config.publicUrl },
      payload: credentials,
    });
  try {
    expect((await app.inject('/api/setup')).json()).toEqual({
      required: true,
      expired: false,
      remainingSeconds: 7200,
    });
    uptime.mockReturnValue(7199.5);
    expect((await app.inject('/api/setup')).json()).toMatchObject({
      expired: false,
      remainingSeconds: 1,
    });
    uptime.mockReturnValue(7200);
    for (let reload = 0; reload < 2; reload++) {
      expect((await app.inject('/api/setup')).json()).toEqual({
        required: true,
        expired: true,
        remainingSeconds: 0,
      });
      const rejected = await setupRequest();
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error).toBe('SETUP_EXPIRED');
    }
    expect(db.prepare('SELECT count(*) AS total FROM user').get()).toEqual({
      total: 0,
    });
    await app.close();
    // A new process has a fresh monotonic uptime, while retaining its database.
    uptime.mockReturnValue(0);
    app = await buildApp(db, config);
    expect((await setupRequest()).statusCode).toBe(201);
    uptime.mockReturnValue(7201);
    expect((await app.inject('/api/setup')).json()).toEqual({
      required: false,
      expired: false,
      remainingSeconds: 0,
    });
    expect((await setupRequest()).statusCode).toBe(409);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: config.publicUrl },
      payload: { ...credentials, username: 'MY-ADMIN' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe('my-admin');
    for (const path of ['/api/auth/sign-in/email', '/api/auth/sign-up/email']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers: { origin: config.publicUrl },
            payload: {
              email: 'unused@example.test',
              password: credentials.password,
            },
          })
        ).statusCode,
      ).toBe(404);
    }
  } finally {
    await app.close();
    db.close();
  }
});

test('a password hash finishing after the deadline cannot create an administrator', async () => {
  const db = openDatabase(':memory:');
  const app = await buildApp(db, testConfig());
  try {
    vi.spyOn(process, 'uptime').mockReturnValueOnce(7199).mockReturnValue(7200);
    await expect(
      setupAdmin(db, credentials.username, credentials.password),
    ).rejects.toMatchObject({ code: 'SETUP_EXPIRED' });
    expect(db.prepare('SELECT count(*) AS total FROM user').get()).toEqual({
      total: 0,
    });
    expect(db.prepare('SELECT count(*) AS total FROM account').get()).toEqual({
      total: 0,
    });
  } finally {
    await app.close();
    db.close();
  }
});

test('legacy email administrator gains admin username without changing its password or identity', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  const legacy = betterAuth({
    database: db,
    secret: config.authSecret,
    baseURL: config.publicUrl,
    emailAndPassword: { enabled: true },
    plugins: [twoFactor()],
    logger: { disabled: true },
  });
  await (await getMigrations(legacy.options)).runMigrations();
  const passwordHash = await hashPassword(credentials.password);
  db.prepare(
    'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'legacy-user',
    'Administrator',
    'legacy@example.test',
    0,
    Date.now(),
    Date.now(),
    0,
  );
  db.prepare(
    'INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
  ).run(
    'legacy-account',
    'legacy-user',
    'credential',
    'legacy-user',
    passwordHash,
    Date.now(),
    Date.now(),
  );
  const app = await buildApp(db, config);
  try {
    expect(db.prepare('SELECT id, email, username FROM user').get()).toEqual({
      id: 'legacy-user',
      email: 'legacy@example.test',
      username: 'admin',
    });
    expect(db.prepare('SELECT password FROM account').get()).toEqual({
      password: passwordHash,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: config.publicUrl },
      payload: { username: 'admin', password: credentials.password },
    });
    expect(login.statusCode).toBe(200);
    expect((await app.inject('/api/setup')).json().required).toBe(false);
  } finally {
    await app.close();
    db.close();
  }
});
