// @vitest-environment node

/**
 * Repo-wide guard: `lib/safeStorage.js` is the only place that touches Web Storage.
 *
 * `localStorage`/`sessionStorage` are not ordinary objects. They throw — not
 * return null — in Safari private browsing, with cookies disabled, in a
 * sandboxed iframe, and at quota; and in some of those the object still EXISTS,
 * so a `typeof sessionStorage === 'undefined'` half-guard passes and the very
 * next `setItem` throws anyway. `lib/safeStorage.js` exists to make every access
 * best-effort, and its header already said "use these instead of touching
 * `localStorage` inline". Three modules still did, and each one turned a lost
 * preference into something worse (#5689):
 *
 *   - `MusicDesigner.jsx` read storage in the COMPONENT RENDER BODY, so a throw
 *     was a render-phase exception that unmounted the whole Music Designer route.
 *   - `staleChunkReload.js` read/wrote its anti-loop flag unguarded inside the
 *     stale-bundle recovery path — a storage failure broke the mechanism whose
 *     entire job is recovering a user from a broken page.
 *   - `usePostSession.js` carried the `typeof`-only half-guard on a write that
 *     runs on every drill-state change, so a POST training run died mid-session.
 *
 * The rule is therefore structural rather than per-site: any raw member access
 * fails this suite, and the fix is always the corresponding `safe*` helper.
 *
 * ## Allowlist
 *
 * - `src/lib/safeStorage.js` — it IS the guarded wrapper.
 * - `src/test/**` — the storage polyfill and test helpers deliberately install
 *   and probe raw Storage objects; a guard must not trip over its own harness.
 * - `src/utils/timeWindow.js` — enumerates keys via `.length` / `.key(i)` to
 *   prune stale per-day entries. `safeStorage` deliberately exposes no
 *   enumeration API (it would have to invent an iteration contract for a
 *   single caller), so this file keeps its own try/catch — which it already has
 *   on every access. Move it off the allowlist the day a second caller needs
 *   enumeration and the helper is worth adding.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass. Comments are stripped (both forms, with
 * a `:` lookbehind so a `https://` URL is not read as a line comment) because
 * prose like "persisted to localStorage." otherwise reads as a member access
 * spanning the newline; string literals are NOT stripped, so a storage call
 * spelled inside a string would be flagged, and a real call sharing a line with
 * a `//` inside a string would be missed. Aliasing (`const s = localStorage`),
 * a computed base (`globalThis['localStorage']`), or a call funneled through a
 * helper in another file all slip through. Those are unusual enough here that
 * the grep earns its keep; closing them means moving to an AST pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WRAPPER_FILE = 'src/lib/safeStorage.js';
const ALLOWED = [
  WRAPPER_FILE,
  'src/utils/timeWindow.js',
];
const ALLOWED_PREFIXES = ['src/test/'];

const isAllowed = (file) =>
  ALLOWED.includes(file) || ALLOWED_PREFIXES.some((p) => file.startsWith(p));

/**
 * Block and line comments removed. Without this, a docblock sentence ending in
 * "localStorage." followed by a line starting with a letter matches the member
 * pattern and reports a file that never touches storage at all. The `[^:]`
 * before `//` keeps `https://…` inside a comment or string from eating the rest
 * of the line.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

/**
 * `localStorage.foo`, `window.sessionStorage.foo`, `globalThis.localStorage[…]`.
 * A member name (or a bracket) is required so prose and bare identifiers are not
 * matches; the lookbehind keeps an unrelated identifier ending in `…Storage`
 * from counting. Optional chaining counts as an access: `?.` only guards a
 * null/undefined base, not a `getItem` that throws — which is the whole failure
 * mode here — so `sessionStorage?.setItem(…)` is exactly as unsafe as the plain
 * form and must not read as already-guarded.
 */
const RAW_STORAGE = /(?<![\w$])(?:(?:window|globalThis|self)\s*\??\.\s*)?(?:local|session)Storage\s*\??(?:\.\s*[A-Za-z_$]|\[)/g;

/** Raw Web Storage accesses in `src`, as matched snippets. */
export function findRawStorageAccess(src) {
  return [...stripComments(src).matchAll(RAW_STORAGE)].map((m) => m[0].trim());
}

describe('Web Storage access goes through lib/safeStorage', () => {
  it('has no raw localStorage/sessionStorage access outside the wrapper', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
      if (isAllowed(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      for (const hit of findRawStorageAccess(src)) violations.push(`${file}: ${hit}`);
    }

    expect(
      violations,
      'These files touch `localStorage`/`sessionStorage` directly. Storage throws '
      + '(Safari private mode, blocked storage, disabled cookies, quota) — in a render '
      + 'body that unmounts the route, and in an effect it kills the flow mid-session.\n'
      + 'Fix: use `safeReadStorage` / `safeReadJsonStorage` / `safeWriteStorage` / '
      + '`safeWriteJsonStorage` / `safeRemoveStorage`, or the session variants '
      + '`safeReadSession` / `safeWriteSession` / `safeReadJsonSession` / '
      + '`safeWriteJsonSession` / `safeRemoveSession`, from `client/src/lib/safeStorage.js`.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: if the detector stops recognizing a raw access, the scan
  // above goes vacuously green and the bug class walks straight back in.
  it('flags every raw spelling and accepts the safe helpers', () => {
    expect(findRawStorageAccess("localStorage.getItem('x')")).toEqual(['localStorage.g']);
    expect(findRawStorageAccess("window.localStorage.setItem('x', '1')")).toEqual(['window.localStorage.s']);
    expect(findRawStorageAccess('globalThis.sessionStorage?.removeItem(k)')).toEqual(['globalThis.sessionStorage?.r']);
    expect(findRawStorageAccess("sessionStorage['x']")).toEqual(['sessionStorage[']);
    expect(findRawStorageAccess('for (let i = 0; i < localStorage.length; i += 1) {}')).toEqual(['localStorage.l']);

    expect(findRawStorageAccess("safeReadStorage('x')")).toEqual([]);
    expect(findRawStorageAccess("safeWriteJsonSession('x', v)")).toEqual([]);
    // A `typeof` presence check alone is the half-guard #5689 was about, but it
    // is not itself an access — only the member call that follows is.
    expect(findRawStorageAccess("if (typeof sessionStorage === 'undefined') return;")).toEqual([]);
  });

  it('does not flag prose that merely names the API', () => {
    // The exact shapes present in the tree when this guard was written: a
    // sentence-final "localStorage." whose next line starts with a letter.
    expect(findRawStorageAccess(
      '// nothing in this module reads or writes localStorage.\nconst TIERS = {};',
    )).toEqual([]);
    expect(findRawStorageAccess(
      ' * Sidebar working-set state, persisted to localStorage.\n */\nexport const x = 1;',
    )).toEqual([]);
    // A URL inside a comment must not swallow the rest of the file and hide a
    // real access on a later line.
    expect(findRawStorageAccess(
      "// see https://example.com/storage\nlocalStorage.getItem('x');",
    )).toEqual(['localStorage.g']);
  });

  // The allowlist must keep naming files that really exist and really carry the
  // shape — otherwise a rename turns an exemption into silent dead config.
  it('allowlists only files that exist and still touch storage directly', () => {
    const tracked = trackedSourceFiles(CLIENT_ROOT);
    for (const file of ALLOWED) {
      expect(tracked, `${file} is allowlisted but no longer tracked`).toContain(file);
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      expect(
        findRawStorageAccess(src).length,
        `${file} no longer touches storage directly — drop it from the allowlist`,
      ).toBeGreaterThan(0);
    }
  });
});
