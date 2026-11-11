import {
  verifyPageNavigation,
  verifySyncNotes,
  seedPreviewHolidays,
  verifyHolidayPreview,
} from './browser-followups.js';
import { totp } from './fixtures/totp.js';
import {
  chromium,
  expect,
  type Request as BrowserRequest,
} from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';
import { testConfig } from './helpers.js';
import { lessonFixture } from './fixtures/events.js';
import { commitSnapshots } from '../src/server/events.js';
import type { Account } from '../src/shared/types.js';
import {
  WebUntisClient,
  WebUntisError,
} from '../src/server/webuntis/client.js';

await mkdir('.cache/tmp', { recursive: true });
process.env.TMPDIR = resolve('.cache/tmp');
await mkdir('.cache/browser', { recursive: true });
const directory = await mkdtemp(resolve('.cache/browser/run-'));
const db = openDatabase(':memory:');
const app = await buildApp(db, {
  ...testConfig(),
  publicUrl: 'http://127.0.0.1:4173',
  production: true,
});
await app.listen({ host: '127.0.0.1', port: 4173 });
const browser = await chromium.launchPersistentContext(directory, {
  executablePath:
    process.env.CHROME_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  locale: 'de-DE',
  viewport: { width: 1440, height: 1000 },
  downloadsPath: resolve('.cache/browser'),
  artifactsDir: resolve('.cache/browser'),
});
const page = await browser.newPage();
const suiteStartedAt = Date.now();
page.setDefaultTimeout(8000);
const errors: string[] = [];
const originalUptime = process.uptime;
const originalWebUntisLogin = WebUntisClient.prototype.login;
// Automatic first sync must never send fixture credentials to a real school.
WebUntisClient.prototype.login = async () => {
  throw new WebUntisError('authentication', 'invalid_credentials');
};
page.on('pageerror', (error) => errors.push(error.message));
try {
  for (const locale of ['en-US', 'fr-FR', 'de-AT', 'de-CH']) {
    const localeContext = await browser.browser()!.newContext({ locale });
    try {
      const localized = await localeContext.newPage();
      await localized.goto('http://127.0.0.1:4173');
      const german = locale.startsWith('de');
      await expect(
        localized.getByRole('heading', {
          name: german ? 'Willkommen' : 'Welcome',
        }),
      ).toBeVisible();
      await expect(localized.locator('html')).toHaveAttribute(
        'lang',
        german ? 'de' : 'en',
      );
      if (locale === 'fr-FR' || locale === 'de-AT') {
        await localized
          .getByRole('button', {
            name: german ? 'English' : 'Deutsch',
            exact: true,
          })
          .click();
        await localized.reload();
        await expect(
          localized.getByRole('heading', {
            name: german ? 'Welcome' : 'Willkommen',
          }),
        ).toBeVisible();
        await expect(localized.locator('html')).toHaveAttribute(
          'lang',
          german ? 'en' : 'de',
        );
      }
    } finally {
      await localeContext.close();
    }
  }
  process.uptime = () => 7200;
  await page.goto('http://127.0.0.1:4173');
  await expect(
    page.getByRole('heading', { name: 'Einrichtung gesperrt.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Benutzername')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Einrichtung gesperrt.' }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/setup-expired.png',
    fullPage: true,
  });
  process.uptime = originalUptime;
  await page.getByRole('button', { name: 'Status erneut prüfen' }).click();
  await expect(
    page.getByRole('heading', { name: 'Willkommen', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: '.cache/browser/setup.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Willkommen', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/setup-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Willkommen', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Benutzername').fill('browser-admin');
  const setupPassword = page.getByLabel('Passwort', { exact: true });
  const setupConfirmation = page.getByLabel('Passwort bestätigen', {
    exact: true,
  });
  const createAdministrator = page.getByRole('button', {
    name: 'Administrator erstellen',
    exact: true,
  });
  await expect(createAdministrator).toBeDisabled();
  await setupPassword.fill('a'.repeat(11));
  await setupConfirmation.fill('a'.repeat(11));
  await expect(setupPassword).toHaveAttribute('aria-invalid', 'true');
  await expect(createAdministrator).toBeDisabled();
  await setupPassword.fill('a'.repeat(12));
  await expect(
    page.getByText('Passwörter stimmen nicht überein.', { exact: true }),
  ).toBeVisible();
  await expect(setupConfirmation).toHaveAttribute('aria-invalid', 'true');
  await setupConfirmation.fill('a'.repeat(12));
  await expect(
    page.getByText('Passwörter stimmen überein.', { exact: true }),
  ).toBeVisible();
  await expect(createAdministrator).toBeEnabled();
  await setupPassword.fill('b'.repeat(12));
  await expect(createAdministrator).toBeDisabled();
  await expect(
    page.getByText('Passwörter stimmen nicht überein.', { exact: true }),
  ).toBeVisible();
  await setupPassword.fill('x'.repeat(128));
  await setupPassword.press('End');
  await setupPassword.pressSequentially('z');
  await expect(setupPassword).toHaveValue('x'.repeat(128));
  await expect(
    page.getByText('12–128 Zeichen · 128/128', { exact: true }),
  ).toBeVisible();
  await setupConfirmation.fill('x'.repeat(128));
  await setupConfirmation.press('End');
  await setupConfirmation.pressSequentially('z');
  await expect(setupConfirmation).toHaveValue('x'.repeat(128));
  await expect(createAdministrator).toBeEnabled();
  await setupConfirmation.clear();
  await expect(createAdministrator).toBeDisabled();
  await page
    .locator('input[name="password"]')
    .fill('Browser-test-password-1972!');
  await page
    .getByLabel('Passwort bestätigen')
    .fill('Browser-test-password-1972!');
  await page
    .getByRole('button', { name: 'Administrator erstellen', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Willkommen zurück' }),
  ).toBeVisible();
  await page.getByLabel('Benutzername').fill('browser-admin');
  await page
    .getByLabel('Passwort', { exact: true })
    .fill('Browser-test-password-1972!');
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Verbinde dein erstes Konto' }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/dashboard-empty.png',
    fullPage: true,
  });
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Konten' }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Kalenderfeeds' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Dein erster Kalenderfeed' }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/feeds-empty.png',
    fullPage: true,
  });
  await verifyPageNavigation(page);
  await page.getByRole('button', { name: 'Zur Übersicht' }).click();
  await page.getByRole('button', { name: 'Konto hinzufügen' }).click();
  for (const label of [
    'Kontoname',
    'Schule',
    'WebUntis-Server (optional)',
    'Zeitzone der Schule',
  ]) {
    const field = page.getByLabel(label, { exact: true });
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await expect(field).toHaveAttribute('data-protonpass-ignore', 'true');
  }
  await expect(page.getByLabel('Benutzername')).toHaveAttribute(
    'autocomplete',
    'username',
  );
  await expect(page.getByLabel('WebUntis-Passwort')).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await expect(page.getByLabel('Benutzername')).not.toHaveAttribute(
    'data-protonpass-ignore',
  );
  await expect(page.getByLabel('WebUntis-Passwort')).not.toHaveAttribute(
    'data-protonpass-ignore',
  );
  await expect(
    page.getByRole('dialog').locator('input').first(),
  ).toHaveAttribute('name', 'school-search');
  const schoolQueries: string[] = [];
  await page.route('**/api/schools?*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q');
    schoolQueries.push(query ?? '');
    if (query === 'broad') {
      await route.fulfill({
        status: 422,
        json: { error: 'SCHOOL_SEARCH_TOO_BROAD' },
      });
      return;
    }
    if (query === 'nothing') {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      json: [
        {
          displayName: 'Another School',
          loginName: 'another-school',
          server: 'https://another-school.webuntis.com',
          address: 'Another Town',
        },
        {
          displayName: 'Fixture School',
          loginName: 'fixture-school',
          server: 'https://fixture-school.webuntis.com',
          address: 'Example Town',
        },
      ],
    });
  });
  await page.getByLabel('Schule', { exact: true }).fill('broad');
  await expect(page.getByRole('alert')).toHaveText(
    'Zu viele Schulen gefunden. Gib den Schulnamen genauer ein.',
  );
  await page.getByRole('combobox', { name: 'Schule' }).fill('nothing');
  await expect(
    page.getByText(
      'Keine Schule gefunden. Versuche einen anderen Namen oder Ort.',
    ),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Schule' }).fill('fi');
  await page.getByRole('combobox', { name: 'Schule' }).fill('fixt');
  await page
    .getByLabel('Schule', { exact: false })
    .first()
    .fill('fixture-school');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
  expect(schoolQueries).not.toContain('fi');
  expect(schoolQueries).not.toContain('fixt');
  await page.getByLabel('Kontoname').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/school-suggestions.png',
    fullPage: true,
  });
  await page
    .getByRole('option', { name: 'Fixture School Example Town' })
    .click();
  await expect(page.getByLabel('Schule', { exact: true })).toHaveValue(
    'Fixture School',
  );
  await expect(
    page.getByLabel('WebUntis-Server', { exact: false }),
  ).toHaveValue('https://fixture-school.webuntis.com');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Kontoname')).toHaveValue('Fixture School');
  await page.getByLabel('Kontoname').fill('Demo Student');
  await page.getByLabel('Kontoname').click();
  await expect(page.locator('.school-selection')).toHaveText(
    'Fixture SchoolExample Town',
  );
  await page.screenshot({
    path: '.cache/browser/school-selected.png',
    fullPage: true,
  });
  await page.getByRole('combobox', { name: 'Schule' }).fill('fixture');
  await expect(
    page.getByLabel('WebUntis-Server', { exact: false }),
  ).toHaveValue('');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Schule' }).press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('combobox', { name: 'Schule' }).press('ArrowDown');
  await expect(
    page.getByRole('listbox').getByRole('option', { selected: true }),
  ).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Schule' }).press('ArrowDown');
  await expect(
    page.getByRole('option', { name: 'Fixture School Example Town' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('combobox', { name: 'Schule' }).press('Enter');
  await expect(page.getByRole('combobox', { name: 'Schule' })).toHaveValue(
    'Fixture School',
  );
  await expect(
    page.getByLabel('WebUntis-Server', { exact: false }),
  ).toHaveValue('https://fixture-school.webuntis.com');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.unroute('**/api/schools?*');
  await expect(page.getByLabel('Kontoname')).toHaveValue('Demo Student');
  await page
    .getByLabel('WebUntis-Server', { exact: false })
    .fill('https://fixture-school.webuntis.com');
  await page.getByLabel('Benutzername').fill('fixture-student');
  await page.getByLabel('WebUntis-Passwort').fill('fixture-password');
  let draftTests = 0;
  await page.route('**/api/accounts/test', async (route) => {
    draftTests++;
    const input = route.request().postDataJSON() as {
      school: string;
      username: string;
    };
    expect(input.school).toBe('fixture-school');
    expect(input.username).toBe('fixture-student');
    const results = [
      { name: 'server', status: 'success' },
      {
        name: 'login',
        status: 'authentication',
        reason: 'invalid_credentials',
      },
    ];
    if (draftTests > 1) {
      await route.fulfill({
        json: [
          'server',
          'login',
          'timetable',
          'exams',
          'holidays',
          'schoolyears',
        ].map((name) => ({ name, status: 'success' })),
      });
    } else {
      await route.fulfill({ json: results });
    }
  });
  await page
    .getByRole('button', { name: 'Verbindung testen', exact: true })
    .click();
  const draftDialog = page.getByRole('dialog', {
    name: 'Verbindungstest',
    exact: true,
  });
  await expect(
    draftDialog.getByText('Benutzername oder Passwort falsch.'),
  ).toBeVisible();
  await draftDialog
    .getByRole('button', { name: 'Zugangsdaten bearbeiten' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Konto hinzufügen', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Benutzername')).toHaveValue('fixture-student');
  await page
    .getByRole('button', { name: 'Verbindung testen', exact: true })
    .click();
  await expect(
    draftDialog.getByRole('heading', { name: 'Verbindung erfolgreich' }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/account-draft-test.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(draftDialog).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Konto hinzufügen', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('WebUntis-Passwort')).toHaveValue(
    'fixture-password',
  );
  expect(draftTests).toBe(2);
  expect(
    db.prepare('SELECT count(*) AS count FROM webuntis_accounts').get(),
  ).toEqual({ count: 0 });
  await page.unroute('**/api/accounts/test');
  await page.getByRole('button', { name: 'Konto speichern' }).click();
  await expect(
    page.getByRole('heading', { name: 'Demo Student' }),
  ).toBeVisible();
  const account = db
    .prepare('SELECT id FROM webuntis_accounts LIMIT 1')
    .get() as { id: string };
  await expect(
    page.getByText('Benutzername oder Passwort falsch.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Alle synchronisieren', exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .locator('.account-card')
      .getByRole('button', { name: 'Synchronisieren', exact: true }),
  ).toHaveCount(0);
  const syncResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/sync') &&
      response.request().method() === 'POST',
  );
  const syncRequests: string[] = [];
  const recordSyncRequest = (request: BrowserRequest) => {
    syncRequests.push(new URL(request.url()).pathname);
  };
  let releaseSync!: () => void;
  const syncBarrier = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  await page.route('**/api/sync', async (route) => {
    const response = await route.fetch();
    await syncBarrier;
    await route.fulfill({ response });
  });
  page.on('request', recordSyncRequest);
  const statusPoll = page.waitForResponse((response) =>
    response.url().endsWith('/api/status'),
  );
  try {
    await page
      .getByRole('button', { name: 'Alle synchronisieren', exact: true })
      .click();
    await statusPoll;
    expect(syncRequests).not.toContain('/api/setup');
    expect(syncRequests).not.toContain('/api/me');
  } finally {
    page.off('request', recordSyncRequest);
    releaseSync();
  }
  expect((await syncResponse).status()).toBe(200);
  await page.unroute('**/api/sync');
  await expect(
    page.getByRole('button', { name: 'Alle synchronisieren', exact: true }),
  ).toBeEnabled();
  let finishConnectionTest: (() => Promise<void>) | undefined;
  let connectionResults = [
    { name: 'server', status: 'success' },
    { name: 'login', status: 'authentication', reason: 'invalid_credentials' },
  ];
  await page.route('**/api/accounts/*/test', (route) => {
    finishConnectionTest = () => route.fulfill({ json: connectionResults });
  });
  await page.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect(
    page.getByRole('heading', { name: 'Verbindung wird geprüft …' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Erneut testen' }),
  ).toBeDisabled();
  await expect.poll(() => !!finishConnectionTest).toBe(true);
  await finishConnectionTest!();
  const testDialog = page.getByRole('dialog');
  await expect(
    testDialog
      .locator('.connection-summary')
      .getByText('Benutzername oder Passwort falsch.', { exact: true }),
  ).toBeVisible();
  await expect(
    testDialog.getByText('Erreichbar', { exact: true }),
  ).toBeVisible();
  await expect(
    testDialog.getByText('Nicht geprüft', { exact: true }),
  ).toHaveCount(4);
  await page.screenshot({
    path: '.cache/browser/connection-failed.png',
    fullPage: true,
  });
  connectionResults = [
    { name: 'server', status: 'success' },
    { name: 'login', status: 'success' },
    { name: 'timetable', status: 'success' },
    { name: 'exams', status: 'forbidden' },
    { name: 'holidays', status: 'empty' },
    { name: 'schoolyears', status: 'success' },
  ];
  finishConnectionTest = undefined;
  await page.getByRole('button', { name: 'Erneut testen' }).click();
  await expect.poll(() => !!finishConnectionTest).toBe(true);
  await finishConnectionTest!();
  await expect(
    testDialog.getByRole('heading', {
      name: 'Verbindung steht · mit Hinweisen',
    }),
  ).toBeVisible();
  await expect(
    testDialog.getByText('Kontoinformationen', { exact: true }),
  ).toHaveCount(0);
  await expect(
    testDialog.getByText(
      'Der separate Prüfungsabruf ist optional. Prüfungen im Stundenplan werden weiterhin übernommen.',
    ),
  ).toBeVisible();
  await expect(testDialog.locator('.connection-result.failed')).toHaveCount(0);
  await expect(
    testDialog.getByText('Optional · in Ordnung', { exact: true }),
  ).toBeVisible();
  await expect(
    testDialog.getByText('Keine Daten', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/connection-results.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Schließen', exact: true }).click();
  connectionResults = [
    { name: 'server', status: 'success' },
    { name: 'login', status: 'authentication', reason: 'invalid_credentials' },
  ];
  finishConnectionTest = undefined;
  await page.getByRole('button', { name: 'Verbindung testen' }).click();
  await expect.poll(() => !!finishConnectionTest).toBe(true);
  await finishConnectionTest!();
  await page.getByRole('button', { name: 'Zugangsdaten bearbeiten' }).click();
  await expect(page.getByLabel('Kontoname')).toHaveValue('Demo Student');
  await expect(
    page.getByLabel('Neues Passwort (optional)', { exact: true }),
  ).toHaveValue('');
  await page.getByRole('button', { name: 'Schließen', exact: true }).click();
  await page.unroute('**/api/accounts/*/test');
  const event = lessonFixture();
  const today = new Date().toISOString().slice(0, 10);
  event.date = today;
  event.start = `${today}T08:00:00.000Z`;
  event.end = `${today}T08:45:00.000Z`;
  event.values.account = 'Demo Student';
  commitSnapshots(db, account.id, [
    {
      category: 'lesson',
      start: today,
      end: today,
      events: [event],
      confirmedEmptyDates: [],
    },
  ]);
  await verifySyncNotes(page, db, account.id);
  const holidayDates = seedPreviewHolidays(db, account.id);
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Kalenderfeeds' })
    .click();
  await page.getByRole('button', { name: 'Feed erstellen' }).click();
  await page.getByLabel('Feedname').fill('My calendar');
  await expect(
    page.getByText('Math · Teacher A', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Titel', { exact: false })
    .fill('{{subject}} [[· {{info}}]]');
  await expect(
    page.getByText('Math · Bring calculator', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Standort', { exact: true }).fill('Haus A · Raum ');
  await page.getByLabel('Variablengruppe').selectOption('room');
  await page
    .getByRole('button', { name: '{{roomShort}}', exact: true })
    .click();
  await expect(page.getByLabel('Standort', { exact: true })).toHaveValue(
    'Haus A · Raum {{roomShort}}',
  );
  await expect(
    page.getByText('Standort: Haus A · Raum 101', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/feed-editor.png',
    fullPage: true,
  });
  await verifyHolidayPreview(page, holidayDates);
  // Hundreds of automated page requests would exhaust the production rate
  // limit. Pace the next batch instead of weakening the application's limit.
  const remainingWindow = Math.max(0, 65000 - (Date.now() - suiteStartedAt));
  await new Promise((resolve) => setTimeout(resolve, remainingWindow));
  await page.getByRole('button', { name: 'Feed speichern' }).click();
  await expect(
    page.getByRole('heading', { name: 'My calendar' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Duplizieren' }).click();
  await expect(
    page.getByRole('heading', { name: 'My calendar (copy)' }),
  ).toBeVisible();
  await page.screenshot({ path: '.cache/browser/feeds.png', fullPage: true });
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Einstellungen' })
    .click();
  await expect(
    page.getByLabel('Synchronisierungsintervall', { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/settings.png',
    fullPage: true,
  });
  await page
    .getByLabel('Synchronisierungsintervall', { exact: false })
    .fill('15');
  await page.getByLabel('Sprache', { exact: true }).selectOption('en');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page.getByLabel('Sync interval', { exact: false })).toHaveValue(
    '15',
  );
  await page.screenshot({
    path: '.cache/browser/settings-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Overview' })
    .click();
  await expect(page.getByText('Demo Student', { exact: true })).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/dashboard.png',
    fullPage: true,
  });
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const status = (await response.json()) as { accounts: Account[] };
    const first = status.accounts[0];
    await route.fulfill({
      response,
      json: {
        ...status,
        accounts: [
          first,
          {
            ...first,
            id: 'preview-second',
            name: 'Gymnasium Nordstadt',
            username: 'student-two',
            school: 'gym-nordstadt',
            lastSuccess: null,
            error: 'WEBUNTIS_INVALID_CREDENTIALS',
          },
          {
            ...first,
            id: 'preview-third',
            name: 'Realschule St. Martin',
            username: 'student-three',
            school: 'rs-st-martin',
            lastSuccess: new Date().toISOString(),
            error:
              'TIMETABLE_RANGE_RESTRICTED, TIMETABLE_DAYS_MISSING, EXAMS_MISSING_IDS',
          },
        ],
      },
    });
  });
  await page.reload();
  await expect(page.locator('.account-card')).toHaveCount(3);
  await expect(
    page.getByText('Synced · with notes', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.account-card')
    .filter({ hasText: 'Realschule St. Martin' })
    .locator('summary')
    .click();
  await expect(
    page.getByText(
      'The school allows access to only part of this date range. Only available days can be synced.',
    ),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/accounts-multiple.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText('Demo Student', { exact: true })).toBeVisible();
  await page.screenshot({ path: '.cache/browser/mobile.png', fullPage: false });
  await page.screenshot({
    path: '.cache/browser/accounts-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.unroute('**/api/status');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Username').fill('browser-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Browser-test-password-1972!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Settings' })
    .click();
  await page
    .getByLabel('Confirm with your password')
    .fill('Browser-test-password-1972!');
  const enrollmentResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/auth/two-factor/enable'),
  );
  await page.getByRole('button', { name: 'Set up 2FA' }).click();
  const enrollment = (await (await enrollmentResponse).json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  await expect(page.getByAltText('QR code for 2FA setup')).toBeVisible();
  await page.getByLabel('Authenticator code').fill(totp(enrollment.totpURI));
  await page.getByRole('button', { name: 'Confirm 2FA' }).click();
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stored securely' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Username').fill('browser-admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('Browser-test-password-1972!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Verification code' }),
  ).toBeVisible();
  // The code field must be a fresh input, not the reused username field.
  await expect(page.getByLabel('Authenticator code')).toHaveValue('');
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await page
    .getByLabel('Recovery code', { exact: true })
    .fill(enrollment.backupCodes[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Settings' })
    .click();
  await page
    .getByLabel('Confirm with your password')
    .fill('Browser-test-password-1972!');
  await page.getByRole('button', { name: 'Disable 2FA' }).click();
  await expect(page.getByText('Not enabled', { exact: true })).toBeVisible();
  await page.getByLabel('Current password').fill('Browser-test-password-1972!');
  await page.getByLabel('New password').fill('Changed-browser-password-1983!');
  await page
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  await expect(
    page.getByText('Password changed.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Calendar feeds' })
    .click();
  const copy = page.locator('article').filter({
    has: page.getByRole('heading', {
      name: 'My calendar (copy)',
      exact: true,
    }),
  });
  await copy.getByRole('button', { name: 'Edit & preview' }).click();
  await page.getByLabel('Feed name').fill('Secondary calendar');
  await page.getByRole('button', { name: 'Save feed' }).click();
  const secondary = page.locator('article').filter({
    has: page.getByRole('heading', {
      name: 'Secondary calendar',
      exact: true,
    }),
  });
  await browser.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'http://127.0.0.1:4173',
  });
  await secondary.getByRole('button', { name: 'Copy ICS link' }).click();
  await expect(
    secondary.getByRole('button', { name: 'Link copied' }),
  ).toBeVisible();
  const oldLink = await page.evaluate(() => navigator.clipboard.readText());
  expect((await page.request.get(oldLink)).status()).toBe(200);
  await secondary.getByRole('button', { name: 'Rotate link' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.request.get(oldLink)).status()).toBe(404);
  await secondary.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(secondary.getByText('Disabled', { exact: true })).toBeVisible();
  await secondary.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(secondary.getByText('Active', { exact: true })).toBeVisible();
  await secondary.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Secondary calendar' }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Overview', exact: true })
    .click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Account name').fill('Renamed student');
  await expect(page.getByLabel('Exam source')).toHaveValue('exams');
  await page.getByLabel('Exam source').selectOption('timetable');
  await page.getByRole('button', { name: 'Save account' }).click();
  await expect(
    page.getByRole('heading', { name: 'Renamed student' }),
  ).toBeVisible();
  await expect(
    page.getByText('Exams: Timetable', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Exam source')).toHaveValue('timetable');
  await page.getByLabel('Exam source').selectOption('exams');
  await page.screenshot({
    path: '.cache/browser/exam-source.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Save account' }).click();
  await expect(
    page.getByText('Exams: Exams tab, otherwise timetable', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Remove account' }),
  ).toBeVisible();
  await page.screenshot({
    path: '.cache/browser/confirm-remove.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Connect your first account' }),
  ).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Calendar feeds' })
    .click();
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Overview' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Sync all accounts' }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
  console.info(
    'Browser flows passed: browser language defaults/persisted overrides, setup expiry/reload/reopening, username setup, login, accounts, feeds, real preview, duplicate, settings, language, mobile, logout, TOTP enrollment, recovery login, disable, password change, edits, clipboard, token rotation and deletion.',
  );
} catch (error) {
  await page.screenshot({ path: '.cache/browser/failure.png', fullPage: true });
  throw error;
} finally {
  process.uptime = originalUptime;
  WebUntisClient.prototype.login = originalWebUntisLogin;
  await browser.close();
  await app.close();
  db.close();
}
