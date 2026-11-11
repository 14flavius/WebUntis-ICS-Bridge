import { afterEach, expect, test, vi } from 'vitest';
import { DateTime } from 'luxon';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { saveAccount, removeAccount } from '../src/server/accounts.js';
import { saveFeed, getFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import { SyncService } from '../src/server/sync.js';
import * as snapshotModule from '../src/server/webuntis/snapshot.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { testConfig } from './helpers.js';
import { lessonFixture } from './fixtures/events.js';
import type { Snapshot } from '../src/shared/events.js';
afterEach(() => vi.restoreAllMocks());

async function syncFixture() {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const ids: string[] = [];
  for (const name of ['First', 'Second', 'Unsubscribed']) {
    ids.push(
      await saveAccount(
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
      ),
    );
  }
  return { db, ids, service: new SyncService(db, config) };
}

test('sync windows use only enabled feeds selecting that account, retaining defaults without subscriptions', async () => {
  const { db, ids, service } = await syncFixture();
  const base = {
    name: 'Feed',
    enabled: true,
    pastDays: 2,
    futureDays: 7,
    language: 'de' as const,
    cancellation: 'mark' as const,
    templates: defaultTemplates('de'),
  };
  saveFeed(db, {
    ...base,
    sources: [{ accountId: ids[0], kinds: ['lesson'] }],
  });
  saveFeed(db, {
    ...base,
    pastDays: 4,
    futureDays: 10,
    sources: [{ accountId: ids[0], kinds: ['exam'] }],
  });
  saveFeed(db, {
    ...base,
    pastDays: 365,
    futureDays: 365,
    sources: [{ accountId: ids[1], kinds: ['lesson'] }],
  });
  saveFeed(db, {
    ...base,
    enabled: false,
    pastDays: 300,
    futureDays: 300,
    sources: [{ accountId: ids[0], kinds: ['lesson'] }],
  });
  const fetch = vi
    .spyOn(snapshotModule, 'fetchSnapshots')
    .mockResolvedValue({ snapshots: [], warnings: [] });
  const today = DateTime.now().setZone('Europe/Berlin').startOf('day');
  try {
    await service.syncAccount(ids[0]);
    await service.syncAccount(ids[2]);
    expect(fetch.mock.calls.map((call) => call.slice(2))).toEqual([
      [
        today.minus({ days: 4 }).toISODate(),
        today.plus({ days: 10 }).toISODate(),
      ],
      [
        today.minus({ days: 14 }).toISODate(),
        today.plus({ days: 90 }).toISODate(),
      ],
    ]);
  } finally {
    await service.stop();
    db.close();
  }
});

test('a second full sync joins the entire active run instead of refetching finished accounts', async () => {
  const { db, service } = await syncFixture();
  let enteredSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  vi.spyOn(snapshotModule, 'fetchSnapshots').mockImplementation(async () => {
    calls++;
    if (calls === 2) {
      enteredSecond();
      await barrier;
    }
    return { snapshots: [], warnings: [] };
  });
  try {
    const first = service.syncAll();
    await secondStarted;
    const overlapping = service.syncAll();
    expect(overlapping).toBe(first);
    expect(calls).toBe(2);
    release();
    await Promise.all([first, overlapping]);
    expect(calls).toBe(3);
    await service.syncAll();
    expect(calls).toBe(6);
  } finally {
    release();
    await service.stop();
    db.close();
  }
});

test('account sync coalesces requests, retains data on failure and rejects stale credential revisions', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const input = {
    name: 'Student',
    school: 'school',
    server: 'https://school.webuntis.com',
    username: 'student',
    password: 'password',
    timezone: 'Europe/Berlin',
  };
  const id = await saveAccount(db, input, config.encryptionKey);
  const event = lessonFixture();
  const snapshot: Snapshot = {
    category: 'lesson',
    start: event.date,
    end: event.date,
    events: [event],
    confirmedEmptyDates: [],
  };
  commitSnapshots(db, id, [snapshot]);
  const original = storedEvents(db);
  const service = new SyncService(db, config);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi
    .spyOn(snapshotModule, 'fetchSnapshots')
    .mockImplementation(async () => {
      await barrier;
      return { snapshots: [snapshot], warnings: [] };
    });
  const first = service.syncAccount(id);
  const second = service.syncAccount(id);
  expect(second).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(storedEvents(db)).toEqual(original);
  await saveAccount(
    db,
    { ...input, name: 'Changed' },
    config.encryptionKey,
    id,
  );
  release();
  await first;
  expect(storedEvents(db)).toEqual(original);
  expect(
    db.prepare('SELECT error FROM webuntis_accounts WHERE id = ?').get(id),
  ).toEqual({ error: 'ACCOUNT_CHANGED_DURING_SYNC' });
  fetch.mockRejectedValueOnce(
    new Error('upstream failure with sensitive details'),
  );
  await service.syncAccount(id);
  expect(storedEvents(db)).toEqual(original);
  expect(
    db.prepare('SELECT error FROM webuntis_accounts WHERE id = ?').get(id),
  ).toEqual({ error: 'SYNC_INVALID_RESPONSE' });
  await service.stop();
  db.close();
});

test('removing the final account disables its feed without broken references', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const id = await saveAccount(
    db,
    {
      name: 'Student',
      school: 'school',
      server: 'https://school.webuntis.com',
      username: 'student',
      password: 'password',
      timezone: 'Europe/Berlin',
    },
    testConfig().encryptionKey,
  );
  const feed = saveFeed(db, {
    name: 'Feed',
    enabled: true,
    pastDays: 0,
    futureDays: 30,
    language: 'de',
    cancellation: 'mark',
    sources: [{ accountId: id, kinds: ['lesson'] }],
    templates: defaultTemplates('de'),
  });
  removeAccount(db, id);
  expect(getFeed(db, feed.id).sources).toEqual([]);
  expect(getFeed(db, feed.id).enabled).toBe(false);
  db.close();
});
