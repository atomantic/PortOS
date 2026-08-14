/**
 * Covers `pinPlatform` and the repo-wide rule that no test hand-rolls the pin
 * it replaces (#4085). Twelve suites each re-implemented
 * `getOwnPropertyDescriptor` → `defineProperty` → restore, so the one hazard
 * that matters — never pin above an import that loads a native addon, which
 * picks its prebuilt binary off `process.platform` at load time — had to be
 * rediscovered at every site. It now lives on the helper's doc comment, and
 * the guard below keeps new sites from routing around it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { pinPlatform } from './testHelper.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Derived, not hardcoded: this file quotes the forbidden spelling in its own
// pattern below, so a stale literal would let it report itself as an offender
// after a rename. `git ls-files` prints POSIX separators; `relative()` yields
// backslashes on Windows, so normalize before comparing.
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');
const HELPER = 'server/lib/testHelper.js';

describe('pinPlatform', () => {
  let restore = () => {};
  afterEach(() => restore());

  it('reports the pinned platform and restores the original descriptor', () => {
    const before = Object.getOwnPropertyDescriptor(process, 'platform');
    restore = pinPlatform('win32');
    expect(process.platform).toBe('win32');

    restore();
    restore = () => {};
    // The ORIGINAL descriptor, not a data-property snapshot of its value: a
    // restore that writes `{ value: <read>, configurable: true }` leaves the
    // accessor Node installed permanently replaced for the rest of the worker.
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(before);
  });

  it('deletes the pin when there was no own descriptor to restore', () => {
    // Node always gives `process` an own `platform`, so stage the case the
    // helper has to survive rather than assume it can't happen.
    const saved = Object.getOwnPropertyDescriptor(process, 'platform');
    delete process.platform;
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toBeUndefined();

    const undo = pinPlatform('freebsd');
    expect(process.platform).toBe('freebsd');
    undo();

    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toBeUndefined();
    Object.defineProperty(process, 'platform', saved);
  });

  it('unwinds nested pins in reverse order', () => {
    const before = process.platform;
    const undoOuter = pinPlatform('linux');
    const undoInner = pinPlatform('darwin');
    expect(process.platform).toBe('darwin');

    undoInner();
    expect(process.platform).toBe('linux');
    undoOuter();
    expect(process.platform).toBe(before);
  });

  it('is idempotent, so an afterEach can call it after an inline restore', () => {
    const before = process.platform;
    const undo = pinPlatform('aix');
    undo();
    undo();
    expect(process.platform).toBe(before);
  });
});

describe('platform-pin guard', () => {
  // Scope to what the server runner globs (`server/vitest.config.js`); client
  // tests run in jsdom, where `process.platform` isn't a branch worth pinning.
  const SCOPED_TESTS = execFileSync('git', ['ls-files', '*.test.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => /^(server|scripts|lib|autofixer)\//.test(p))
    .filter((p) => !p.startsWith('lib/slashdo/') && p !== SELF);

  const HAND_ROLLED_PIN = /defineProperty\s*\(\s*process\s*,\s*['"`]platform['"`]/;

  it('finds test files to scan', () => {
    // Fails loudly if the glob or the path filter stops matching, rather than
    // reporting a vacuous pass over zero files.
    expect(SCOPED_TESTS.length).toBeGreaterThan(100);
  });

  it('detects the spelling it forbids', () => {
    // Bypass probe: proves the pattern bites, so the empty-offenders assertion
    // below can't pass because the regex quietly stopped matching anything.
    expect(HAND_ROLLED_PIN.test(
      "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });"
    )).toBe(true);
    expect(HAND_ROLLED_PIN.test("restore = pinPlatform('win32');")).toBe(false);
  });

  it('no test hand-rolls a process.platform pin', () => {
    const offenders = SCOPED_TESTS.filter(
      (rel) => HAND_ROLLED_PIN.test(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    );
    expect(offenders, [
      'These tests pin process.platform by hand. Use the shared helper instead:',
      '',
      "  import { pinPlatform } from '<path>/lib/testHelper.js';",
      "  const restore = pinPlatform('win32');   // inline: call restore() in finally",
      "  beforeEach(() => { restore = pinPlatform('win32'); });  // block-scoped",
      '',
      'It restores the ORIGINAL descriptor and documents the native-addon hazard',
      `that a hand-rolled pin has to rediscover every time. See ${HELPER} (#4085).`,
    ].join('\n')).toEqual([]);
  });

  it('the helper still owns the only pin, and still documents the hazard', () => {
    // Both halves of the consolidation: the mechanism lives here, and the
    // warning that motivated centralizing it stays attached to it.
    const source = readFileSync(join(REPO_ROOT, HELPER), 'utf8');
    expect(HAND_ROLLED_PIN.test(source)).toBe(true);
    expect(source).toMatch(/native addon/);
  });
});
