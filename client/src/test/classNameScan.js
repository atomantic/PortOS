/**
 * Shared string-literal scanner for the class-string convention guards.
 *
 * `src/responsiveGridConventions.test.js` and `src/popoverClampConventions.test.js`
 * both enforce a narrow-viewport rule by reading every quoted string in the client
 * tree and inspecting the Tailwind tokens inside it. They need the same two
 * primitives — blank out comments so a doc block quoting an example class isn't
 * scanned as markup, then walk the remaining string literals — so those live here
 * once rather than being copied into each guard.
 *
 * Node-only consumers (test files) exclusively; kept in `src/test/` for the same
 * reason as `trackedFiles.js` — `lib/` carries the enforced barrel + README rule
 * and a test-only helper has no business in the browser barrel.
 */

/** Blank out `//` and block comments so a quoted example class isn't scanned as markup. */
export function maskComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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
