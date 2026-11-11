import { expect, test } from 'vitest';
import { openDatabase, migrate } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { testConfig } from './helpers.js';

test('health checks SQLite and migrations preserve existing data', async () => {
  const db = openDatabase(':memory:');
  migrate(db, 1, 'CREATE TABLE sample (value TEXT)');
  db.prepare('INSERT INTO sample VALUES (?)').run('preserved');
  migrate(db, 1, 'CREATE TABLE sample (value TEXT)');
  expect(db.prepare('SELECT value FROM sample').get()).toEqual({
    value: 'preserved',
  });
  const app = await buildApp(db, testConfig());
  const result = await app.inject('/api/health');
  expect(result.statusCode).toBe(200);
  expect(result.json().status).toBe('ok');
  await app.close();
  db.close();
});

test('the displayed version matches package.json and the lockfile', async () => {
  const { APP_VERSION } = await import('../src/shared/version.js');
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
  };
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    version: string;
  };
  expect(manifest.version).toBe(APP_VERSION);
  expect(lock.version).toBe(APP_VERSION);
});
