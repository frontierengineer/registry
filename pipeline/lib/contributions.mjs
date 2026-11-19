// The Contributions File, `contributions.json` at the root of the
// Application's repository: JSON with comments and trailing commas allowed,
// read without running anything. The rules are the Host's
// (containers/host/modules/source/internal/{jsonc,contributions}.ts).

import { idProblem } from './identity.mjs';

export const CONTRIBUTIONS_FILE = 'contributions.json';

const QUOTE = '"';
const ESCAPE = '\\';
const CLOSERS = new Set(['}', ']']);
const SPACE = /\s/;

function withoutComments(text) {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1] ?? '';
    if (inString) {
      out += char;
      if (char === ESCAPE) { out += next; index += 2; continue; }
      if (char === QUOTE) inString = false;
      index += 1;
      continue;
    }
    if (char === QUOTE) { inString = true; out += char; index += 1; continue; }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      out += ' ';
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function withoutTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === ESCAPE) { out += text[index + 1] ?? ''; index += 1; continue; }
      if (char === QUOTE) inString = false;
      continue;
    }
    if (char === QUOTE) { inString = true; out += char; continue; }
    if (char === ',') {
      let ahead = index + 1;
      while (ahead < text.length && SPACE.test(text[ahead])) ahead += 1;
      if (CLOSERS.has(text[ahead] ?? '')) continue;
    }
    out += char;
  }
  return out;
}

export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The parsed Contributions File, or a string saying why it is not one. */
export function contributionsOf(text) {
  let declared;
  try {
    declared = JSON.parse(withoutTrailingCommas(withoutComments(text)));
  } catch (failure) {
    return `${CONTRIBUTIONS_FILE} is not JSON: ${failure.message}`;
  }
  if (!isObject(declared)) return `${CONTRIBUTIONS_FILE} is not a JSON object`;
  if (typeof declared.id !== 'string') return `${CONTRIBUTIONS_FILE} declares no id`;
  const wrongId = idProblem(declared.id);
  if (wrongId !== null) return `${CONTRIBUTIONS_FILE}: ${wrongId}`;
  if (typeof declared.title !== 'string') return `${CONTRIBUTIONS_FILE} declares no title`;
  if (typeof declared.color !== 'string') return `${CONTRIBUTIONS_FILE} declares no color`;
  if (declared.dependencies !== undefined) {
    if (!Array.isArray(declared.dependencies)) return `${CONTRIBUTIONS_FILE}: its dependencies are not a list`;
    if (declared.dependencies.some((entry) => !isObject(entry) || typeof entry.id !== 'string')) return `${CONTRIBUTIONS_FILE}: a dependency names no id`;
  }
  for (const name of ['surface', 'host', 'worker']) {
    if (declared[name] !== undefined && !isObject(declared[name])) return `${CONTRIBUTIONS_FILE}: its ${name} section is not an object`;
  }
  return declared;
}
