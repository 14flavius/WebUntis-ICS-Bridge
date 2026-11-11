import { afterAll, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { saveAccount } from '../src/server/accounts.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { ManagedUser } from '../src/shared/auth.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const db = openDatabase(':memory:');
const app = await buildApp(db, config);
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  db.close();
});

const adminPassword = 'Administrator-password-1!';
const userPassword = 'Ordinary-user-password-2!';

const SIGN_IN_WINDOW_MS = 11_000;
/** Better Auth allows three sign-ins per ten seconds. Move the clock past that
 * window instead of weakening the production limit for tests. */
function passSignInWindow() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + SIGN_IN_WINDOW_MS);
}

/** One browser: keeps its own cookies across requests. */
function client(target: () => FastifyInstance = () => app) {
  const cookies = new Map<string, string>();
  return async (method: string, url: string, payload?: object) => {
    const response = await target().inject({
      method: method as 'GET',
      url,
      headers: {
        origin: config.publicUrl,
        cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join('; '),
      },
      payload,
    });
    for (const cookie of response.cookies)
      cookies.set(cookie.name, cookie.value);
    return response;
  };
}
function userId(username: string) {
  return (
    db.prepare('SELECT id FROM user WHERE username = ?').get(username) as {
      id: string;
    }
  ).id;
}
async function seedAccount(ownerId: string, name: string) {
  return saveAccount(
    db,
    {
      name,
      school: 'fixture',
      server: 'https://fixture.webuntis.com',
      username: 'student',
      password: 'fixture-password',
      timezone: 'Europe/Berlin',
    },
    config.encryptionKey,
    undefined,
    ownerId,
  );
}
function feedInput(accountId: string, name: string) {
  return {
    name,
    enabled: true,
    pastDays: 14,
    futureDays: 90,
    language: 'en' as const,
    cancellation: 'mark' as const,
    sources: [{ accountId, kinds: ['lesson' as const] }],
    templates: defaultTemplates('en'),
  };
}

const admin = client();
const alice = client();
const bob = client();

test('the first user becomes administrator and creates further users', async () => {
  expect(
    (
      await admin('POST', '/api/setup', {
        username: 'boss',
        password: adminPassword,
      })
    ).statusCode,
  ).toBe(201);
  // Setup stays a one-time path; it can never add a second user.
  expect(
    (
      await admin('POST', '/api/setup', {
        username: 'intruder',
        password: adminPassword,
      })
    ).statusCode,
  ).toBe(409);
  await admin('POST', '/api/auth/sign-in/username', {
    username: 'boss',
    password: adminPassword,
  });
  expect((await admin('GET', '/api/me')).json()).toMatchObject({
    username: 'boss',
    role: 'admin',
  });
  for (const username of ['alice', 'bob']) {
    const created = await admin('POST', '/api/admin/users', {
      username,
      password: userPassword,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ username, role: 'user' });
  }
  expect(
    (
      await admin('POST', '/api/admin/users', {
        username: 'ALICE',
        password: userPassword,
      })
    ).json(),
  ).toEqual({ error: 'USERNAME_TAKEN' });
  expect(
    (
      await admin('POST', '/api/admin/users', {
        username: 'short-pw',
        password: 'too-short',
      })
    ).statusCode,
  ).toBe(400);
  const listed = (await admin('GET', '/api/admin/users')).json<ManagedUser[]>();
  expect(listed.map((user) => user.username)).toEqual(['alice', 'bob', 'boss']);
  expect(JSON.stringify(listed)).not.toContain('password');
});

test('ordinary users cannot reach administration or shared settings', async () => {
  for (const [session, username] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const)
    expect(
      (
        await session('POST', '/api/auth/sign-in/username', {
          username,
          password: userPassword,
        })
      ).statusCode,
    ).toBe(200);
  expect((await alice('GET', '/api/me')).json()).toMatchObject({
    username: 'alice',
    role: 'user',
  });
  expect((await alice('GET', '/api/admin/users')).statusCode).toBe(403);
  expect(
    (
      await alice('POST', '/api/admin/users', {
        username: 'mallory',
        password: userPassword,
        role: 'admin',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await alice('PUT', `/api/admin/users/${userId('alice')}`, {
        role: 'admin',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await alice('PUT', '/api/settings', { intervalMinutes: 5 })).statusCode,
  ).toBe(403);
  expect((await alice('GET', '/api/settings')).statusCode).toBe(200);
  expect(
    (await admin('PUT', '/api/settings', { intervalMinutes: 15 })).statusCode,
  ).toBe(200);
});

test('accounts and feeds are private to their owner, including from administrators', async () => {
  const aliceAccount = await seedAccount(userId('alice'), 'Alice child');
  const bobAccount = await seedAccount(userId('bob'), 'Bob child');
  const aliceFeed = (
    await alice('POST', '/api/feeds', feedInput(aliceAccount, 'Alice feed'))
  ).json<{ id: string; token: string }>();
  expect(aliceFeed.token).toHaveLength(43);

  expect((await alice('GET', '/api/accounts')).json()).toHaveLength(1);
  expect((await bob('GET', '/api/accounts')).json()).toMatchObject([
    { id: bobAccount },
  ]);
  expect((await admin('GET', '/api/accounts')).json()).toEqual([]);
  expect((await admin('GET', '/api/feeds')).json()).toEqual([]);
  expect((await bob('GET', '/api/status')).json()).toMatchObject({
    activeFeeds: 0,
  });
  expect((await alice('GET', '/api/status')).json()).toMatchObject({
    activeFeeds: 1,
  });

  // Foreign rows answer exactly like missing rows.
  for (const intruder of [bob, admin]) {
    const edit = await intruder('PUT', `/api/accounts/${aliceAccount}`, {
      name: 'Taken over',
      school: 'fixture',
      server: 'https://fixture.webuntis.com',
      username: 'student',
      timezone: 'Europe/Berlin',
    });
    expect(edit.statusCode).toBe(404);
    expect(
      (await intruder('DELETE', `/api/accounts/${aliceAccount}`)).statusCode,
    ).toBe(404);
    expect(
      (await intruder('POST', `/api/accounts/${aliceAccount}/sync`)).statusCode,
    ).toBe(404);
    expect(
      (await intruder('POST', `/api/accounts/${aliceAccount}/test`)).statusCode,
    ).toBe(404);
    expect(
      (
        await intruder(
          'PUT',
          `/api/feeds/${aliceFeed.id}`,
          feedInput(aliceAccount, 'Renamed'),
        )
      ).statusCode,
    ).toBe(404);
    for (const action of ['rotate', 'duplicate'])
      expect(
        (await intruder('POST', `/api/feeds/${aliceFeed.id}/${action}`))
          .statusCode,
      ).toBe(404);
    expect(
      (await intruder('DELETE', `/api/feeds/${aliceFeed.id}`)).statusCode,
    ).toBe(404);
    // Neither a new feed nor a preview may read someone else's account.
    for (const url of ['/api/feeds', '/api/preview'])
      expect(
        (await intruder('POST', url, feedInput(aliceAccount, 'Spy'))).json(),
      ).toEqual({ error: 'ACCOUNT_NOT_FOUND' });
  }
  expect((await alice('GET', '/api/accounts')).json()).toMatchObject([
    { id: aliceAccount, name: 'Alice child' },
  ]);
  expect((await alice('GET', '/api/feeds')).json()).toMatchObject([
    { id: aliceFeed.id, name: 'Alice feed', token: aliceFeed.token },
  ]);
  // The administration list exposes counts only.
  const listed = (await admin('GET', '/api/admin/users')).json<ManagedUser[]>();
  expect(listed.find((user) => user.username === 'alice')).toMatchObject({
    accounts: 1,
    feeds: 1,
  });
  expect(JSON.stringify(listed)).not.toContain(aliceFeed.token);
  expect(JSON.stringify(listed)).not.toContain('Alice child');
});

test('administrators cannot lock themselves out or remove the last administrator', async () => {
  const boss = userId('boss');
  for (const change of [{ role: 'user' }, { disabled: true }])
    expect(
      (await admin('PUT', `/api/admin/users/${boss}`, change)).json(),
    ).toEqual({ error: 'CANNOT_MODIFY_SELF' });
  expect((await admin('DELETE', `/api/admin/users/${boss}`)).json()).toEqual({
    error: 'CANNOT_MODIFY_SELF',
  });
  // A second administrator may not demote, disable or delete the only other one
  // while being disabled themselves.
  const alicesId = userId('alice');
  expect(
    (await admin('PUT', `/api/admin/users/${alicesId}`, { role: 'admin' }))
      .statusCode,
  ).toBe(200);
  expect((await alice('GET', '/api/admin/users')).statusCode).toBe(200);
  db.prepare('UPDATE user SET disabled = 1 WHERE id = ?').run(boss);
  for (const change of [{ role: 'user' }, { disabled: true }])
    expect(
      (await alice('PUT', `/api/admin/users/${alicesId}`, change)).json(),
    ).toEqual({ error: 'CANNOT_MODIFY_SELF' });
  db.prepare('UPDATE user SET disabled = 0 WHERE id = ?').run(boss);
  expect(
    (await admin('PUT', `/api/admin/users/${alicesId}`, { role: 'user' }))
      .statusCode,
  ).toBe(200);
  expect((await alice('GET', '/api/admin/users')).statusCode).toBe(403);
  expect((await admin('GET', '/api/admin/users')).statusCode).toBe(200);
});

test('disabling ends sessions and blocks sign-in; a password reset signs devices out', async () => {
  const bobsId = userId('bob');
  expect((await bob('GET', '/api/me')).statusCode).toBe(200);
  expect(
    (await admin('PUT', `/api/admin/users/${bobsId}`, { disabled: true }))
      .statusCode,
  ).toBe(200);
  expect((await bob('GET', '/api/me')).statusCode).toBe(401);
  const blocked = await client()('POST', '/api/auth/sign-in/username', {
    username: 'bob',
    password: userPassword,
  });
  expect(blocked.statusCode).toBe(401);
  expect(blocked.cookies).toEqual([]);
  await admin('PUT', `/api/admin/users/${bobsId}`, { disabled: false });

  const alicesId = userId('alice');
  const newPassword = 'A-brand-new-password-3!';
  expect((await alice('GET', '/api/me')).statusCode).toBe(200);
  expect(
    (
      await admin('POST', `/api/admin/users/${alicesId}/password`, {
        password: newPassword,
      })
    ).statusCode,
  ).toBe(200);
  expect((await alice('GET', '/api/me')).statusCode).toBe(401);
  const stored = db
    .prepare('SELECT password FROM account WHERE userId = ?')
    .get(alicesId) as { password: string };
  expect(stored.password).not.toContain(newPassword);
  const again = client();
  passSignInWindow();
  expect(
    (
      await again('POST', '/api/auth/sign-in/username', {
        username: 'alice',
        password: newPassword,
      })
    ).statusCode,
  ).toBe(200);
  expect((await again('GET', '/api/me')).json()).toMatchObject({
    username: 'alice',
  });
});

test('an administrator can reset a lost second factor', async () => {
  const bobsId = userId('bob');
  db.prepare(
    "INSERT INTO twoFactor (id, secret, backupCodes, userId) VALUES ('tf', 'secret', 'codes', ?)",
  ).run(bobsId);
  db.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE id = ?').run(bobsId);
  expect(
    (await admin('POST', `/api/admin/users/${bobsId}/two-factor/reset`))
      .statusCode,
  ).toBe(200);
  expect(db.prepare('SELECT count(*) AS count FROM twoFactor').get()).toEqual({
    count: 0,
  });
  const listed = (await admin('GET', '/api/admin/users')).json<ManagedUser[]>();
  expect(listed.find((user) => user.id === bobsId)?.twoFactorEnabled).toBe(
    false,
  );
});

test('deleting a user removes their accounts, events, feeds and calendar links', async () => {
  const alicesId = userId('alice');
  const [feed] = db
    .prepare('SELECT token FROM feeds WHERE ownerId = ?')
    .all(alicesId) as { token: string }[];
  expect((await app.inject(`/feed/${feed.token}.ics`)).statusCode).toBe(200);
  expect(
    (await admin('DELETE', `/api/admin/users/${alicesId}`)).statusCode,
  ).toBe(200);
  expect((await app.inject(`/feed/${feed.token}.ics`)).statusCode).toBe(404);
  for (const table of ['webuntis_accounts', 'feeds'])
    expect(
      db
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE ownerId = ?`)
        .get(alicesId),
    ).toEqual({ count: 0 });
  expect(
    db
      .prepare('SELECT count(*) AS count FROM session WHERE userId = ?')
      .get(alicesId),
  ).toEqual({ count: 0 });
  // Bob's data is untouched.
  expect((await bob('GET', '/api/me')).statusCode).toBe(401);
  expect(
    db
      .prepare(
        'SELECT count(*) AS count FROM webuntis_accounts WHERE ownerId = ?',
      )
      .get(userId('bob')),
  ).toEqual({ count: 1 });
  expect(
    (await admin('DELETE', `/api/admin/users/${alicesId}`)).statusCode,
  ).toBe(404);
});

test('a single-administrator installation upgrades in place', async () => {
  const legacy = openDatabase(':memory:');
  let legacyApp = await buildApp(legacy, config);
  const browser = client(() => legacyApp);
  try {
    await browser('POST', '/api/setup', {
      username: 'owner',
      password: adminPassword,
    });
    const account = await saveAccount(
      legacy,
      {
        name: 'Existing',
        school: 'fixture',
        server: 'https://fixture.webuntis.com',
        username: 'student',
        password: 'fixture-password',
        timezone: 'Europe/Berlin',
      },
      config.encryptionKey,
    );
    saveFeed(legacy, feedInput(account, 'Existing feed'));
    // Recreate the pre-upgrade state: no role, no owners, the old invariant.
    legacy.exec(`
      UPDATE user SET role = NULL, disabled = NULL;
      CREATE UNIQUE INDEX one_administrator ON user ((1));
    `);
    await legacyApp.close();
    legacyApp = await buildApp(legacy, config);
    passSignInWindow();
    await browser('POST', '/api/auth/sign-in/username', {
      username: 'owner',
      password: adminPassword,
    });
    expect((await browser('GET', '/api/me')).json()).toMatchObject({
      role: 'admin',
    });
    expect((await browser('GET', '/api/accounts')).json()).toHaveLength(1);
    expect((await browser('GET', '/api/feeds')).json()).toHaveLength(1);
    expect(
      (
        await browser('POST', '/api/admin/users', {
          username: 'second',
          password: userPassword,
        })
      ).statusCode,
    ).toBe(201);
  } finally {
    await legacyApp.close();
    legacy.close();
  }
});
