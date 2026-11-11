import { afterAll, expect, test, vi } from 'vitest';
import { totp } from './fixtures/totp.js';
import { openDatabase } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { encryptPassword, decryptPassword } from '../src/server/crypto.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const db = openDatabase(':memory:');
const app = await buildApp(db, config);
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  db.close();
});
const password = 'A-long-test-password-4821!';
const username = 'test-admin';
const cookies = new Map<string, string>();
async function request(path: string, body?: object) {
  const response = await app.inject({
    method: body ? 'POST' : 'GET',
    url: path,
    headers: {
      origin: config.publicUrl,
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    },
    payload: body,
  });
  for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
  return response;
}

test('AES-GCM randomizes ciphertext and rejects tampering/wrong keys', () => {
  const value = encryptPassword(password, config.encryptionKey);
  expect(value).not.toContain(password);
  expect(encryptPassword(password, config.encryptionKey)).not.toBe(value);
  expect(decryptPassword(value, config.encryptionKey)).toBe(password);
  // Always change the last byte; a fixed replacement matches it 1 in 256 runs.
  const lastByte = value.endsWith('ff') ? '00' : 'ff';
  expect(() =>
    decryptPassword(value.slice(0, -2) + lastByte, config.encryptionKey),
  ).toThrow();
  expect(() => decryptPassword(value, 'ab'.repeat(32))).toThrow();
});

test('single admin, origin protection, sessions, TOTP and recovery codes', async () => {
  expect((await request('/api/me')).statusCode).toBe(401);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { username, password },
  });
  expect(rejected.statusCode).toBe(403);
  const setup = await Promise.all([
    request('/api/setup', { username, password }),
    request('/api/setup', { username, password }),
  ]);
  expect(setup.map((result) => result.statusCode).sort()).toEqual([201, 409]);
  expect(db.prepare('SELECT count(*) AS count FROM user').get()).toEqual({
    count: 1,
  });
  expect(
    (
      await request('/api/auth/sign-up/email', {
        username,
        password,
        name: 'No',
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await request('/api/auth/sign-in/username', { username, password }))
      .statusCode,
  ).toBe(200);
  expect((await request('/api/me')).statusCode).toBe(200);
  const enabled = await request('/api/auth/two-factor/enable', { password });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const { totpURI, backupCodes } = enabled.json();
  const verified = await request('/api/auth/two-factor/verify-totp', {
    code: totp(totpURI),
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect((await request('/api/me')).json().twoFactorEnabled).toBe(true);
  await request('/api/auth/sign-out', {});
  expect((await request('/api/me')).statusCode).toBe(401);
  const login = await request('/api/auth/sign-in/username', {
    username,
    password,
  });
  expect(login.json().twoFactorRedirect).toBe(true);
  expect((await request('/api/me')).statusCode).toBe(401);
  expect(
    (
      await request('/api/auth/two-factor/verify-backup-code', {
        code: backupCodes[0],
      })
    ).statusCode,
  ).toBe(200);
  expect((await request('/api/me')).statusCode).toBe(200);
  await request('/api/auth/sign-out', {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61000);
  const nextLogin = await request('/api/auth/sign-in/username', {
    username,
    password,
  });
  expect(nextLogin.json().twoFactorRedirect).toBe(true);
  expect(
    (
      await request('/api/auth/two-factor/verify-backup-code', {
        code: backupCodes[0],
      })
    ).statusCode,
  ).not.toBe(200);
  expect((await request('/api/me')).statusCode).toBe(401);
  expect(
    (await request('/api/auth/two-factor/verify-totp', { code: totp(totpURI) }))
      .statusCode,
  ).toBe(200);
  expect((await request('/api/me')).statusCode).toBe(200);
  expect(
    (
      await request('/api/auth/two-factor/disable', {
        password: 'wrong-password',
      })
    ).statusCode,
  ).not.toBe(200);
  expect(
    (await request('/api/auth/two-factor/disable', { password })).statusCode,
  ).toBe(200);
  expect(
    (
      await request('/api/auth/change-password', {
        currentPassword: password,
        newPassword: password + 'new',
        revokeOtherSessions: true,
      })
    ).statusCode,
  ).toBe(200);
  await request('/api/auth/sign-out', {});
  expect(
    (await request('/api/auth/sign-in/username', { username, password }))
      .statusCode,
  ).not.toBe(200);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61000);
  expect(
    (
      await request('/api/auth/sign-in/username', {
        username,
        password: password + 'new',
      })
    ).statusCode,
  ).toBe(200);
});
