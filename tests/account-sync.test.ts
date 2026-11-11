import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';
import { accountRoutes } from '../src/server/routes/accounts.js';
import { accounts, saveAccount } from '../src/server/accounts.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { SyncService } from '../src/server/sync.js';
import { WebUntisError } from '../src/server/webuntis/client.js';
import * as snapshotModule from '../src/server/webuntis/snapshot.js';
import { storedEvents } from '../src/server/events.js';
import { lessonFixture } from './fixtures/events.js';
import { testConfig, actAsTestUser } from './helpers.js';

test('creation starts one background sync, returns promptly and preserves accounts on login failure', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const sync = new SyncService(db, config);
  const app = Fastify();
  actAsTestUser(app, db);
  accountRoutes(app, db, config, sync);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const event = lessonFixture();
  const fetch = vi
    .spyOn(snapshotModule, 'fetchSnapshots')
    .mockImplementation(async () => {
      await barrier;
      return {
        snapshots: [
          {
            category: 'lesson',
            start: event.date,
            end: event.date,
            events: [event],
            confirmedEmptyDates: [],
          },
        ],
        warnings: [],
      };
    });
  const payload = {
    name: 'Student',
    school: 'fixture-school',
    server: 'https://fixture-school.webuntis.com',
    username: 'fixture',
    password: 'fixture-password',
    timezone: 'Europe/Berlin',
  };
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload,
    });
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    expect(sync.active()).toEqual([id]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const completion = sync.syncAccount(id);
    release();
    await completion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storedEvents(db)).toHaveLength(1);
    expect(accounts(db)[0].lastSuccess).not.toBeNull();

    fetch.mockRejectedValue(
      new WebUntisError('authentication', 'invalid_credentials'),
    );
    const failed = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { ...payload, name: 'Wrong password' },
    });
    expect(failed.statusCode).toBe(201);
    await sync.stop();
    expect(accounts(db)).toHaveLength(2);
    expect(
      accounts(db).find(
        (account) => account.id === failed.json<{ id: string }>().id,
      )?.error,
    ).toBe('WEBUNTIS_INVALID_CREDENTIALS');
    expect(storedEvents(db)).toHaveLength(1);
  } finally {
    release();
    await sync.stop();
    fetch.mockRestore();
    await app.close();
    db.close();
  }
});

test('source edits persist per account and queue one fresh sync after an active request', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const sync = new SyncService(db, config);
  const app = Fastify();
  actAsTestUser(app, db);
  accountRoutes(app, db, config, sync);
  const payload = {
    name: 'Student',
    school: 'fixture',
    server: 'https://fixture.webuntis.com',
    username: 'student',
    password: 'fixture-password',
    timezone: 'Europe/Berlin',
  };
  const id = await saveAccount(db, payload, config.encryptionKey);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi
    .spyOn(snapshotModule, 'fetchSnapshots')
    .mockImplementationOnce(async () => {
      await barrier;
      return { snapshots: [], warnings: [] };
    })
    .mockResolvedValue({ snapshots: [], warnings: [] });
  try {
    expect(accounts(db)[0].examSource).toBe('exams');
    const active = sync.syncAccount(id);
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/accounts/${id}`,
      payload: { ...payload, examSource: 'timetable' },
    });
    expect(edited.statusCode).toBe(200);
    expect(accounts(db)[0].examSource).toBe('timetable');
    expect(fetch).toHaveBeenCalledTimes(1);
    // Older API clients omitting the optional field must preserve the choice.
    await app.inject({
      method: 'PUT',
      url: `/api/accounts/${id}`,
      payload: { ...payload, name: 'Renamed' },
    });
    expect(accounts(db)[0].examSource).toBe('timetable');
    release();
    await active;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => call[1].examSource)).toEqual([
      'exams',
      'timetable',
    ]);
    expect(accounts(db)[0].error).toBeNull();
    expect(accounts(db)[0].lastSuccess).not.toBeNull();
    await app.inject({
      method: 'PUT',
      url: `/api/accounts/${id}`,
      payload: { ...payload, examSource: 'exams' },
    });
    await vi.waitFor(() => expect(sync.active()).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(3);
    const listed = await app.inject('/api/accounts');
    expect(listed.json()).toMatchObject([{ examSource: 'exams' }]);
    expect(listed.body).not.toContain('fixture-password');
  } finally {
    release();
    await sync.stop();
    fetch.mockRestore();
    await app.close();
    db.close();
  }
});
