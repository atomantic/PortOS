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
 * ## What this rule covers, and what covers the rest
 *
 * The rule matches the two spellings that name the checkout's `data/` directory
 * *textually*: an install-root anchor (`process.cwd()`, `PATHS.root`,
 * `PATHS.installRoot`) or a parent-directory climb (`'..'`), joined to a `data`
 * segment. Both are illegitimate in a test with no exceptions to carve out, so
 * the rule needs no allowlist beyond the one deliberate case documented below.
 *
 * It does NOT cover the third spelling — importing the real `PATHS` and reading
 * a data-rooted member (`PATHS.missions`, `PATHS.brain`, …) with no redirect.
 * 50 of the ~1300 scoped test files do that, nearly all of them safely, because
 * they replace the service graph wholesale and never reach a real `readdir`; a
 * static rule there would be a 50-entry allowlist. That spelling is covered
 * **empirically** instead, by the two-run probe #3687 introduced:
 *
 *   1. Run the server suite on a checkout with an empty `data/`; record failures.
 *   2. Plant probe records in every `data/` subdirectory a service enumerates —
 *      every `PATHS.*` member under `data/`, every `createCollectionStore` root,
 *      and every directory `data.reference/` seeds. Use prefix-aware ids
 *      (`iss-`/`ser-`/`stb-`/`game-`/UUID): several stores pass a prefixed
 *      `idPattern` and silently ignore a probe dir that doesn't match it.
 *   3. Re-run. Any file that fails only in run 2 is leaking.
 *
 * That audit found 2 leakers across 1301 files — `missions.test.js` (fixed in
 * #3687) and nothing the static rule below doesn't already catch. Re-run it when
 * touching this area; it is the ground truth, and this rule is the cheap
 * always-on approximation of it.
 *
 * A test that genuinely needs a data root uses `createTempDataRoot()` +
 * `makePathsProxy()` from `lib/mockPathsDataRoot.js`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Derived, not hardcoded: this file quotes the forbidden spellings in its own
// pattern assertions below, so a stale literal would let it report itself as the
// sole offender after a rename.
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url));

// Deliberate exemption. `creativeDirectorPrompts.test.js` reads the INSTALLED
// stage prompt in preference to the committed `data.reference/` seed on purpose:
// the point is to catch drift between a locally-edited prompt and the code that
// renders it. It falls back to the seed when `data/` is absent, so CI is stable,
// and it only ever reads — it writes nothing into the user's data.
const ALLOWED = new Set(['server/lib/creativeDirectorPrompts.test.js']);

// An install-root anchor or a parent climb, joined to a `data` path segment.
// The trailing lookahead spares `data.reference` / `data-foo` / `dataDir`, and
// the leading quote-or-slash class spares `'test-data'`.
const REAL_DATA_ROOT_RE =
  /(?:process\.cwd\(\)|PATHS\.(?:root|installRoot)|['"]\.\.['"])[^\n;]*?['"`/]data(?![\w.-])/;

// Scope to the test files the server runner globs (`server/vitest.config.js`).
// Client tests run in jsdom and have no filesystem to leak into. Computed once —
// the inputs are immutable for the run.
const SCOPED_TESTS = execFileSync('git', ['ls-files', '*.test.js'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => /^(server|scripts|lib|autofixer)\//.test(p))
  .filter((p) => !p.startsWith('lib/slashdo/') && p !== SELF && !ALLOWED.has(p));

const scan = (source) => REAL_DATA_ROOT_RE.test(source);

describe('test-data isolation guard', () => {
  it('finds test files to scan', () => {
    // Fails loudly if the glob or the path filter ever stops matching, rather
    // than reporting a vacuous pass over zero files.
    expect(SCOPED_TESTS.length).toBeGreaterThan(100);
  });

  it('no test resolves a path into the checkout\'s real data/ directory', () => {
    const offenders = SCOPED_TESTS.filter((rel) => scan(readFileSync(join(REPO_ROOT, rel), 'utf8')));
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

  it('would have caught both spellings that shipped', () => {
    // A bypass probe, not a pattern unit test: these are the exact lines the two
    // known instances carried, so a rule that stops matching them fails here
    // instead of silently passing over a re-introduced leak.
    expect(scan("const DATA_DIR = path.join(process.cwd(), 'data', 'cos', 'missions');")).toBe(true);
    expect(scan("const D = join(__HERE, '..', '..', 'data', 'prompts', 'stages');")).toBe(true);
    expect(scan("join(PATHS.installRoot, 'data', 'runs')")).toBe(true);
    expect(scan('`${process.cwd()}/data/cos`')).toBe(true);
  });

  it('spares the look-alikes that must stay legal', () => {
    expect(scan("join(process.cwd(), 'test-data')")).toBe(false);
    expect(scan('workspacePath: process.cwd()')).toBe(false);
    expect(scan("join(tempRoot, 'data', 'cos')")).toBe(false);
    expect(scan("join(__HERE, '..', '..', 'data.reference', 'prompts')")).toBe(false);
    expect(scan("import { PATHS } from '../lib/fileUtils.js'")).toBe(false);
  });
});
