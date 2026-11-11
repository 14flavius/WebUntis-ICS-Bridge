/**
 * Generates the README screenshots from a disposable, synthetic instance.
 * Everything here is fake demo data on an in-memory database - no real account,
 * school or timetable is ever touched. Run with: npm run screenshots
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/db.js';
import { commitSnapshots } from '../src/server/events.js';
import { saveFeed } from '../src/server/feeds.js';
import { defaultTemplates } from '../src/shared/feeds.js';
import type { EventKind } from '../src/shared/events.js';
import { normalizeTimetable } from '../src/server/webuntis/normalize.js';
import { timetableSchema } from '../src/server/webuntis/schemas.js';

const PORT = 4318;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = '.github/screenshots';
const PASSWORD = 'DemoPassword-2026!';
const ZONE = 'Europe/Berlin';
const WIDTH = 1280;
const VIEWPORT_HEIGHT = 1100;
const CONTENT_PADDING = 40;
const FRAME_RADIUS = 14;

await mkdir('.cache/screenshots', { recursive: true });
await mkdir(OUT, { recursive: true });

const db = openDatabase(':memory:');
const app = await buildApp(db, {
  publicUrl: BASE,
  authSecret: randomBytes(32).toString('hex'),
  encryptionKey: randomBytes(32).toString('hex'),
  production: true,
});
await app.listen({ host: '127.0.0.1', port: PORT });

// --- Seed synthetic demo data -------------------------------------------------
const today = DateTime.now().setZone(ZONE).toISODate()!;
const tomorrow = DateTime.now().setZone(ZONE).plus({ days: 1 }).toISODate()!;

interface DemoLesson {
  id: number;
  subject: string;
  teacher: string;
  room: string;
  date: string;
  from: string;
  to: string;
  extra?: Record<string, unknown>;
}
interface DemoAccount {
  name: string;
  username: string;
  school: string;
  className: string;
  lessons: DemoLesson[];
}

function seedAccount(account: DemoAccount): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    id,
    account.name,
    account.school,
    'https://demo.webuntis.com',
    account.username,
    'encrypted',
    ZONE,
  );
  const days = [today, tomorrow].map((date) => ({
    date,
    status: 'REGULAR',
    gridEntries: account.lessons
      .filter((lesson) => lesson.date === date)
      .map((lesson) => ({
        ids: [lesson.id],
        status: 'REGULAR',
        duration: {
          start: `${date}T${lesson.from}`,
          end: `${date}T${lesson.to}`,
        },
        position1: [
          { current: { type: 'SUBJECT', shortName: lesson.subject } },
        ],
        position2: [
          { current: { type: 'TEACHER', shortName: lesson.teacher } },
        ],
        position3: [{ current: { type: 'ROOM', shortName: lesson.room } }],
        position4: [
          { current: { type: 'CLASS', shortName: account.className } },
        ],
        ...lesson.extra,
      })),
  }));
  const timetable = timetableSchema.parse({ format: 1, errors: [], days });
  commitSnapshots(db, id, [
    {
      category: 'lesson',
      start: today,
      end: tomorrow,
      events: normalizeTimetable(timetable, {
        name: account.name,
        timezone: ZONE,
      }),
      confirmedEmptyDates: [],
    },
  ]);
  return id;
}

const daySchool = seedAccount({
  name: 'High school',
  username: 'alex.demo',
  school: 'demo-high-school',
  className: '10b',
  lessons: [
    {
      id: 101,
      subject: 'Math',
      teacher: 'Lang',
      room: 'A14',
      date: today,
      from: '08:00',
      to: '08:45',
      extra: { lessonInfo: 'Bring your calculator' },
    },
    {
      id: 102,
      subject: 'English',
      teacher: 'Ortega',
      room: 'A14',
      date: today,
      from: '08:50',
      to: '09:35',
    },
    {
      id: 103,
      subject: 'Biology',
      teacher: 'Weber',
      room: 'Lab 2',
      date: today,
      from: '10:00',
      to: '11:30',
      extra: {
        type: 'EXAM',
        name: 'Genetics test',
        lessonInfo: 'Chapters 4 to 6',
      },
    },
    {
      id: 201,
      subject: 'History',
      teacher: 'Neumann',
      room: 'B07',
      date: tomorrow,
      from: '09:00',
      to: '09:45',
    },
    {
      id: 202,
      subject: 'Chemistry',
      teacher: 'Fischer',
      room: 'Lab 1',
      date: tomorrow,
      from: '10:00',
      to: '10:45',
      extra: { status: 'CANCELLED' },
    },
  ],
});
const eveningSchool = seedAccount({
  name: 'Evening school',
  username: 'alex.demo',
  school: 'demo-evening-school',
  className: 'E2',
  lessons: [
    {
      id: 301,
      subject: 'German',
      teacher: 'Brandt',
      room: 'C03',
      date: today,
      from: '18:00',
      to: '19:30',
    },
    {
      id: 302,
      subject: 'Accounting',
      teacher: 'Keller',
      room: 'C05',
      date: today,
      from: '19:45',
      to: '21:15',
    },
    {
      id: 401,
      subject: 'Physics',
      teacher: 'Sommer',
      room: 'Lab 3',
      date: tomorrow,
      from: '18:00',
      to: '19:30',
    },
  ],
});

const everything: EventKind[] = [
  'lesson',
  'substitution',
  'cancelled',
  'exam',
  'holiday',
];
saveFeed(db, {
  name: 'My timetable',
  enabled: true,
  pastDays: 14,
  futureDays: 90,
  language: 'en',
  cancellation: 'mark',
  sources: [
    { accountId: daySchool, kinds: [...everything] },
    { accountId: eveningSchool, kinds: [...everything] },
  ],
  templates: defaultTemplates('en'),
});
saveFeed(db, {
  name: 'Exams only',
  enabled: true,
  pastDays: 30,
  futureDays: 120,
  language: 'en',
  cancellation: 'omit',
  sources: [{ accountId: daySchool, kinds: ['exam'] }],
  templates: defaultTemplates('en'),
});

// --- Capture the UI in English ------------------------------------------------
const dir = await mkdtemp(resolve('.cache/screenshots/run-'));
const browser = await chromium.launchPersistentContext(dir, {
  executablePath:
    process.env.CHROME_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  locale: 'en-US',
  viewport: { width: WIDTH, height: VIEWPORT_HEIGHT },
  // Retina-resolution captures stay sharp when GitHub scales them down.
  deviceScaleFactor: 2,
});
const page = await browser.newPage();
page.setDefaultTimeout(15000);

/** Rounded corners and a hairline border keep the light UI readable on both
 * GitHub themes; the corners stay transparent. */
async function saveFramed(name: string, image: Buffer) {
  const frame = await browser.newPage();
  await frame.setContent(
    `<body style="margin:0;background:transparent">
      <img src="data:image/png;base64,${image.toString('base64')}"
        style="display:block;box-sizing:border-box;border-radius:${FRAME_RADIUS}px;border:1px solid rgba(20,60,45,.22)" />
    </body>`,
  );
  const element = frame.locator('img');
  await element.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    img.style.width = `${img.naturalWidth / window.devicePixelRatio}px`;
  });
  await writeFile(
    `${OUT}/${name}.png`,
    await element.screenshot({ omitBackground: true }),
  );
  await frame.close();
  console.log(`captured ${name}`);
}

/** Crop below the last piece of content instead of keeping an empty viewport. */
async function shootPage(target: Page, name: string) {
  await target.waitForLoadState('networkidle');
  // Park the pointer so no button is captured in its hover state.
  await target.mouse.move(0, 0);
  const bottom = await target.evaluate(() =>
    Math.max(
      ...[...document.querySelectorAll('main *')].map(
        (element) => element.getBoundingClientRect().bottom,
      ),
    ),
  );
  const height = Math.min(VIEWPORT_HEIGHT, Math.ceil(bottom) + CONTENT_PADDING);
  await saveFramed(
    name,
    await target.screenshot({
      clip: { x: 0, y: 0, width: WIDTH, height },
    }),
  );
}

try {
  await page.goto(BASE);
  // One-time administrator setup, then sign in.
  await page.getByLabel('Username').fill('demo-admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create administrator', exact: true })
    .click();
  // Wait for the login view to mount before filling, otherwise the values land
  // in the unmounting setup form and are lost in the transition.
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.getByLabel('Username').fill('demo-admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  await shootPage(page, 'dashboard');

  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Calendar feeds' })
    .click();
  await page.getByRole('heading', { name: 'My timetable' }).waitFor();
  await shootPage(page, 'feeds');

  await page
    .locator('article.feed-card')
    .filter({ has: page.getByRole('heading', { name: 'My timetable' }) })
    .getByRole('button', { name: 'Edit & preview' })
    .click();
  await page.getByRole('heading', { name: 'Edit feed' }).waitFor();
  await page.waitForLoadState('networkidle');
  await saveFramed(
    'feed-editor',
    await page.locator('dialog[open]').screenshot(),
  );

  console.log(`\nScreenshots written to ${OUT}/`);
} catch (error) {
  await page.screenshot({
    path: '.cache/screenshots/debug.png',
    fullPage: true,
  });
  console.error('Captured .cache/screenshots/debug.png for inspection.');
  throw error;
} finally {
  await browser.close();
  await app.close();
}
