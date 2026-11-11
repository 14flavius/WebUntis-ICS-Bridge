import Fastify from 'fastify';
import { DateTime } from 'luxon';
import { expect, test, vi } from 'vitest';
import {
  accounts,
  saveAccount,
  testConnection,
} from '../src/server/accounts.js';
import { accountRoutes } from '../src/server/routes/accounts.js';
import {
  WebUntisClient,
  WebUntisError,
} from '../src/server/webuntis/client.js';
import { openDatabase } from '../src/server/db.js';
import { migrateApplication } from '../src/server/schema.js';
import { SyncService } from '../src/server/sync.js';
import { testConfig, actAsTestUser } from './helpers.js';
import {
  examSnapshots,
  separateExam,
  timetableExam,
} from './fixtures/exam-identity.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { examIdentities } from '../src/server/exam-identities.js';
import {
  isCapabilityFailure,
  isSyncNotice,
  syncIssueCodes,
  visibleSyncIssues,
} from '../src/shared/capabilities.js';

const credentials = {
  name: 'Fixture',
  school: 'fixture',
  server: 'https://fixture.webuntis.com',
  username: 'student',
  password: 'fixture-password',
  timezone: 'Europe/Berlin',
};

function mockChecks() {
  const now = DateTime.fromISO('2026-11-03T12:00:00Z');
  if (!now.isValid) throw new Error('Invalid fixture date');
  vi.spyOn(DateTime, 'now').mockReturnValue(now);
  vi.spyOn(WebUntisClient.prototype, 'login').mockResolvedValue();
  vi.spyOn(WebUntisClient.prototype, 'serverReached').mockReturnValue(true);
  vi.spyOn(WebUntisClient.prototype, 'years').mockResolvedValue([
    {
      id: 1,
      name: 'Fixture year',
      dateRange: { start: '2026-01-01', end: '2026-12-31' },
    },
  ]);
  vi.spyOn(WebUntisClient.prototype, 'timetable').mockResolvedValue({
    days: Array.from({ length: 7 }, (_, day) => ({
      date: `2026-11-0${day + 2}`,
      status: 'NO_DATA',
      gridEntries: [],
    })),
  });
  vi.spyOn(WebUntisClient.prototype, 'exams').mockResolvedValue([]);
  vi.spyOn(WebUntisClient.prototype, 'holidays').mockResolvedValue([]);
}

test('saved tests preserve sync results and timestamps, including changes committed while a test runs', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const app = Fastify();
  actAsTestUser(app, db);
  accountRoutes(app, db, config, new SyncService(db, config));
  mockChecks();
  try {
    const id = await saveAccount(db, credentials, config.encryptionKey);
    const stamp = '2026-11-03T10:00:00.000Z';
    db.prepare(
      'UPDATE webuntis_accounts SET error=?, lastAttempt=?, lastSuccess=? WHERE id=?',
    ).run('EXAMS_MISSING_IDS, TIMETABLE_RANGE_RESTRICTED', stamp, stamp, id);
    const original = accounts(db);
    const url = `/api/accounts/${id}/test`;
    const success = await app.inject({ method: 'POST', url });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toContainEqual(
      expect.objectContaining({ name: 'timetable', status: 'empty' }),
    );
    expect(accounts(db)).toEqual(original);

    vi.mocked(WebUntisClient.prototype.login).mockRejectedValueOnce(
      new WebUntisError('authentication', 'invalid_credentials'),
    );
    const failed = await app.inject({ method: 'POST', url });
    expect(failed.json()).toContainEqual({
      name: 'login',
      status: 'authentication',
      reason: 'invalid_credentials',
    });
    expect(accounts(db)).toEqual(original);

    // An overlapping sync may publish a new failure; the test must not clear it.
    vi.mocked(WebUntisClient.prototype.login).mockImplementationOnce(
      async () => {
        db.prepare(
          'UPDATE webuntis_accounts SET error=?, lastAttempt=? WHERE id=?',
        ).run('WEBUNTIS_SERVER', '2026-11-03T11:00:00.000Z', id);
      },
    );
    await app.inject({ method: 'POST', url });
    expect(accounts(db)[0]).toMatchObject({
      error: 'WEBUNTIS_SERVER',
      lastAttempt: '2026-11-03T11:00:00.000Z',
      lastSuccess: stamp,
    });
    await saveAccount(
      db,
      { ...credentials, name: 'Renamed' },
      config.encryptionKey,
      id,
    );
    expect(accounts(db)[0].error).toBe('WEBUNTIS_SERVER');
    expect(success.body).not.toContain(credentials.password);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    db.close();
  }
});

test('test reports missing/denied dates and unmatched exam IDs using sync validation, with explicit sample range', async () => {
  mockChecks();
  const client = new WebUntisClient(credentials);
  try {
    vi.mocked(WebUntisClient.prototype.timetable).mockResolvedValue({
      days: [
        { date: '2026-11-02', status: 'NOT_ALLOWED', gridEntries: [] },
        { date: '2026-11-03', status: 'REGULAR', gridEntries: [] },
      ],
    });
    vi.mocked(WebUntisClient.prototype.exams).mockResolvedValue([
      { id: 0, name: 'Fixture exam', examDate: 20261103 },
    ]);
    const results = await testConnection(client, credentials.timezone);
    expect(results).toContainEqual({
      name: 'timetable',
      status: 'limited',
      range: { start: '2026-11-02', end: '2026-11-08' },
      warnings: ['TIMETABLE_RANGE_RESTRICTED', 'TIMETABLE_DAYS_MISSING'],
    });
    expect(results).toContainEqual({
      name: 'exams',
      status: 'limited',
      range: { start: '2026-11-02', end: '2026-11-08' },
      warnings: ['EXAMS_AMBIGUOUS'],
    });
    expect(results.some(isCapabilityFailure)).toBe(false);
    vi.mocked(WebUntisClient.prototype.timetable).mockResolvedValue({
      days: [{ date: '2026-11-03', status: 'UNEXPECTED', gridEntries: [] }],
    });
    expect(await testConnection(client, credentials.timezone)).toContainEqual(
      expect.objectContaining({
        name: 'timetable',
        status: 'invalid',
        code: 'WEBUNTIS_INCOMPLETE_DAY',
      }),
    );
  } finally {
    await client.close();
    vi.restoreAllMocks();
  }
});

test('school limitations stay informational while authentication and unknown failures remain visible', () => {
  const codes = syncIssueCodes(
    'TIMETABLE_RANGE_RESTRICTED, EXAMS_MISSING_IDS, TIMETABLE_RANGE_RESTRICTED',
  );
  expect(codes).toHaveLength(2);
  expect(visibleSyncIssues('EXAMS_FORBIDDEN, EXAMS_UNAVAILABLE')).toEqual([]);
  expect(visibleSyncIssues('EXAMS_FORBIDDEN, EXAMS_MISSING_IDS')).toEqual([
    'EXAMS_MISSING_IDS',
  ]);
  expect(codes.every(isSyncNotice)).toBe(true);
  expect(isSyncNotice('WEBUNTIS_INVALID_CREDENTIALS')).toBe(false);
  expect(isSyncNotice('UNKNOWN_FAILURE')).toBe(false);
  expect(isSyncNotice('EXAMS_AMBIGUOUS')).toBe(true);
});

test('saved connection tests use persistent exam history without allocating IDs or clearing ambiguity', async () => {
  const db = openDatabase(':memory:');
  migrateApplication(db);
  const config = testConfig();
  const app = Fastify();
  actAsTestUser(app, db);
  accountRoutes(app, db, config, new SyncService(db, config));
  mockChecks();
  try {
    const id = await saveAccount(db, credentials, config.encryptionKey);
    const original = {
      id: 0,
      name: 'Algebra test',
      subject: 'Math',
      examType: 'Written',
      examDate: 20261103,
      startTime: 800,
      endTime: 930,
    };
    const second = { ...original, examDate: 20261105 };
    commitSnapshots(
      db,
      id,
      examSnapshots([separateExam(original), separateExam(second)], {
        schoolYearId: '1',
      }),
    );
    const history = examIdentities(db, id);
    const events = storedEvents(db);
    const statuses = accounts(db);
    vi.mocked(WebUntisClient.prototype.exams).mockResolvedValue([
      { ...original, examDate: 20261104 },
    ]);
    const ambiguous = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/test`,
    });
    expect(ambiguous.json()).toContainEqual(
      expect.objectContaining({
        name: 'exams',
        status: 'limited',
        warnings: ['EXAMS_AMBIGUOUS'],
      }),
    );
    vi.mocked(WebUntisClient.prototype.exams).mockResolvedValue([
      original,
      second,
    ]);
    const exact = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/test`,
    });
    expect(exact.json()).toContainEqual(
      expect.objectContaining({ name: 'exams', status: 'success' }),
    );
    expect(examIdentities(db, id)).toEqual(history);
    expect(storedEvents(db)).toEqual(events);
    expect(accounts(db)).toEqual(statuses);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    db.close();
  }
});

test('connection checks accept unique cached timetable matches on restricted dates', async () => {
  mockChecks();
  const client = new WebUntisClient(credentials);
  try {
    const event = {
      ...timetableExam(),
      date: '2026-11-03',
      start: '2026-11-03T07:00:00.000Z',
      end: '2026-11-03T08:30:00.000Z',
    };
    vi.mocked(WebUntisClient.prototype.timetable).mockResolvedValue({
      days: [{ date: event.date, status: 'NOT_ALLOWED', gridEntries: [] }],
    });
    vi.mocked(WebUntisClient.prototype.exams).mockResolvedValue([
      {
        id: 0,
        name: 'Algebra test',
        subject: 'Math',
        examDate: 20261103,
        startTime: 800,
        endTime: 930,
      },
    ]);
    const results = await testConnection(client, credentials.timezone, {
      timetable: [event],
    });
    expect(results).toContainEqual(
      expect.objectContaining({ name: 'exams', status: 'success' }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({ name: 'timetable', status: 'limited' }),
    );
  } finally {
    await client.close();
    vi.restoreAllMocks();
  }
});
