/**
 * Static scanner behind the server and client `mockContractConventions` guards:
 * a `vi.mock('<relative module>', () => ({ ... }))` factory must define only
 * members the real module exports.
 *
 * A key the target does not export is a dead stub: it intercepts nothing, so a
 * `.not.toHaveBeenCalled()` on it is vacuous, and a renamed export leaves its
 * mock silently watching a function production no longer calls (the
 * `peerAdministration` `pm2.restartProcess` shape).
 *
 * Only literal `() => ({ ... })` factories are read; a factory that spreads
 * `importOriginal()` / `vi.importActual()` inherits the real surface and is
 * skipped. Exports are collected statically (`export *` followed) so the module
 * under test is never evaluated. Pure Node, test-time only.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

/** A `/` after an operator, opener or `return` begins a regex literal, not a division. */
function startsRegex(source, at) {
  const before = source.slice(0, at).trimEnd();
  return before === '' || /[(,=:[!&|?{};>]$/.test(before) || /\breturn$/.test(before);
}

const KEYWORD_BEFORE_STRING = /(?:^|[^\w$.])(?:return|case|typeof|in|of|yield|await|default|else|do|void|delete|new|throw|instanceof|from|import|export|as)$/;

/**
 * A quote glued to the end of an identifier cannot open a string literal, so it
 * is JSX text or prose (`scene's`), not code. Keywords legitimately precede strings.
 */
function isTextApostrophe(source, at) {
  if (!/[\w$]/.test(source[at - 1] ?? '')) return false;
  return !KEYWORD_BEFORE_STRING.test(source.slice(Math.max(0, at - 12), at));
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

/** Top-level keys of the object literal opening at `open`, or null when it spreads. */
function literalKeys(raw, masked, open) {
  const close = closeOf(masked, open);
  if (close === -1) return null;
  const keys = [];
  let depth = 0;
  let segStart = open + 1;
  const flush = (end) => {
    const seg = masked.slice(segStart, end).trim();
    if (!seg) return true;
    if (seg.startsWith('...')) return false;
    const offset = segStart + masked.slice(segStart, end).indexOf(seg);
    const quoted = /^(['"`])/.exec(seg);
    if (quoted) {
      keys.push(raw.slice(offset + 1, raw.indexOf(quoted[1], offset + 1)));
      return true;
    }
    const ident = /^(?:async\s+|get\s+|set\s+|\*\s*)?([\w$]+)/.exec(seg);
    if (ident) keys.push(ident[1]);
    return true;
  };
  for (let i = open + 1; i <= close; i += 1) {
    const ch = masked[i];
    if (i === close || (ch === ',' && depth === 0)) {
      if (!flush(i)) return null;
      segStart = i + 1;
    } else if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
  }
  return keys;
}

const FACTORY_RE = /\bvi\.mock\(\s*(['"])([^'"]+)\1\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\(\s*\{/g;

const exportCache = new Map();

/** `file:line — spec mocks <key>` for each key the real module does not export. */
export function mockDrift(testFile, rawSource, { root, allowed = new Map() }) {
  const masked = mask(rawSource);
  const rel = relative(root, testFile).split(sep).join('/');
  const violations = [];
  // The specifier is a string, so it is blanked in `masked`; match on raw and
  // require the call itself to be live code (not inside a comment).
  for (const m of rawSource.matchAll(FACTORY_RE)) {
    if (masked[m.index] !== 'v') continue;
    const target = resolveModule(testFile, m[2]);
    if (!target) continue;
    const open = m.index + m[0].length - 1;
    const keys = literalKeys(rawSource, masked, open);
    if (!keys) continue;
    if (!exportCache.has(target)) exportCache.set(target, exportNames(target));
    const exported = exportCache.get(target);
    for (const key of keys) {
      if (key === '__esModule' || exported.has(key) || allowed.has(`${rel}|${m[2]}|${key}`)) continue;
      const line = rawSource.slice(0, m.index).split('\n').length;
      violations.push(`${rel}:${line} — ${m[2]} mocks ${key}`);
    }
  }
  return violations;
}
