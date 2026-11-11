import { expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { testConfig } from './helpers.js';

const backupScript = resolve('scripts/backup.mjs');
const setupScript = resolve('scripts/setup.mjs');
mkdirSync('.cache/operation-tests', { recursive: true });

test('setup preserves existing secrets and configuration byte-for-byte', () => {
  const root = mkdtempSync(resolve('.cache/operation-tests/setup-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(setupScript, join(root, 'scripts/setup.mjs'));
  execFileSync(process.execPath, ['scripts/setup.mjs'], { cwd: root });
  const initial = readFileSync(join(root, '.env'));
  expect(initial.toString()).toContain('BETTER_AUTH_SECRET=');
  execFileSync(process.execPath, ['scripts/setup.mjs'], { cwd: root });
  expect(readFileSync(join(root, '.env'))).toEqual(initial);
});

test('online backup encrypts database and secrets; restore verifies integrity and never overwrites', () => {
  const root = mkdtempSync(resolve('.cache/operation-tests/backup-'));
  mkdirSync(join(root, 'data'));
  const config = testConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PATH: 'data/bridge.sqlite',
    BETTER_AUTH_SECRET: config.authSecret,
    ENCRYPTION_KEY: config.encryptionKey,
  };
  const db = new Database(join(root, 'data/bridge.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE sample (value TEXT)');
  db.prepare('INSERT INTO sample VALUES (?)').run('private-calendar-record');
  const passphrase = 'a-strong-test-backup-passphrase';
  execFileSync(process.execPath, [backupScript, 'create'], {
    cwd: root,
    env,
    input: passphrase,
  });
  const archive = readdirSync(join(root, 'data/backups')).find((name) =>
    name.endsWith('.wub'),
  )!;
  const bytes = readFileSync(join(root, 'data/backups', archive));
  expect(bytes.toString()).not.toContain('private-calendar-record');
  expect(bytes.toString()).not.toContain(config.authSecret);
  const wrong = spawnSync(
    process.execPath,
    [backupScript, 'restore', 'data/backups/' + archive, 'wrong'],
    { cwd: root, input: 'incorrect-test-passphrase' },
  );
  expect(wrong.status).not.toBe(0);
  execFileSync(
    process.execPath,
    [backupScript, 'restore', 'data/backups/' + archive, 'restored'],
    { cwd: root, input: passphrase },
  );
  const restored = new Database(join(root, 'restored/data/bridge.sqlite'));
  expect(restored.prepare('SELECT value FROM sample').get()).toEqual({
    value: 'private-calendar-record',
  });
  expect(readFileSync(join(root, 'restored/.env'), 'utf8')).toContain(
    config.encryptionKey,
  );
  const again = spawnSync(
    process.execPath,
    [backupScript, 'restore', 'data/backups/' + archive, 'restored'],
    { cwd: root, input: passphrase },
  );
  expect(again.status).not.toBe(0);
  expect(
    readdirSync(join(root, 'data/backups')).filter((name) =>
      name.endsWith('.sqlite'),
    ),
  ).toHaveLength(0);
  restored.close();
  db.close();
});

test('installer downloads its files, writes .env once and never overwrites an installation', () => {
  const root = mkdtempSync(resolve('.cache/operation-tests/installer-'));
  mkdirSync(join(root, 'bin'));
  copyFileSync(resolve('scripts/install.sh'), join(root, 'install.sh'));
  writeFileSync(
    join(root, 'bin/docker'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$CALL_LOG"',
      'case "$*" in',
      '  *"config --environment"*) printf "COMPOSE_PROJECT_NAME=bridge-test\\n" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  // Stands in for GitHub: serves the repository files the installer requests.
  writeFileSync(
    join(root, 'bin/curl'),
    [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out=$2; shift ;;',
      '    https://*) url=$1 ;;',
      '  esac',
      '  shift',
      'done',
      'printf "%s\\n" "$url" >> "$DOWNLOAD_LOG"',
      'cp "$REPOSITORY/${url#https://raw.githubusercontent.com/14flavius/webuntis-ics-bridge/main/}" "$out"',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: join(root, 'bin') + ':' + process.env.PATH,
    CALL_LOG: join(root, 'bin/docker-calls.log'),
    DOWNLOAD_LOG: join(root, 'bin/downloads.log'),
    REPOSITORY: resolve('.'),
  };
  for (const key of [
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_FILE',
    'COMPOSE_ENV_FILES',
    'PUBLIC_URL',
    'HOST_PORT',
    'BIND_ADDRESS',
    'BETTER_AUTH_SECRET',
    'ENCRYPTION_KEY',
    'BRIDGE_IMAGE',
  ])
    delete env[key];
  execFileSync('sh', ['install.sh', '--help'], { cwd: root, env });
  expect(readdirSync(root)).not.toContain('.env');
  // Plain HTTP is only valid for loopback; nothing may be written on rejection.
  expect(() =>
    execFileSync('sh', ['install.sh'], {
      cwd: root,
      env,
      input: 'bridge-test\nhttp://192.168.1.20:3000\n',
      stdio: 'pipe',
    }),
  ).toThrow();
  expect(readdirSync(root).sort()).toEqual(['bin', 'install.sh']);

  execFileSync('sh', ['install.sh'], {
    cwd: root,
    env,
    input: 'bridge-test\nhttps://calendar.example.test\n3001\n2\n',
  });
  const configuration = readFileSync(join(root, '.env'), 'utf8');
  expect(configuration).toContain('COMPOSE_PROJECT_NAME=bridge-test');
  expect(configuration).toContain('PUBLIC_URL=https://calendar.example.test');
  expect(configuration).toContain('HOST_PORT=3001');
  expect(configuration).toContain('BIND_ADDRESS=0.0.0.0');
  const secret = /^BETTER_AUTH_SECRET=([0-9a-f]{64})$/m.exec(configuration);
  const key = /^ENCRYPTION_KEY=([0-9a-f]{64})$/m.exec(configuration);
  expect(secret?.[1]).toBeDefined();
  expect(key?.[1]).toBeDefined();
  expect(secret![1]).not.toBe(key![1]);
  expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(root, 'docker-compose.yml'))).toEqual(
    readFileSync(resolve('docker-compose.yml')),
  );
  expect(readFileSync(join(root, 'scripts/backup.sh'))).toEqual(
    readFileSync(resolve('scripts/backup.sh')),
  );
  expect(readFileSync(join(root, 'bin/downloads.log'), 'utf8')).toBe(
    [
      'https://raw.githubusercontent.com/14flavius/webuntis-ics-bridge/main/docker-compose.yml',
      'https://raw.githubusercontent.com/14flavius/webuntis-ics-bridge/main/scripts/backup.sh',
      'https://raw.githubusercontent.com/14flavius/webuntis-ics-bridge/main/scripts/prepare-data.sh',
      '',
    ].join('\n'),
  );
  const calls = readFileSync(join(root, 'bin/docker-calls.log'), 'utf8');
  expect(calls).toContain('compose up -d --wait');
  // ./data is prepared for the container user before the first start.
  expect(calls).toContain('--user 0:0 --cap-add CHOWN');
  expect(calls.indexOf('--cap-add CHOWN')).toBeLessThan(
    calls.indexOf('compose up -d --wait'),
  );
  expect(readdirSync(join(root, 'data'))).toEqual([]);
  expect(readFileSync(join(root, 'scripts/prepare-data.sh'))).toEqual(
    readFileSync(resolve('scripts/prepare-data.sh')),
  );
  expect(calls).not.toContain('--build');
  expect(calls).not.toContain('prune');
  expect(
    readdirSync(root).filter((name) => name.startsWith('.bridge')),
  ).toEqual([]);

  // A second run must refuse and leave the installation untouched.
  expect(() =>
    execFileSync('sh', ['install.sh'], { cwd: root, env, stdio: 'pipe' }),
  ).toThrow();
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe(configuration);
});
