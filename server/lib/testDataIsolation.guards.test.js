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
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Derived, not hardcoded: this file quotes the forbidden spellings in its own
// pattern assertions below, so a stale literal would let it report itself as the
// sole offender after a rename.
// `git ls-files` always prints POSIX separators; `relative()` yields backslashes
// on Windows, so without the normalize the exemption misses and the guard fails
// there reporting itself as the sole offender.
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');

// Deliberate exemptions. Both READ the live install on purpose and write nothing
// into it, so neither can corrupt the user's data — the reason the rule exists.
//   - creativeDirectorPrompts.test.js reads the INSTALLED stage prompt in
//     preference to the committed `data.reference/` seed, to catch drift between
//     a locally-edited prompt and the code that renders it. Falls back to the
//     seed when `data/` is absent, so CI is stable.
//   - visionTest.integration.test.js is an opt-in integration test whose stated
//     premise is the live install: it enumerates the user's own screenshots to
//     feed a real vision model, and skips itself when the directory is absent.
// A future false positive belongs here too — with a sentence saying why it's safe.
const ALLOWED = new Set([
  'server/lib/creativeDirectorPrompts.test.js',
  'server/services/visionTest.integration.test.js',
]);

// Two shapes, because they need different bounds:
//   1. An install-root anchor (`process.cwd()`, `PATHS.root`/`installRoot`) or a
//      standalone `'..'` join argument, followed on the SAME LINE by a `data`
//      path segment. The line bound matters: allowing newlines here matches the
//      60 suites that mock `PATHS: { data: '/mock/data' }` across a few lines,
//      where the `..` is only the module specifier of the `vi.mock` call. The
//      cost is that a `join()` split across lines slips through — the empirical
//      probe below is the backstop for that.
//   2. A CONTIGUOUS climb inside one string (`'../data'`, `'../../data/x'`,
//      `'.././data'`). Contiguity is what makes this one safe to match without a
//      window: it can't span two unrelated string literals the way shape 1 could.
//      Relaxing it to "any quoted string that starts with a climb" would catch
//      `join(__dirname, '../foo', 'data')` too, but measurably re-introduces the
//      false positive shape 1 avoids — `creativeDirector/sceneEvaluator.test.js`
//      mocks `PATHS: { videoThumbnails: '/data/video-thumbnails' }` on the same
//      line as its `'../../lib/fileUtils.js'` specifier. One unreached spelling
//      is a better trade than one standing false positive.
// The trailing lookahead spares `data.reference` / `data-foo` / `dataDir`; the
// leading quote-or-separator class spares `'test-data'`; both accept backticks
// and Windows backslashes. `\??\.` tolerates optional chaining on the anchors.
const REAL_DATA_ROOT_RE = new RegExp([
  '(?:',
  '(?:process\\??\\.cwd\\s*(?:\\?\\.)?\\(\\)|PATHS\\??\\.(?:root|installRoot)|[\'"`]\\.\\.[/\\\\]?[\'"`])',
  '[^\\n;]{0,160}?[\'"`/\\\\]data(?![\\w.-])',
  '|',
  '\\.\\.(?:[/\\\\]\\.{1,2})*[/\\\\]data(?![\\w.-])',
  ')',
].join(''));

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

  it('would have caught every spelling found in this repo', () => {
    // A bypass probe, not a pattern unit test: these are the exact lines the
    // three known instances carried, so a rule that stops matching them fails
    // here instead of silently passing over a re-introduced leak.
    expect(scan("const DATA_DIR = path.join(process.cwd(), 'data', 'cos', 'missions');")).toBe(true);
    expect(scan("const D = join(__HERE, '..', '..', 'data', 'prompts', 'stages');")).toBe(true);
    expect(scan("const S = resolve(__dirname, '../../data/screenshots');")).toBe(true);
    // Spellings not yet seen here, but a rename away from the ones above.
    expect(scan("join(PATHS.installRoot, 'data', 'runs')")).toBe(true);
    expect(scan('`${process.cwd()}/data/cos`')).toBe(true);
    expect(scan("join(__dirname, '../data/cos/missions')")).toBe(true);
    expect(scan("path.join(process.cwd(), '\\\\data\\\\cos')")).toBe(true);
    expect(scan('path.join(process.cwd(), `data`)')).toBe(true);
    expect(scan("path.join(__dirname, '../', 'data')")).toBe(true);
    expect(scan("path.resolve(__dirname, '.././data')")).toBe(true);
    expect(scan("PATHS?.root + '/data'")).toBe(true);
    expect(scan("process?.cwd() + '/data'")).toBe(true);
    expect(scan("process.cwd?.() + '/data'")).toBe(true);
  });

  it('spares the look-alikes that must stay legal', () => {
    expect(scan("join(process.cwd(), 'test-data')")).toBe(false);
    expect(scan('workspacePath: process.cwd()')).toBe(false);
    expect(scan("join(tempRoot, 'data', 'cos')")).toBe(false);
    expect(scan("join(__HERE, '..', '..', 'data.reference', 'prompts')")).toBe(false);
    expect(scan("import { PATHS } from '../lib/fileUtils.js'")).toBe(false);
    // A fake absolute path inside a mock factory. The `..` here belongs to the
    // module specifier, not to a climb — matching this flags 1 real suite
    // (creativeDirector/sceneEvaluator.test.js) for nothing.
    expect(scan("vi.mock('../../lib/fileUtils.js', () => ({ PATHS: { videoThumbnails: '/data/video-thumbnails' } }));")).toBe(false);
  });
});
