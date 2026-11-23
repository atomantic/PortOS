/**
 * Static scanner behind the server and client `mockContractConventions` guards.
 * Every live `vi.mock('<relative module>', factory)` is checked for three drifts:
 *
 * - the specifier must resolve to a file on disk; a dead path mocks nothing, so
 *   the suite silently runs the real module;
 * - a file registers each resolved module once; vitest keeps only the last
 *   registration, so an earlier one is a silently discarded stub;
 * - every explicit key a factory returns must be a real export of the target.
 *   A key the target does not export is a dead stub: it intercepts nothing, so a
 *   `.not.toHaveBeenCalled()` on it is vacuous, and a renamed export leaves its
 *   mock silently watching a function production no longer calls (the
 *   `peerAdministration` `pm2.restartProcess` shape).
 *
 * Key checks read `() => ({ ... })`, `async (importOriginal) => ({ ...await
 * importOriginal(), key })` and block-body `return { ... }` factories. Spread
 * entries inherit the real surface and are skipped; only the explicit keys beside
 * them are checked. A factory that is not an object literal is not read. Exports
 * are collected statically (`export *` followed) so the module under test is never
 * evaluated. Pure Node, test-time only.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '>']);
const WHITESPACE = /\s/;
const WORD_CHAR = /\w/;

/**
 * A `/` after an operator, opener or `return` begins a regex literal, not a division.
 * Reads back from `at` past whitespace (what `trimEnd` drops) instead of slicing the
 * whole prefix, which made masking quadratic in a file's `/` count.
 */
function startsRegex(source, at) {
  let end = at - 1;
  while (end >= 0 && WHITESPACE.test(source[end])) end -= 1;
  if (end < 0 || REGEX_PRECEDERS.has(source[end])) return true;
  const start = end - 5;
  return start >= 0 && source.startsWith('return', start) && (start === 0 || !WORD_CHAR.test(source[start - 1]));
}

/**
 * A quote glued to the end of an identifier cannot open a string literal, so it
 * is JSX text or prose (`scene's`, `the default's`), not code. Minified `return'x'` is
 * an accepted blind spot; formatted source puts a space before the quote.
 */
function isTextApostrophe(source, at) {
  return /[\p{L}\p{N}_$]/u.test(source[at - 1] ?? '');
}

/** Blank comments and string/template text (keeping `${}` code), preserving offsets. */
export function mask(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // Scans code from `i`; in expression mode returns at the `}` closing a `${`.
  const scan = (start, inExpression) => {
    let i = start;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? source.length : end;
        blank(i, stop);
        i = stop;
      } else if (ch === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(i, stop);
        i = stop;
      } else if (ch === '/' && startsRegex(source, i)) {
        // Regex literal: its quotes and brackets must not reach the string scanner.
        let j = i + 1;
        let inClass = false;
        while (j < source.length && (inClass || source[j] !== '/') && source[j] !== '\n') {
          if (source[j] === '\\') j += 1;
          else if (source[j] === '[') inClass = true;
          else if (source[j] === ']') inClass = false;
          j += 1;
        }
        blank(i + 1, j);
        i = j + 1;
      } else if ((ch === '\'' || ch === '"') && !isTextApostrophe(source, i)) {
        let j = i + 1;
        while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
        blank(i + 1, j);
        i = j + 1;
      } else if (ch === '`') {
        let j = i + 1;
        let textStart = j;
        while (j < source.length && source[j] !== '`') {
          if (source[j] === '\\') j += 2;
          else if (source[j] === '$' && source[j + 1] === '{') {
            blank(textStart, j);
            j = scan(j + 2, true) + 1;
            textStart = j;
          } else j += 1;
        }
        blank(textStart, j);
        i = j + 1;
      } else {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          if (inExpression && depth === 0) return i;
          depth -= 1;
        }
        i += 1;
      }
    }
    return i;
  };
  scan(0, false);
  return out.join('');
}

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js'), join(base, 'index.jsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Static export names of a module, following `export * from`. */
export function exportNames(file, seen = new Set(), names = new Set()) {
  if (seen.has(file)) return names;
  seen.add(file);
  const raw = readFileSync(file, 'utf8');
  const source = mask(raw);
  for (const m of source.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\bexport\s+(?:const|let|var|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\bexport\s+(?:const|let|var)\s*[{[]([^=]*)[}\]]\s*=/g)) {
    // Destructured declaration: `export const { a, b: c } = factory()` exports a and c.
    for (const part of m[1].split(',')) {
      const bound = part.split(':').pop().split('=')[0].replace(/[.\s]/g, '');
      if (bound) names.add(bound);
    }
  }
  if (/\bexport\s+default\b/.test(source)) names.add('default');
  for (const m of source.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*['"`]([^'"`]*)['"`])?/g)) {
    for (const part of m[1].split(',')) {
      const exported = part.trim().split(/\s+as\s+/).pop();
      if (exported) names.add(exported);
    }
  }
  // Specifiers are masked in `source`; read them from the same offsets in `raw`.
  for (const m of source.matchAll(/\bexport\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*(['"`])/g)) {
    if (m[1]) { names.add(m[1]); continue; }
    const start = m.index + m[0].length;
    const target = resolveModule(file, raw.slice(start, raw.indexOf(m[2], start)));
    if (target) exportNames(target, seen, names);
  }
  return names;
}

/** Index of the matching close for the bracket at `open`. */
function closeOf(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if ('({['.includes(masked[i])) depth += 1;
    else if (')}]'.includes(masked[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Explicit top-level `{ key, at }` entries of the object literal opening at `open` (`at` is the key's offset); spread entries are skipped. */
function literalKeys(raw, masked, open) {
  const close = closeOf(masked, open);
  if (close === -1) return [];
  const keys = [];
  let depth = 0;
  let segStart = open + 1;
  const flush = (end) => {
    const seg = masked.slice(segStart, end).trim();
    if (!seg || seg.startsWith('...')) return;
    const offset = segStart + masked.slice(segStart, end).indexOf(seg);
    const quoted = /^(['"`])/.exec(seg);
    if (quoted) {
      keys.push({ key: raw.slice(offset + 1, raw.indexOf(quoted[1], offset + 1)), at: offset });
      return;
    }
    const ident = /^(?:async\s+|get\s+|set\s+|\*\s*)?([\w$]+)/.exec(seg);
    if (ident) keys.push({ key: ident[1], at: offset });
  };
  for (let i = open + 1; i <= close; i += 1) {
    const ch = masked[i];
    if (i === close || (ch === ',' && depth === 0)) {
      flush(i);
      segStart = i + 1;
    } else if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
  }
  return keys;
}

// The specifier is a string, so `masked` blanks it: match on raw and require the call to be live code.
const MOCK_CALL_RE = /\bvi\.mock\(\s*(['"])([^'"\n]+)\1/g;
const COMMA_RE = /\s*,\s*/y;
const ARROW_RE = /\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>\s*/y;
const PAREN_OBJECT_RE = /\(\s*\{/y;
const RETURN_OBJECT_RE = /return\s*\(?\s*\{/y;

const stickyAt = (re, text, at) => {
  re.lastIndex = at;
  return re.exec(text);
};

/** Object literals a factory hands back: the expression body, or each top-level `return { ... }` of a block body. */
function factoryObjects(masked, afterSpecifier) {
  const comma = stickyAt(COMMA_RE, masked, afterSpecifier);
  if (!comma) return [];
  const arrowAt = afterSpecifier + comma[0].length;
  const arrow = stickyAt(ARROW_RE, masked, arrowAt);
  if (!arrow) return [];
  const body = arrowAt + arrow[0].length;
  const wrapped = stickyAt(PAREN_OBJECT_RE, masked, body);
  if (wrapped) return [body + wrapped[0].length - 1];
  if (masked[body] !== '{') return [];
  const close = closeOf(masked, body);
  if (close === -1) return [];
  const opens = [];
  let depth = 0;
  for (let i = body + 1; i < close; i += 1) {
    const ch = masked[i];
    if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
    else if (depth === 0 && ch === 'r' && !WORD_CHAR.test(masked[i - 1])) {
      const ret = stickyAt(RETURN_OBJECT_RE, masked, i);
      if (ret) opens.push(i + ret[0].length - 1);
    }
  }
  return opens;
}

const exportCache = new Map();
const lineAt = (source, index) => source.slice(0, index).split('\n').length;

/**
 * One `file:line — message` per drifted `vi.mock`: a relative specifier that does
 * not resolve, a module registered twice, or a factory key the real module does not
 * export. Allowlist entries (`<test file>|<specifier>|<key>`, with `<unresolved>` or
 * `<duplicate>` as the key for the first two) that excused a violation are added to
 * `used`, so callers can fail on entries the scan no longer needs (see `unusedAllowed`).
 */
export function mockDrift(testFile, rawSource, { root, allowed = new Map(), used = new Set() }) {
  // Most test files mock nothing; masking one is the scan's whole cost.
  if (!rawSource.includes('vi.mock(')) return [];
  const masked = mask(rawSource);
  const rel = relative(root, testFile).split(sep).join('/');
  const violations = [];
  const firstLine = new Map();
  const report = (spec, key, line, message) => {
    const allowKey = `${rel}|${spec}|${key}`;
    if (allowed.has(allowKey)) used.add(allowKey);
    else violations.push(`${rel}:${line} — ${spec} ${message}`);
  };
  for (const m of rawSource.matchAll(MOCK_CALL_RE)) {
    if (masked[m.index] !== 'v' || !m[2].startsWith('.')) continue;
    const line = lineAt(rawSource, m.index);
    const target = resolveModule(testFile, m[2]);
    if (!target) {
      report(m[2], '<unresolved>', line, 'does not resolve');
      continue;
    }
    if (firstLine.has(target)) {
      report(m[2], '<duplicate>', line, `duplicates the vi.mock at line ${firstLine.get(target)}, which this one replaces`);
    } else firstLine.set(target, line);
    const opens = factoryObjects(masked, m.index + m[0].length);
    if (opens.length === 0) continue;
    if (!exportCache.has(target)) exportCache.set(target, exportNames(target));
    const exported = exportCache.get(target);
    for (const open of opens) {
      for (const { key, at } of literalKeys(rawSource, masked, open)) {
        if (key !== '__esModule' && !exported.has(key)) report(m[2], key, lineAt(rawSource, at), `mocks ${key}`);
      }
    }
  }
  return violations;
}

/** Allowlist entries (`<test file>|<module specifier>|<key>`) the scan never needed. */
export const unusedAllowed = (allowed, used) => [...allowed.keys()].filter((k) => !used.has(k));
