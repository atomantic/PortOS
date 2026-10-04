// @vitest-environment node

/**
 * Repo-wide guard: a call site that passes `{ silent: true }` to an API wrapper
 * must be passing it somewhere the wrapper actually forwards (#9951).
 *
 * `request(endpoint, options)` in `services/apiCore.js` reads `silent` out of its
 * second argument to suppress the error toast. A wrapper such as
 *
 *   export const getThing = (id) => request(`/things/${id}`);
 *
 * has no parameter for it, so `getThing(id, { silent: true })` type-checks, runs,
 * and silently toasts anyway — and `export const saveThing = (id, data) => …`
 * receives the options object AS THE PAYLOAD. Three call sites shipped that way.
 *
 * ## The rule
 *
 * For every call `wrapper(…, { …silent… }, …)` to an export of
 * `client/src/services/api*.js`, the wrapper's parameter at that argument
 * position must be one of:
 *
 *   - named `options` / `opts` (or any name the wrapper passes straight through
 *     or spreads, `...name`),
 *   - a rest parameter (`...args`), or
 *   - a destructuring pattern that names `silent` or collects `...rest`.
 *
 * A wrapper with no parameter at that position fails.
 *
 * ## What this guard CANNOT see
 *
 * It is a lexer-assisted source scan, not a type check. It judges only a LITERAL
 * object argument (an options object built in a variable, or spread
 * `{ ...opts }`, is invisible), resolves a callee by its exported NAME (judged
 * only in a file that imports it, or via `api.name`; a same-named local binding
 * in an importing file is treated as the wrapper), and reads a
 * wrapper's forwarding from its source text up to the next `export`. A wrapper
 * that is itself a re-export alias (`export const a = b`) is not judged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { blankCommentBodies, blankLiterals, matchBracket } from '../../server/lib/sourceScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_FILE = /^src\/services\/api[^/]*\.js$/;
const OPTIONS_NAMES = new Set(['options', 'opts']);

/** Split `text[start, end)` on top-level commas, using the blanked copy to find them. */
function splitTopLevel(blanked, text, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = blanked[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = text.slice(from, end).trim();
  if (last) parts.push(last);
  return parts;
}

const WRAPPER_HEAD = /^[ \t]*export\s+(?:(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\()/gm;

/** Exported function wrappers in one service file: `[{ name, params, text }]`. */
export function wrapperExports(src) {
  const code = blankCommentBodies(src);
  const blanked = blankLiterals(src);
  const heads = [...blanked.matchAll(WRAPPER_HEAD)];
  const allExports = [...blanked.matchAll(/^[ \t]*export\s/gm)].map((m) => m.index);
  return heads.map((head) => {
    const open = head.index + head[0].length - 1;
    const close = matchBracket(blanked, open);
    if (close === -1) return null;
    const next = allExports.find((index) => index > head.index) ?? src.length;
    return {
      name: head[1] || head[2],
      params: splitTopLevel(blanked, code, open + 1, close - 1),
      text: code.slice(close, next),
    };
  }).filter(Boolean);
}

/** The parameter text with its top-level `= default` dropped (a destructured default stays inside the pattern). */
const stripDefault = (param) => {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const c = param[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '=' && depth === 0 && param[i + 1] !== '=' && param[i + 1] !== '>') return param.slice(0, i).trim();
  }
  return param.trim();
};

/** Does `wrapper` forward the argument it receives at `index` to `request`'s options? */
export function forwardsOptionsAt(wrapper, index) {
  if (wrapper.params.some((param) => param.startsWith('...')) && wrapper.params.findIndex((p) => p.startsWith('...')) <= index) return true;
  if (index >= wrapper.params.length) return false;
  const param = stripDefault(wrapper.params[index]);
  if (param.startsWith('{')) return /\bsilent\b|\.\.\./.test(param);
  if (OPTIONS_NAMES.has(param)) return true;
  if (!/^[A-Za-z_$][\w$]*$/.test(param)) return false;
  const escaped = param.replace(/\$/g, '\\$');
  return new RegExp(`\\.\\.\\.${escaped}\\b|\\b${escaped}\\??\\.silent\\b|,\\s*${escaped}\\s*\\)`).test(wrapper.text);
}

const SILENT_KEY = /[{,]\s*silent\s*(?::|,|\})/;

/**
 * `{ line, name, index }` for every call of one of `names` that passes a literal
 * object containing a `silent` key, with `index` the argument position. A bare
 * `name(…)` counts only in a file that imports `name` (a hook handed the callback
 * as a parameter owns its own contract); `api.name(…)` always counts.
 */
export function silentCalls(src, names) {
  if (!src.includes('silent')) return [];
  const code = blankCommentBodies(src);
  const blanked = blankLiterals(src);
  const imported = new Set([...code.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
    .flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop())));
  const hits = [];
  for (const match of blanked.matchAll(/(?<![\w$.])(api\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, namespace, name] = match;
    if (!names.has(name) || (!namespace && !imported.has(name))) continue;
    const open = match.index + match[0].length - 1;
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    splitTopLevel(blanked, code, open + 1, close - 1).forEach((arg, index) => {
      if (arg.startsWith('{') && SILENT_KEY.test(arg)) {
        hits.push({ line: src.slice(0, match.index).split('\n').length, name, index });
      }
    });
  }
  return hits;
}

/** Every `file: name(arg N)` where the wrapper at that position drops the options object. */
export function findDroppedSilent(files, wrappers) {
  const violations = [];
  const byName = new Map();
  for (const wrapper of wrappers) {
    if (!byName.has(wrapper.name)) byName.set(wrapper.name, []);
    byName.get(wrapper.name).push(wrapper);
  }
  const names = new Set(byName.keys());
  for (const { file, src } of files) {
    for (const { line, name, index } of silentCalls(src, names)) {
      if (byName.get(name).some((wrapper) => !forwardsOptionsAt(wrapper, index))) {
        violations.push(`${file}:${line} ${name}(…) passes { silent } as argument ${index + 1}`);
      }
    }
  }
  return violations;
}

const read = (file) => ({ file, src: readFileSync(join(CLIENT_ROOT, file), 'utf8') });

describe('silent options reach the API wrapper that reads them (#9951)', () => {
  it('has no { silent } passed to a position the wrapper drops', () => {
    const tracked = trackedSourceFiles(CLIENT_ROOT);
    expect(tracked.length).toBeGreaterThan(100);
    const wrappers = tracked.filter((file) => SERVICE_FILE.test(file)).flatMap((file) => wrapperExports(read(file).src));
    // A broken parse would otherwise pass by judging nothing.
    expect(wrappers.length).toBeGreaterThan(500);

    const violations = findDroppedSilent(tracked.map(read), wrappers);
    expect(
      violations,
      'These calls pass `{ silent: … }` to an API wrapper whose parameter at that position does not '
      + 'forward it to `request()` — the toast still fires, or the object lands in the request body. Give the '
      + 'wrapper an `options` parameter and spread it into `request(…, { …, ...options })`.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: if the recognizer stops reading wrappers or call sites, the
  // scan above goes vacuously green and the dropped-option class walks back in.
  it('reads wrapper parameters and silent call sites', () => {
    const wrappers = wrapperExports(`
      export const noOptions = (id) => request(\`/x/\${id}\`);
      export const named = (id, options) => request(\`/x/\${id}\`, options);
      export const optsDefault = (id, opts = {}) => request(\`/x/\${id}\`, opts);
      export const spreads = (id, data, extra) => request('/x', { method: 'PUT', body: JSON.stringify(data), ...extra });
      export const destructured = (id, { silent, limit } = {}) => request('/x', { silent });
      export const payloadOnly = (id, data) => request('/x', { method: 'POST', body: JSON.stringify(data) });
      export async function restArgs(...args) { return request('/x', args[0]); }
      export const passThrough = (id, o) => request('/x', o);
    `);
    const byName = Object.fromEntries(wrappers.map((w) => [w.name, w]));
    expect(wrappers).toHaveLength(8);
    expect(forwardsOptionsAt(byName.noOptions, 1)).toBe(false);
    expect(forwardsOptionsAt(byName.named, 1)).toBe(true);
    expect(forwardsOptionsAt(byName.optsDefault, 1)).toBe(true);
    expect(forwardsOptionsAt(byName.spreads, 2)).toBe(true);
    expect(forwardsOptionsAt(byName.spreads, 1)).toBe(false);
    expect(forwardsOptionsAt(byName.destructured, 1)).toBe(true);
    expect(forwardsOptionsAt(byName.payloadOnly, 1)).toBe(false);
    expect(forwardsOptionsAt(byName.restArgs, 1)).toBe(true);
    expect(forwardsOptionsAt(byName.passThrough, 1)).toBe(true);

    const names = new Set(['noOptions', 'named']);
    const imp = "import { noOptions, named } from './services/api';\n";
    expect(silentCalls(`${imp}noOptions(id, { silent: true });`, names)).toEqual([{ line: 2, name: 'noOptions', index: 1 }]);
    expect(silentCalls('api.noOptions(id, { retries: 1, silent });', names)).toHaveLength(1);
    expect(silentCalls(`${imp}named(id, { silent: true });`, names)).toHaveLength(1);
    // A callback handed in as a parameter (not imported) is the caller's contract.
    expect(silentCalls('function f({ noOptions }) { noOptions(id, { silent: true }); }', names)).toEqual([]);
    // A different callee, a method call, and a comment are not wrapper calls.
    expect(silentCalls('other(id, { silent: true });', names)).toEqual([]);
    expect(silentCalls(`${imp}thing.named(id, { silent: true });`, names)).toEqual([]);
    expect(silentCalls(`${imp}// noOptions(id, { silent: true })`, names)).toEqual([]);
  });

  it('flags a call whose position the wrapper drops and accepts a forwarding one', () => {
    const wrappers = wrapperExports(`
      export const noOptions = (id) => request(\`/x/\${id}\`);
      export const named = (id, options) => request(\`/x/\${id}\`, options);
    `);
    const files = [
      { file: 'a.jsx', src: "import { noOptions, named } from './services/api';\nnoOptions(1, { silent: true });\nnamed(1, { silent: true });" },
    ];
    expect(findDroppedSilent(files, wrappers)).toEqual(['a.jsx:2 noOptions(…) passes { silent } as argument 2']);
  });
});
