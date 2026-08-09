/**
 * Repo-wide guard: no test may address the checkout's real `data/` tree.
 *
 * ## The bug class
 *
 * A suite that resolves a path into `<repo>/data/` runs against the developer's
 * live install. It reads their records (so the fixture set silently gains rows
 * the assertions never accounted for) and, if it writes, drops test artifacts
 * into their data. The failure is invisible in CI by construction — a fresh
 * checkout has no `data/` — so it only ever surfaces on a populated machine,
 * where it reads as a spurious regression on whatever branch is checked out.
 *
 * Two suites have shipped this: #3683 (`unlockPass.test.js`, via a fileUtils
 * partial mock that left `PATHS` alone) and #3687 (`missions.test.js`, via
 * `join(process.cwd(), 'data', …)` with no mock at all).
 *
 * ## Why this rule and not "every fileUtils partial mock must redirect PATHS"
 *
 * #3687 audited the whole server suite empirically — two full runs, the second
 * with probe records planted in every `data/` subdirectory a service enumerates
 * — and found exactly ONE leaker in 1301 test files. The 67 suites that
 * partial-mock `fileUtils.js` without a `PATHS` redirect are overwhelmingly safe
 * (they replace the service graph wholesale, so nothing ever reaches a real
 * `readdir`), and a guard over that shape would need a 66-entry allowlist to
 * flag one file. So the rule keys on the thing that is *never* legitimate in a
 * test — naming the checkout's own `data/` directory — which needs no allowlist
 * at all.
 *
 * A test that genuinely needs a data root uses `createTempDataRoot()` +
 * `makePathsProxy()` from `lib/mockPathsDataRoot.js`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// This file quotes the forbidden spellings in its own pattern assertions below,
// so it must exempt itself or it reports itself as the sole offender.
const SELF = 'server/lib/testDataIsolation.guards.test.js';

// Matches an install-root anchor (`process.cwd()`, `PATHS.root`,
// `PATHS.installRoot`) joined to a `data` segment — as a `join()` argument
// (`, 'data'`) or inside a template literal (`}/data`). Deliberately does NOT
// match `'test-data'` or any other name that merely ends in `data`.
const REAL_DATA_ROOT_RE =
  /(process\.cwd\(\)|PATHS\.(?:root|installRoot))(?:[^\n;]*?,\s*['"]data['"]|\}?\/data['"/`])/;

// Scope to the test files the server runner globs (`server/vitest.config.js`).
// Client tests run in jsdom and have no filesystem to leak into.
const scopedTests = () => execFileSync('git', ['ls-files', '*.test.js'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => /^(server|scripts|lib|autofixer)\//.test(p))
  .filter((p) => !p.startsWith('lib/slashdo/') && p !== SELF);

describe('test-data isolation guard', () => {
  it('finds test files to scan', () => {
    // Fails loudly if the glob or the path filter ever stops matching, rather
    // than reporting a vacuous pass over zero files.
    expect(scopedTests().length).toBeGreaterThan(100);
  });

  it('no test resolves a path into the checkout\'s real data/ directory', () => {
    const offenders = scopedTests().filter((rel) =>
      REAL_DATA_ROOT_RE.test(readFileSync(join(REPO_ROOT, rel), 'utf8'))
    );
    expect(offenders, [
      'These tests address the checkout\'s own data/ directory, so they read (and may',
      'overwrite) the developer\'s live records. Allocate a temp root instead:',
      '',
      "  const tempRoot = createTempDataRoot('portos-<suite>-');",
      "  vi.mock('../lib/fileUtils.js', async (importOriginal) =>",
      '    makePathsProxy(await importOriginal(), { dataRoot: tempRoot }));',
      '',
      'See lib/mockPathsDataRoot.js and services/missions.test.js (#3687).',
    ].join('\n')).toEqual([]);
  });

  it('the pattern matches the shapes that shipped, and spares look-alikes', () => {
    // #3687's actual line, plus the PATHS-anchored and template-literal spellings.
    expect(REAL_DATA_ROOT_RE.test("path.join(process.cwd(), 'data', 'cos', 'missions')")).toBe(true);
    expect(REAL_DATA_ROOT_RE.test("join(PATHS.installRoot, 'data', 'runs')")).toBe(true);
    expect(REAL_DATA_ROOT_RE.test('`${process.cwd()}/data/cos`')).toBe(true);
    // Look-alikes that must stay legal.
    expect(REAL_DATA_ROOT_RE.test("join(process.cwd(), 'test-data')")).toBe(false);
    expect(REAL_DATA_ROOT_RE.test('workspacePath: process.cwd()')).toBe(false);
    expect(REAL_DATA_ROOT_RE.test("join(tempRoot, 'data', 'cos')")).toBe(false);
  });
});
