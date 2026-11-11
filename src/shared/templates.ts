import { variables, type EventValues, type Variable } from './events.js';

type Part =
  | { type: 'text'; value: string }
  | { type: 'variable'; names: Variable[] }
  | { type: 'optional'; parts: Part[] };
const knownVariables = new Set<string>(variables);

export function parseTemplate(template: string): Part[] {
  if (template.length > 14000) throw new Error('Template is too long');
  const parts: Part[] = [];
  let index = 0;
  while (index < template.length) {
    if (template.startsWith('[[', index)) {
      const end = template.indexOf(']]', index + 2);
      if (end < 0) throw new Error('Unclosed optional block');
      const content = template.slice(index + 2, end);
      if (content.includes('[['))
        throw new Error('Nested optional blocks are not supported');
      parts.push({ type: 'optional', parts: parseTemplate(content) });
      index = end + 2;
    } else if (template.startsWith('{{', index)) {
      const end = template.indexOf('}}', index + 2);
      if (end < 0) throw new Error('Unclosed variable');
      const names = template
        .slice(index + 2, end)
        .split('|')
        .map((name) => name.trim());
      for (const name of names) {
        if (!knownVariables.has(name))
          throw new Error(`Unknown variable: ${name}`);
      }
      parts.push({ type: 'variable', names: names as Variable[] });
      index = end + 2;
    } else {
      if (template.startsWith(']]', index) || template.startsWith('}}', index))
        throw new Error('Unexpected closing delimiter');
      const start = index;
      index++;
      while (
        index < template.length &&
        !['[[', '{{', ']]', '}}'].some((token) =>
          template.startsWith(token, index),
        )
      )
        index++;
      parts.push({ type: 'text', value: template.slice(start, index) });
    }
  }
  return parts;
}
function renderVariables(names: Variable[], values: EventValues): string {
  if (names.length === 1) return values[names[0]] ?? '';
  return names
    .map((name) => values[name]?.trim() ?? '')
    .filter(Boolean)
    .join(' · ');
}
function renderParts(parts: Part[], values: EventValues): string {
  let text = '';
  for (const part of parts) {
    if (part.type === 'text') text += part.value;
    else if (part.type === 'variable')
      text += renderVariables(part.names, values);
    else {
      const missing = part.parts.some(
        (child) =>
          child.type === 'variable' &&
          !renderVariables(child.names, values).trim(),
      );
      if (!missing) text += renderParts(part.parts, values);
    }
  }
  return text;
}
export function renderTemplate(template: string, values: EventValues): string {
  return renderParts(parseTemplate(template), values).trim();
}
export function templateError(template: string): string | null {
  try {
    parseTemplate(template);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid template';
  }
}
