import { expect, test } from 'vitest';
import ICAL from 'ical.js';
import { eventTemplateValues } from '../src/server/webuntis/template-values.js';
import {
  normalizeExams,
  normalizeRpc,
  normalizeTimetable,
} from '../src/server/webuntis/normalize.js';
import { defaultTemplates, feedInput } from '../src/shared/feeds.js';
import { generateCalendar, renderEvent } from '../src/server/ics.js';
import { commitSnapshots, storedEvents } from '../src/server/events.js';
import { getFeed, saveFeed } from '../src/server/feeds.js';
import { context, timetableFixture } from './fixtures/events.js';
import { identityAccount, identityDatabase } from './fixtures/exam-identity.js';

function namedLesson() {
  const data = structuredClone(timetableFixture);
  const entry = data.days[0].gridEntries[0];
  entry.position1 = [
    {
      current: {
        type: 'SUBJECT',
        shortName: 'D-BS+',
        longName: 'Deutsch BSP',
        displayName: 'Deutsch BSP (D-BS+)',
      },
    },
  ];
  entry.position2 = [
    {
      current: {
        type: 'TEACHER',
        shortName: 'Mey',
        longName: 'Meyer',
        displayName: 'Meyer (Mey)',
      },
    },
  ];
  entry.position3 = [
    {
      current: {
        type: 'ROOM',
        shortName: 'E 01',
        longName: 'Staff room description',
        displayName: 'E 01',
      },
    },
  ];
  entry.position4 = [
    {
      current: {
        type: 'CLASS',
        shortName: 'C10',
        longName: 'Class description',
        displayName: 'C10 (Class description)',
      },
    },
  ];
  entry.lessonInfo = '';
  return { data, entry };
}

test('REST names remain separately selectable and default notes/location use the intended fields', () => {
  const { data } = namedLesson();
  const event = normalizeTimetable(data, context)[0];
  const values = eventTemplateValues(event);
  expect(values).toMatchObject({
    subjectShort: 'D-BS+',
    subjectLong: 'Deutsch BSP',
    subjectDisplay: 'Deutsch BSP (D-BS+)',
    teacherShort: 'Mey',
    teacherLong: 'Meyer',
    teacherDisplay: 'Meyer (Mey)',
    roomShort: 'E 01',
    roomLong: 'Staff room description',
    roomDisplay: 'E 01',
    classShort: 'C10',
    classLong: 'Class description',
    classDisplay: 'C10 (Class description)',
  });
  const db = identityDatabase();
  try {
    const accountId = identityAccount(db);
    commitSnapshots(db, accountId, [
      {
        category: 'lesson',
        start: event.date,
        end: event.date,
        events: [event],
        confirmedEmptyDates: [],
      },
    ]);
    const templates = defaultTemplates('de');
    const feed = saveFeed(db, {
      name: 'Names',
      enabled: true,
      language: 'de',
      pastDays: 1,
      futureDays: 30,
      cancellation: 'mark',
      sources: [{ accountId, kinds: ['lesson'] }],
      templates,
    });
    const stored = storedEvents(db)[0];
    expect(renderEvent(feed, stored)).toEqual({
      title: 'D-BS+ · Mey (C10)',
      description:
        'Fach: Deutsch BSP\nLehrkraft: Meyer (Mey)\nKlasse: C10\nStandort: E 01',
      location: 'E 01',
    });
    const now = new Date('2026-10-20T05:00:00Z');
    const parse = (body: string) =>
      new ICAL.Component(ICAL.parse(body)).getFirstSubcomponent('vevent')!;
    const first = parse(generateCalendar(db, feed, now).body);
    expect(first.getFirstPropertyValue('location')).toBe('E 01');
    // Preserve a custom legacy title while editing the actual ICS location.
    feed.templates.lesson.title = 'Custom {{subject}} / {{teacher}}';
    feed.templates.lesson.location =
      'Raum {{roomShort}}; Haus A, Eingang Nord\n{{classShort}}';
    const saved = saveFeed(db, feed, feed.id);
    expect(getFeed(db, saved.id).templates).toEqual(feed.templates);
    const calendar = generateCalendar(db, saved, now);
    const changed = parse(calendar.body);
    expect(changed.getFirstPropertyValue('summary')).toBe(
      'Custom Deutsch BSP / Meyer',
    );
    expect(changed.getFirstPropertyValue('location')).toBe(
      'Raum E 01; Haus A, Eingang Nord\nC10',
    );
    expect(changed.getFirstPropertyValue('uid')).toBe(
      first.getFirstPropertyValue('uid'),
    );
    expect(changed.getFirstPropertyValue('sequence')).toBe(1);
    expect(generateCalendar(db, saved, now)).toEqual(calendar);
    expect(parse(calendar.body).getFirstPropertyValue('description')).toBe(
      renderEvent(saved, stored).description,
    );
  } finally {
    db.close();
  }
});

test('historical values need no backfill and missing or hidden names remain safe', () => {
  const { data, entry } = namedLesson();
  entry.position2 = null;
  entry.position4 = null;
  const event = normalizeTimetable(data, context)[0];
  // Persisted snapshots created before variants existed contain only base fields.
  const legacy = JSON.parse(JSON.stringify(event)) as typeof event;
  for (const key of Object.keys(legacy.values)) {
    if (/(Short|Long|Display)$/.test(key))
      Reflect.deleteProperty(legacy.values, key);
  }
  const before = JSON.stringify(legacy);
  const values = eventTemplateValues(legacy);
  expect(values.subjectShort).toBe('D-BS+');
  expect(values.teacherShort).toBe('');
  expect(values.classLong).toBe('');
  expect(JSON.stringify(legacy)).toBe(before);
  const unknownSource = { ...legacy, source: '{}' };
  expect(eventTemplateValues(unknownSource).subjectShort).toBe('Deutsch BSP');
});

test('multiple resources, display-only names and original/substitute teachers are retained', () => {
  const { data, entry } = namedLesson();
  entry.status = 'CHANGED';
  entry.position2![0].removed = {
    type: 'TEACHER',
    shortName: 'Old',
    longName: 'Original',
    displayName: 'Original (Old)',
  };
  entry.position2!.push({
    current: { type: 'TEACHER', displayName: 'Second teacher' },
  });
  entry.position4!.push(structuredClone(entry.position4![0]));
  const event = normalizeTimetable(data, context)[0];
  event.source = JSON.stringify({
    timetable: JSON.parse(event.source),
    exam: {},
  });
  expect(eventTemplateValues(event)).toMatchObject({
    teacherShort: 'Mey, Second teacher',
    teacherLong: 'Meyer, Second teacher',
    substituteTeacherDisplay: 'Meyer (Mey), Second teacher',
    originalTeacherShort: 'Old',
    originalTeacherLong: 'Original',
    originalTeacherDisplay: 'Original (Old)',
    classShort: 'C10',
  });
});

test('RPC names use the matching resource labels and retain an original teacher', () => {
  const event = normalizeRpc(
    [
      {
        id: 9,
        date: 20261020,
        startTime: 800,
        endTime: 845,
        code: 'irregular',
        su: [{ id: 1, name: 'MA', longname: 'Mathematics' }],
        te: [
          { id: 2, name: 'TA', longname: 'Teacher A', orgid: 3, orgname: 'TB' },
        ],
        ro: [{ id: 4, name: 'R1', longname: 'Laboratory' }],
        kl: [{ id: 5, name: 'C1', longname: 'Class one' }],
      },
    ],
    context,
  )[0];
  expect(eventTemplateValues(event)).toMatchObject({
    subjectShort: 'MA',
    subjectLong: 'Mathematics',
    teacherShort: 'TA',
    teacherDisplay: 'Teacher A',
    roomShort: 'R1',
    roomLong: 'Laboratory',
    classShort: 'C1',
    originalTeacherShort: 'TB',
    substituteTeacherLong: 'Teacher A',
  });
});

test('separate exams support named objects and plain strings without inventing missing names', () => {
  const event = normalizeExams(
    [
      {
        id: 20,
        examDate: 20261020,
        name: 'Test',
        subject: 'MA',
        teachers: [{ name: 'TA', longName: 'Teacher A' }, 'Teacher B'],
        rooms: [{ name: 'R1', longName: 'Laboratory' }],
        studentClass: ['C1', 'C1'],
      },
    ],
    context,
  )[0];
  expect(eventTemplateValues(event)).toMatchObject({
    subjectShort: 'MA',
    subjectLong: 'MA',
    teacherShort: 'TA, Teacher B',
    teacherLong: 'Teacher A, Teacher B',
    roomShort: 'R1',
    roomLong: 'Laboratory',
    classShort: 'C1',
  });
});

test.each(['de', 'en'] as const)(
  'defaults hide missing details and label substitutions/exams in %s',
  (language) => {
    const { data, entry } = namedLesson();
    entry.position2 = null;
    entry.position4 = null;
    entry.position3 = [
      {
        current: {
          type: 'ROOM',
          longName: 'Staff description',
          displayName: 'Gym West',
        },
      },
    ];
    const event = normalizeTimetable(data, context)[0];
    const stored = {
      ...event,
      accountId: 'fixture',
      revision: 0,
      createdAt: event.start,
      modifiedAt: event.start,
    };
    const feed = feedInput.parse({
      name: 'Preview',
      enabled: false,
      sources: [],
      language,
      templates: defaultTemplates(language),
    });
    expect(renderEvent(feed, stored)).toEqual({
      title: 'D-BS+',
      description:
        language === 'de'
          ? 'Fach: Deutsch BSP\nStandort: Gym West'
          : 'Subject: Deutsch BSP\nLocation: Gym West',
      location: 'Gym West',
    });
    expect(renderEvent(feed, { ...stored, kind: 'substitution' }).title).toBe(
      language === 'de' ? 'Vertretung · D-BS+' : 'Substitution · D-BS+',
    );
    expect(renderEvent(feed, { ...stored, kind: 'cancelled' }).title).toBe(
      language === 'de' ? 'Entfällt · D-BS+' : 'Cancelled · D-BS+',
    );
    for (const kind of ['lesson', 'cancelled', 'substitution'] as const) {
      const withInfo = renderEvent(feed, {
        ...stored,
        kind,
        values: { ...stored.values, info: 'Bring calculator' },
      });
      expect(
        withInfo.description.endsWith(
          language === 'de'
            ? 'Notiz: Bring calculator\nStandort: Gym West'
            : 'Note: Bring calculator\nLocation: Gym West',
        ),
      ).toBe(true);
    }
    const exam = renderEvent(feed, {
      ...stored,
      kind: 'exam',
      values: { ...stored.values, examType: 'Written', examText: 'Chapter 2' },
    });
    expect(exam.title).toBe(
      language === 'de' ? 'Prüfung · D-BS+' : 'Exam · D-BS+',
    );
    expect(exam.description).toContain(
      language === 'de' ? 'Prüfungsart: Written' : 'Exam type: Written',
    );
    expect(
      exam.description.endsWith(
        language === 'de'
          ? 'Notiz: Chapter 2\nStandort: Gym West'
          : 'Note: Chapter 2\nLocation: Gym West',
      ),
    ).toBe(true);
    expect(exam.description).not.toContain('\n\n');
    const source = { ...entry, position3: [] };
    const noRoom = {
      ...stored,
      source: JSON.stringify(source),
      values: { ...stored.values, room: '' },
    };
    expect(renderEvent(feed, noRoom).description).toBe(
      language === 'de' ? 'Fach: Deutsch BSP' : 'Subject: Deutsch BSP',
    );
    expect(renderEvent(feed, noRoom).location).toBe('');
  },
);
