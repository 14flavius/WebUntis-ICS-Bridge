import { tokenFixture } from './fixtures/token.js';
import { expect, test } from 'vitest';
import { WebUntisClient } from '../src/server/webuntis/client.js';
import { isPublicAddress, serverOrigin } from '../src/server/webuntis/http.js';
import {
  accounts,
  saveAccount,
  accountCredentials,
  testConnection,
} from '../src/server/accounts.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { testConfig } from './helpers.js';

const credentials = {
  name: 'Student',
  school: 'test-school',
  server: 'https://test-school.webuntis.com',
  username: 'student',
  password: 'test-password',
  timezone: 'Europe/Berlin',
};

test.each([
  [-8504, 'authentication', 'invalid_credentials'],
  [-8500, 'invalid', 'invalid_school'],
  [-8509, 'forbidden', undefined],
  [-8520, 'authentication', undefined],
  [-32601, 'unavailable', undefined],
  [-9999, 'server', undefined],
] as const)(
  'connection test classifies RPC error %s without exposing upstream text',
  async (code, status, reason) => {
    let requests = 0;
    const client = new WebUntisClient(credentials, {
      close: async () => {},
      fetch: async () => {
        requests++;
        return Response.json({
          error: { code, message: 'Sensitive upstream detail' },
        });
      },
    });
    const results = await testConnection(client, credentials.timezone);
    expect(results).toEqual([
      { name: 'server', status: 'success' },
      { name: 'login', status, reason },
    ]);
    expect(requests).toBe(1);
    expect(JSON.stringify(results)).not.toContain('Sensitive');
  },
);

test('unreachable servers do not produce an authentication diagnosis', async () => {
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async () => {
      throw new Error('DNS failure');
    },
  });
  expect(await testConnection(client, credentials.timezone)).toEqual([
    { name: 'server', status: 'server' },
  ]);
});

test('reachable HTTP failures are distinct from incorrect credentials', async () => {
  for (const [httpStatus, status] of [
    [401, 'authentication'],
    [403, 'forbidden'],
    [503, 'server'],
  ] as const) {
    const client = new WebUntisClient(credentials, {
      close: async () => {},
      fetch: async () => new Response(null, { status: httpStatus }),
    });
    expect(await testConnection(client, credentials.timezone)).toEqual([
      { name: 'server', status: 'success' },
      { name: 'login', status, reason: undefined },
    ]);
  }
});

test('connection checks distinguish successful, empty and forbidden capabilities', async () => {
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('jsonrpc.do')) {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'authenticate')
          return Response.json({
            result: {
              sessionId: 'fixture-session',
              personId: 42,
              personType: 5,
            },
          });
        return Response.json({ result: [] });
      }
      if (path.endsWith('token/new')) return new Response(tokenFixture());
      expect(path).not.toContain('app/data');
      if (path.endsWith('entries')) {
        expect(
          new Headers(init?.headers).get('X-Webuntis-Api-School-Year-Id'),
        ).toBe('7');
        expect(new Headers(init?.headers).get('Tenant-Id')).toBe('123');
        return Response.json({ days: [] });
      }
      if (path.endsWith('exams')) return new Response(null, { status: 403 });
      expect(path).toBe('/WebUntis/api/rest/view/v1/schoolyears');
      return Response.json([
        {
          id: 7,
          name: 'Fixture year',
          dateRange: { start: '2020-01-01', end: '2099-12-31' },
        },
      ]);
    },
  });
  expect(await testConnection(client, credentials.timezone)).toMatchObject([
    { name: 'server', status: 'success' },
    { name: 'login', status: 'success' },
    { name: 'schoolyears', status: 'success' },
    {
      name: 'timetable',
      status: 'limited',
      warnings: ['TIMETABLE_DAYS_MISSING'],
    },
    { name: 'exams', status: 'forbidden', reason: undefined },
    { name: 'holidays', status: 'empty' },
  ]);
});

test('server validation rejects SSRF and insecure origins', () => {
  for (const input of [
    'http://school.webuntis.com',
    'https://127.0.0.1',
    'https://school.webuntis.com.evil.test',
    'https://user:secret@school.webuntis.com',
    'https://school.webuntis.com:444',
    'https://school.webuntis.com/redirect',
  ])
    expect(() => serverOrigin(input)).toThrow();
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    '2001:db8::1',
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress('8.8.8.8')).toBe(true);
});

test('client refreshes expired authentication once, retains cookies and validates data', async () => {
  let logins = 0;
  let tokens = 0;
  let timetables = 0;
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('jsonrpc.do')) {
        logins++;
        return Response.json({
          result: { sessionId: 'test-session', personId: 42, personType: 5 },
        });
      }
      expect(new Headers(init?.headers).get('cookie')).toContain(
        'JSESSIONID=test-session',
      );
      if (path.endsWith('token/new')) {
        tokens++;
        return new Response(tokenFixture(String(tokens)));
      }
      expect(path).not.toContain('app/data');
      timetables++;
      if (timetables === 1) return new Response(null, { status: 401 });
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${tokenFixture('2')}`,
      );
      expect(new Headers(init?.headers).get('tenant-id')).toBe('2');
      expect(
        new Headers(init?.headers).get('X-Webuntis-Api-School-Year-Id'),
      ).toBe('5');
      return Response.json({
        days: [{ date: '2026-10-20', status: 'NO_DATA', gridEntries: [] }],
      });
    },
  });
  await client.login();
  expect(
    (await client.timetable('2026-10-20', '2026-10-20', '5')).days,
  ).toHaveLength(1);
  expect(logins).toBe(2);
  expect(tokens).toBe(2);
  await client.close();
});

test('malformed and forbidden responses never become empty data', async () => {
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (url) =>
      new URL(url).pathname.endsWith('token/new')
        ? new Response(tokenFixture())
        : Response.json({ unexpected: [] }),
  });
  await expect(client.timetable('2026-10-20', '2026-10-21')).rejects.toThrow();
  const denied = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async () => new Response(null, { status: 403 }),
  });
  await expect(denied.rest('/WebUntis/api/exams')).rejects.toMatchObject({
    status: 'forbidden',
  });
});

test('account reads never expose secrets and password replacement is explicit', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const key = testConfig().encryptionKey;
  const id = await saveAccount(db, credentials, key);
  expect(JSON.stringify(accounts(db))).not.toContain('password');
  const stored = db.prepare('SELECT password FROM webuntis_accounts').get() as {
    password: string;
  };
  expect(stored.password).not.toContain(credentials.password);
  await saveAccount(
    db,
    { ...credentials, password: undefined, name: 'Renamed' },
    key,
    id,
  );
  expect(accountCredentials(db, id, key).password).toBe(credentials.password);
  db.close();
});

test('RPC session expiry renews once and repeated expiry fails without a retry loop', async () => {
  let logins = 0;
  let requests = 0;
  let permanentExpiry = false;
  const client = new WebUntisClient(credentials, {
    close: async () => {},
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'authenticate') {
        logins++;
        return Response.json({
          result: {
            sessionId: `session-${logins}`,
            personId: 42,
            personType: 5,
          },
        });
      }
      requests++;
      if (requests === 1 || permanentExpiry)
        return Response.json({
          error: { code: -8520, message: 'Session expired' },
        });
      expect(new Headers(init?.headers).get('cookie')).toContain(
        'JSESSIONID=session-2',
      );
      return Response.json({ result: [] });
    },
  });
  await client.login();
  expect(await client.holidays()).toEqual([]);
  expect(logins).toBe(2);
  permanentExpiry = true;
  await expect(client.holidays()).rejects.toMatchObject({
    status: 'authentication',
  });
  expect(logins).toBe(3);
  expect(requests).toBe(4);
  await client.close();
});

test('invalid token routing claims fail without a broad account-information request', async () => {
  for (const token of [
    'opaque-token',
    'header.invalid.signature',
    'e30.e30.c2ln',
    tokenFixture(null),
    tokenFixture('123\r\nX-Injected: true'),
    tokenFixture({ id: 123 }),
  ]) {
    const paths: string[] = [];
    const client = new WebUntisClient(credentials, {
      close: async () => {},
      fetch: async (url) => {
        paths.push(new URL(url).pathname);
        return new Response(token);
      },
    });
    await expect(client.years()).rejects.toMatchObject({ status: 'invalid' });
    expect(paths).toEqual(['/WebUntis/api/token/new']);
    await client.close();
  }
});
