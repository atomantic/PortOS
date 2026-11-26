/**
 * Shared string-literal scanner for the class-string convention guards.
 *
 * The Tailwind class and sub-nav guards enforce class-string conventions by
 * reading every quoted string in the client tree and inspecting the Tailwind
 * tokens inside it. They need the same two primitives — blank out comments so a
 * doc block quoting an example class isn't scanned as markup, then walk the
 * remaining string literals — so those live here once rather than being copied
 * into each guard.
 *
 * Node-only consumers (test files) exclusively; kept in `src/test/` for the same
 * reason as `trackedFiles.js` — `lib/` carries the enforced barrel + README rule
 * and a test-only helper has no business in the browser barrel.
 */

import { guardCorpus } from '../../../scripts/lib/guardCorpus.js';

/** Blank out `//` and block comments so a quoted example class isn't scanned as markup. */
export const maskComments = (source) => guardCorpus().derive('clientMaskedComments', source, () => blankComments(source));

function blankComments(source) {
  let out = '';
  let retainedFrom = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i + 2);
      const end = newline === -1 ? source.length : newline;
      out += source.slice(retainedFrom, i) + ' '.repeat(end - i);
      retainedFrom = end;
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 1);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(retainedFrom, i) + source.slice(i, end).replace(/[^\n]/g, ' ');
      if (close === -1) out += '  ';
      retainedFrom = end;
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        i += source[i] === '\\' ? 2 : 1;
      }
    }
    i += 1;
  }
  return out + source.slice(retainedFrom);
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Every quoted string in `source`, as `{ value, index }` in source order. */
export function stringLiterals(source) {
  const found = [];
  let match;
  STRING_LITERAL.lastIndex = 0;
  while ((match = STRING_LITERAL.exec(source))) found.push({ value: match[2], index: match.index });
  return found;
}

/** 1-based line number of a character offset. */
export function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}
