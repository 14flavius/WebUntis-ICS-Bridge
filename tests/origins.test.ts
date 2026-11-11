import { expect, test } from 'vitest';
import { trustedOrigins } from '../src/server/config.js';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';
import { testConfig } from './helpers.js';

test('loopback aliases are restricted to development with identical port and protocol', () => {
  const config = testConfig();
  expect(trustedOrigins(config)).toEqual([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
  expect(
    trustedOrigins({ ...config, publicUrl: 'http://localhost:5173' }),
  ).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  expect(trustedOrigins({ ...config, production: true })).toEqual([
    config.publicUrl,
  ]);
  expect(
    trustedOrigins({ ...config, publicUrl: 'https://bridge.example.org' }),
  ).toEqual(['https://bridge.example.org']);
});

test('localhost setup, login and session work; other origins remain blocked', async () => {
  const db = openDatabase(':memory:');
  const app = await buildApp(db, testConfig());
  const payload = {
    username: 'origin-test',
    password: 'Local-test-password-4821!',
  };
  try {
    for (const origin of [
      undefined,
      'null',
      'https://localhost:5173',
      'http://localhost:5174',
      'https://evil.example',
      'http://localhost.evil.example:5173',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: origin ? { origin } : {},
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('INVALID_ORIGIN');
    }
    const headers = { origin: 'http://localhost:5173' };
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers,
      payload,
    });
    expect(setup.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers,
      payload,
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join('; ');
    const session = await app.inject({
      url: '/api/me',
      headers: { ...headers, cookie },
    });
    expect(session.statusCode).toBe(200);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { ...headers, cookie },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
  } finally {
    await app.close();
    db.close();
  }
});
