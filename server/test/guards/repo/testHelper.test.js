/**
 * Covers `pinPlatform` and the repo-wide rule that no test hand-rolls the pin
 * it replaces (#4085). Twelve suites each re-implemented
 * `getOwnPropertyDescriptor` → `defineProperty` → restore, so the one hazard
 * that matters — never pin above an import that loads a native addon, which
 * picks its prebuilt binary off `process.platform` at load time — had to be
 * rediscovered at every site. It now lives on the helper's doc comment, and
 * the guard below keeps new sites from routing around it.
 */

import { describe, it, expect } from 'vitest';
import { join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

// Derived, not hardcoded: this file quotes the forbidden spelling in its own
// pattern below, so a stale literal would let it report itself as an offender
// after a rename. `git ls-files` prints POSIX separators; `relative()` yields
// backslashes on Windows, so normalize before comparing.
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');
const HELPER = 'server/lib/testHelper.js';
// The helper's own suite replaces and restores the descriptor to prove pinPlatform does.
const HELPER_SUITE = 'server/lib/testHelper.test.js';

describe('platform-pin guard', () => {
  // Scope to what the server runner globs (`server/vitest.config.js`); client
  // tests run in jsdom, where `process.platform` isn't a branch worth pinning.
  const SCOPED_TESTS = trackedFiles(REPO_ROOT, ['*.test.js'])
    .filter((p) => /^(server|scripts|lib|autofixer)\//.test(p))
    .filter((p) => !p.startsWith('lib/slashdo/') && p !== SELF && p !== HELPER_SUITE);

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
      (rel) => HAND_ROLLED_PIN.test(readText(join(REPO_ROOT, rel)))
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
    //
    // Matched with `OWNS_A_PIN`, not `HAND_ROLLED_PIN`: the helper now shares one
    // descriptor-swap body between `pinPlatform` and `pinArch`, so the property
    // name is a parameter rather than a literal. `HAND_ROLLED_PIN` stays keyed to
    // the literal spelling because that is what it must catch in OTHER files —
    // this assertion only has to prove the mechanism still lives here.
    const OWNS_A_PIN = /defineProperty\s*\(\s*process\s*,/;
    const source = readText(join(REPO_ROOT, HELPER));
    expect(OWNS_A_PIN.test(source)).toBe(true);
    expect(source).toMatch(/native addon/);
  });
});
