import { DateTime } from 'luxon';
import { expect, type Page } from '@playwright/test';
import type { Db } from '../src/server/db.js';
import { commitSnapshots } from '../src/server/events.js';
import { normalizeHolidays } from '../src/server/webuntis/normalize.js';
import { context } from './fixtures/events.js';

export async function verifyPageNavigation(page: Page) {
  await expect(page).toHaveURL('http://127.0.0.1:4173/feeds');
  await expect(page).toHaveTitle('Kalenderfeeds · WebUntis ICS Bridge');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Dein erster Kalenderfeed' }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Übersicht', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Kalenderfeeds' }),
  ).toHaveAttribute('aria-current', 'page');
  const tab = await page.context().newPage();
  try {
    await tab.goto('http://127.0.0.1:4173/settings');
    await expect(
      tab.getByRole('heading', { name: 'Einstellungen', exact: true }),
    ).toBeVisible();
    await tab.reload();
    await expect(
      tab.getByLabel('Synchronisierungsintervall', { exact: false }),
    ).toBeVisible();
    await tab.goto('http://127.0.0.1:4173/unknown-page');
    await expect(
      tab.getByRole('heading', { name: 'Seite nicht gefunden' }),
    ).toBeVisible();
    await tab.getByRole('link', { name: 'Zur Übersicht' }).click();
    await expect(tab).toHaveURL('http://127.0.0.1:4173/');
  } finally {
    await tab.close();
  }
  const isolated = await page
    .context()
    .browser()!
    .newContext({ locale: 'de-DE' });
  try {
    const guest = await isolated.newPage();
    await guest.goto('http://127.0.0.1:4173/settings');
    await expect(
      guest.getByRole('heading', { name: 'Willkommen zurück' }),
    ).toBeVisible();
    await expect(
      guest.getByLabel('Synchronisierungsintervall', { exact: false }),
    ).toHaveCount(0);
    expect(
      (await guest.request.get('http://127.0.0.1:4173/api/settings')).status(),
    ).toBe(401);
  } finally {
    await isolated.close();
  }
}

export async function verifySyncNotes(page: Page, db: Db, id: string) {
  const update = (error: string | null) =>
    db
      .prepare('UPDATE webuntis_accounts SET error=?, lastAttempt=? WHERE id=?')
      .run(error, new Date().toISOString(), id);
  update(
    'TIMETABLE_RANGE_RESTRICTED, TIMETABLE_DAYS_MISSING, EXAMS_AMBIGUOUS, EXAMS_FORBIDDEN',
  );
  const week = DateTime.now().startOf('week');
  const range = {
    start: week.toISODate()!,
    end: week.plus({ days: 6 }).toISODate()!,
  };
  await page.route('**/api/accounts/*/test', (route) =>
    route.fulfill({
      json: [
        { name: 'server', status: 'success' },
        { name: 'login', status: 'success' },
        { name: 'schoolyears', status: 'success' },
        { name: 'timetable', status: 'success', range },
        { name: 'exams', status: 'forbidden', range },
        { name: 'holidays', status: 'success' },
      ],
    }),
  );
  try {
    await page.reload();
    const card = page.locator('.account-card');
    await expect(
      card.getByText('Synchronisiert · mit Hinweisen', { exact: true }),
    ).toBeVisible();
    await expect(card.locator('.badge.warning')).toHaveCount(0);
    await expect(card.getByText('3 Hinweise', { exact: true })).toBeVisible();
    await card.locator('summary').click();
    await expect(
      card.getByText('Einzelne Tage fehlen', { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByText('Einige Prüfungen noch unklar', { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByText('Einige Prüfungen lassen sich nicht eindeutig zuordnen.', {
        exact: false,
      }),
    ).toBeVisible();
    await card.getByRole('button', { name: 'Verbindung testen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Verbindung steht · mit Hinweisen' }),
    ).toBeVisible();
    await expect(dialog.locator('.connection-summary.notes')).toBeVisible();
    await expect(
      dialog.getByText('Optional · in Ordnung', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Stundenplan & Prüfungen: aktuelle Woche', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog
        .locator('.connection-sync-history')
        .getByText('Einzelne Tage fehlen', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: '.cache/browser/connection-with-notes.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: '.cache/browser/connection-notes-mobile.png',
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Schließen', exact: true }).click();
    await expect(card.getByText('3 Hinweise', { exact: true })).toBeVisible();
    await page.reload();
    await expect(card.getByText('3 Hinweise', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    update('EXAMS_FORBIDDEN');
    await page.reload();
    await expect(
      card.getByText('Synchronisiert', { exact: true }),
    ).toBeVisible();
    await expect(card.locator('.sync-notices')).toHaveCount(0);
    await card.getByRole('button', { name: 'Verbindung testen' }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Verbindung erfolgreich' }),
    ).toBeVisible();
    await expect(
      dialog.getByText('Optional · in Ordnung', { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.connection-result.failed')).toHaveCount(0);
    await page.screenshot({
      path: '.cache/browser/connection-optional-exams.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Schließen', exact: true }).click();
  } finally {
    await page.unroute('**/api/accounts/*/test');
    update(null);
  }
}

export function seedPreviewHolidays(db: Db, accountId: string) {
  const today = DateTime.now().startOf('day');
  const start = today.toISODate()!;
  const lastDay = today.plus({ days: 6 }).toISODate()!;
  const singleDay = today.plus({ days: 12 }).toISODate()!;
  const events = normalizeHolidays(
    [
      { id: 801, longName: 'Holiday week', startDate: start, endDate: lastDay },
      {
        id: 802,
        longName: 'One day holiday',
        startDate: singleDay,
        endDate: singleDay,
      },
    ],
    context,
  );
  commitSnapshots(db, accountId, [
    {
      category: 'holiday',
      start,
      end: singleDay,
      events,
      confirmedEmptyDates: [],
    },
  ]);
  return { start, lastDay, singleDay };
}

export async function verifyHolidayPreview(
  page: Page,
  dates: { start: string; lastDay: string; singleDay: string },
) {
  await page.getByRole('tab', { name: 'Ferien', exact: true }).click();
  const formatter = new Intl.DateTimeFormat('de', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const week = page
    .locator('.preview article')
    .filter({ hasText: 'Holiday week' });
  await expect(week.locator('.preview-date')).toHaveText(
    formatter.formatRange(new Date(dates.start), new Date(dates.lastDay)),
  );
  const single = page
    .locator('.preview article')
    .filter({ hasText: 'One day holiday' });
  await expect(single.locator('.preview-date')).toHaveText(
    formatter.format(new Date(dates.singleDay)),
  );
  await single.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '.cache/browser/holiday-preview.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await week.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '.cache/browser/holiday-preview-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
