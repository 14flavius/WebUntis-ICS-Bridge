import { tokenFixture } from './fixtures/token.js';
import { expect, test, vi } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';
import { SyncService } from '../src/server/sync.js';
import * as http from '../src/server/webuntis/http.js';
import { testConfig } from './helpers.js';

test('draft testing is authenticated, validates destinations and never saves or synchronizes accounts', async () => {
  const db = openDatabase(':memory:');
  const config = testConfig();
  const app = await buildApp(db, config);
  let rejectLogin = true;
  const close = vi.fn(async () => {});
  const transport = vi.spyOn(http, 'secureTransport').mockReturnValue({
    close,
    fetch: async (url, options) => {
      expect(new URL(url).origin).toBe('https://fixture-school.webuntis.com');
      const path = new URL(url).pathname;
      if (path.endsWith('jsonrpc.do')) {
        const body = JSON.parse(String(options?.body)) as {
          method: string;
          params: { user?: string; password?: string };
        };
        if (body.method === 'authenticate') {
          expect(body.params).toMatchObject({
            user: 'fixture-student',
            password: 'fixture-password',
          });
          if (rejectLogin)
            return Response.json({
              error: { code: -8504, message: 'bad credentials' },
            });
          return Response.json({
            result: {
              personId: 1,
              personType: 5,
              sessionId: 'fixture-session',
            },
          });
        }
        return Response.json({ result: [] });
      }
      if (path.endsWith('token/new')) return new Response(tokenFixture());
      expect(path).not.toContain('app/data');
      if (path.endsWith('entries')) return Response.json({ days: [] });
      if (path.endsWith('exams')) return Response.json({ data: { exams: [] } });
      return Response.json([]);
    },
  });
  const sync = vi.spyOn(SyncService.prototype, 'startAccount');
  const payload = {
    name: 'Draft school',
    school: 'fixture-school',
    server: 'https://fixture-school.webuntis.com',
    username: 'fixture-student',
    password: 'fixture-password',
    timezone: 'Europe/Berlin',
  };
  const headers = { origin: config.publicUrl, cookie: '' };
  const request = (body: object, requestHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/accounts/test',
      headers: requestHeaders,
      payload: body,
    });
  try {
    expect((await request(payload)).statusCode).toBe(401);
    const admin = {
      username: 'draft-test-admin',
      password: 'Draft-test-password-2941!',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers,
          payload: admin,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers,
      payload: admin,
    });
    headers.cookie = login.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    expect(
      (await request(payload, { ...headers, origin: 'https://other.example' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await request({ ...payload, password: undefined })).statusCode,
    ).toBe(400);
    expect(
      (await request({ ...payload, server: 'https://127.0.0.1' })).statusCode,
    ).toBe(400);
    expect(transport).not.toHaveBeenCalled();

    const failure = await request(payload);
    expect(failure.statusCode).toBe(200);
    expect(failure.json()).toEqual([
      { name: 'server', status: 'success' },
      {
        name: 'login',
        status: 'authentication',
        reason: 'invalid_credentials',
      },
    ]);
    expect(failure.body).not.toContain(payload.password);
    rejectLogin = false;
    const success = await request(payload);
    expect(success.statusCode).toBe(200);
    expect(success.json()).toContainEqual({ name: 'login', status: 'success' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(sync).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT count(*) AS count FROM webuntis_accounts').get(),
    ).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM events').get()).toEqual({
      count: 0,
    });
  } finally {
    vi.restoreAllMocks();
    await app.close();
    db.close();
  }
});
