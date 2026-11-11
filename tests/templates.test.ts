import { expect, test } from 'vitest';
import { parseTemplate, renderTemplate } from '../src/shared/templates.js';
import { variables } from '../src/shared/events.js';
import { valuesFor } from '../src/server/webuntis/normalize.js';
import { feedInput, defaultTemplates } from '../src/shared/feeds.js';

test('all variables are supported and values cannot execute or inject templates', () => {
  const values = valuesFor('Account');
  for (const variable of variables) {
    values[variable] = `<script>${variable}</script>{{room}}`;
    expect(renderTemplate(`{{${variable}}}`, values)).toBe(values[variable]);
  }
});
test('optional blocks require every referenced value', () => {
  const values = valuesFor('Account');
  expect(renderTemplate('[[ (Info! {{info}}) ]]', values)).toBe('');
  values.info = 'Bring calculator';
  expect(renderTemplate('[[ (Info! {{info}}) ]]', values)).toBe(
    '(Info! Bring calculator)',
  );
  expect(renderTemplate('[[{{subject}} ({{teacher}})]]', values)).toBe('');
  values.subject = 'Math';
  values.teacher = 'Teacher A';
  expect(renderTemplate('{{subject}} [[({{teacher}})]]', values)).toBe(
    'Math (Teacher A)',
  );
});
test('unknown variables, malformed and nested blocks fail validation', () => {
  for (const text of [
    '{{unknown}}',
    '{{constructor}}',
    '{{subjectShort | unknown}}',
    '{{subjectShort |}}',
    '{{|teacherShort}}',
    '{{subjectShort || teacherShort}}',
    '{{subject',
    '[[ missing',
    '[[nested [[{{info}}]] ]]',
    '}}',
  ])
    expect(() => parseTemplate(text)).toThrow();
  const templates = defaultTemplates('de');
  templates.lesson.title = '{{unknown}}';
  expect(
    feedInput.safeParse({
      name: 'Test',
      sources: [
        {
          accountId: 'bc12e26d-f0ad-4e99-994b-2b5cc17f7eac',
          kinds: ['lesson'],
        },
      ],
      templates,
    }).success,
  ).toBe(false);
});

test('default titles join only populated subject/teacher names and put the class in parentheses', () => {
  const title = defaultTemplates('de').lesson.title;
  for (const [subject, teacher, group, expected] of [
    ['MA', 'TA', 'C10', 'MA · TA (C10)'],
    ['MA', 'TA', '', 'MA · TA'],
    ['MA', '', 'C10', 'MA (C10)'],
    ['', 'TA', 'C10', 'TA (C10)'],
    ['MA', '', '', 'MA'],
    ['', 'TA', '', 'TA'],
    ['', '', 'C10', '(C10)'],
    ['', '', '', ''],
    ['  ', 'TA', '  ', 'TA'],
  ]) {
    const values = {
      ...valuesFor('Account'),
      subjectShort: subject,
      teacherShort: teacher,
      classShort: group,
    };
    expect(renderTemplate(title, values)).toBe(expected);
  }
});

test('joined variables remain literal text and optional blocks use the joined result', () => {
  const values = {
    ...valuesFor('Account'),
    teacherShort: 'A|B {{classShort}}',
  };
  expect(
    renderTemplate('[[Team: {{subjectShort | teacherShort}}]]', values),
  ).toBe('Team: A|B {{classShort}}');
  expect(
    renderTemplate('[[Team: {{subjectShort | classShort}}]]', values),
  ).toBe('');
  expect(renderTemplate('Custom · {{teacherShort}} ·', values)).toBe(
    'Custom · A|B {{classShort}} ·',
  );
});
