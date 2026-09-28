/**
 * Test suites that create mkdtemp directories must clean them up.
 *
 * ## The bug class
 *
 * Test suites call `mkdtemp(join(tmpdir(), 'prefix-'))` to create isolated
 * temp directories but never call `rmSync` to remove them. After repeated test
 * runs on a dev machine (CoS agents, pregate), $TMPDIR accumulates tens of
 * thousands of stale directories, consuming disk space and creating FSEvents
 * churn. Issue #9000 observed ~50k leaked directories from ~3 weeks of uptime.
 *
 * ## The rule
 *
 * Every git-tracked `*.test.js` file in test-bearing trees and test-helper
 * modules that call `mkdtemp(join(tmpdir(), …))` or `mkdtempSync(join(tmpdir(), …))` MUST also:
 *
 *  - Import `rmSync` from `fs` (or `fs/promises`)
 *  - Track each root directory created by `mkdtemp`/`mkdtempSync`
 *  - Call `rmSync(root, { recursive: true, force: true })` in an `afterEach` hook
 *
 * For async `mkdtemp`, the pattern is:
 *   - Create a `tempRoots` array at module level
 *   - Track each root: `tempRoots.push(await mkdtemp(…))`
 *   - Clean in afterEach: `afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); })`
 *
 * For sync `mkdtempSync`, the pattern is:
 *   - Create a `tempRoots` array
 *   - Track: `const root = mkdtempSync(…); tempRoots.push(root);`
 *   - Clean: `afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); })`
 *
 * See `server/lib/apiRouteGraph.test.js` for a worked example.
 *
 * ## Opt-out
 *
 * A justified case (e.g., a helper that intentionally retains temp state across
 * test runs or cleans up via a separate mechanism) may opt out with an explicit
 * comment on the line calling mkdtemp:
 *
 *   // SKIP: mkdtemp cleanup — [reason]
 *   const root = mkdtemp(join(tmpdir(), 'myprefix-'));
 *
 * The comment must appear on the mkdtemp line itself (or immediately before it).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// This file lives at server/lib/, so REPO_ROOT needs two levels up. Getting
// this wrong silently drops the repo-root scripts/, lib/, and autofixer/
// trees from `git ls-files` (it would run with cwd=server/, so a top-level
// scripts/foo.test.js is never returned) — those trees are part of the same
// `server` vitest run (see AGENTS.md: "ALSO globs ../scripts, ../lib,
// ../autofixer") and must be scanned too.
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = dirname(LIB_DIR);
const REPO_ROOT = dirname(SERVER_ROOT);

// Test-bearing trees where mkdtemp cleanup is required
const TEST_ROOTS = [
  'server/',
  'scripts/',
  'lib/',
  'autofixer/',
];

// Test helper modules where cleanup is required
const TEST_HELPER_PATTERNS = [
  'server/lib/gitTestRepo.js',
  'scripts/migrations/_*.js',
];

const MKDTEMP_PATTERN = /\b(?:mkdtemp|mkdtempSync)\s*\(\s*(?:join|path\.join)\s*\(\s*(?:tmpdir|process\.env\.\w+|os\.tmpdir)\s*\(\s*\)/g;
const SKIP_MARKER = /SKIP\s*:\s*mkdtemp\s*cleanup/i;
const CLEANUP_PATTERN = /\b(?:rmSync|rm|fs\.rm|destroyGitSandbox)\s*\(/;

/**
 * Finds all git-tracked files in test-bearing trees that match test patterns or are test helpers.
 */
function findTestFiles() {
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter((f) => f && (
    (f.endsWith('.test.js') && TEST_ROOTS.some((root) => f.startsWith(root))) ||
    TEST_HELPER_PATTERNS.some((pattern) => {
      // Simple glob pattern matching: _*.js becomes a startsWith check
      const regexPattern = pattern.replace(/\*/, '.*');
      return new RegExp(regexPattern).test(f);
    })
  ));
  return files;
}

/**
 * Scans a single file's source for mkdtemp calls that lack a cleanup
 * mechanism. Returns an array of human-readable violation strings (empty
 * when the file is clean). Pulled out of the tree-wide test so a probe can
 * exercise the exact same code path against an inline fixture.
 */
function findViolationsInSource(file, src) {
  const violations = [];

  // Skip files with no mkdtemp calls
  if (!MKDTEMP_PATTERN.test(src)) return violations;

  // Check if there's any cleanup mechanism (rmSync, destroyGitSandbox, rm, etc.)
  const hasCleanup = CLEANUP_PATTERN.test(src);

  // Find each mkdtemp call and check for skip marker
  MKDTEMP_PATTERN.lastIndex = 0; // Reset regex
  for (const match of src.matchAll(MKDTEMP_PATTERN)) {
    // Check if this specific call has the skip marker nearby (within 2 lines before)
    const callIndex = match.index;
    const beforeCall = src.slice(Math.max(0, callIndex - 200), callIndex);
    const hasSkipMarker = SKIP_MARKER.test(beforeCall);

    if (!hasSkipMarker && !hasCleanup) {
      const lineNum = src.slice(0, callIndex).split('\n').length;
      violations.push(`${file} line ${lineNum}: mkdtemp without cleanup (add skip marker if justified)`);
    }
  }

  return violations;
}

describe('mkdtemp cleanup guard (#9000)', () => {
  it('finds test files to scan', () => {
    const files = findTestFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('.test.js'))).toBe(true);
  });

  it('scans for mkdtemp calls without cleanup', () => {
    const violations = [];

    for (const file of findTestFiles()) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      violations.push(...findViolationsInSource(file, src));
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} mkdtemp call(s) without cleanup:\n`
        + `  ${violations.join('\n  ')}\n`
        + `\nEach mkdtemp/mkdtempSync must track roots and clean with rmSync in afterEach.\n`
        + `See server/lib/apiRouteGraph.test.js for the pattern.\n`
        + `Or add "// SKIP: mkdtemp cleanup — [reason]" if this is a special case.`,
      );
    }
  });

  it('flags a probe fixture that mkdtemps with no cleanup (real code path)', () => {
    const probeSrc = `
      import { mkdtempSync } from 'fs';
      import { tmpdir } from 'os';
      import { join } from 'path';

      describe('probe', () => {
        it('leaks a temp dir', () => {
          const dir = mkdtempSync(join(tmpdir(), 'x-'));
          expect(dir).toBeTruthy();
        });
      });
    `;
    const violations = findViolationsInSource('probe/fixture.test.js', probeSrc);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/probe\/fixture\.test\.js line \d+: mkdtemp without cleanup/);
  });

  describe('the guard recognizer', () => {
    it('detects mkdtemp calls', () => {
      const src = `
        import { mkdtemp, mkdtempSync } from 'fs/promises';
        const d1 = mkdtemp(join(tmpdir(), 'prefix-'));
        const d2 = mkdtempSync(join(os.tmpdir(), 'prefix-'));
      `;
      expect(src.match(MKDTEMP_PATTERN)).toHaveLength(2);
    });

    it('ignores mkdtemp calls outside tmpdir()', () => {
      const src = `
        const d1 = mkdtemp('./localdir-');
        const d2 = mkdtempSync(process.cwd());
      `;
      expect(src.match(MKDTEMP_PATTERN)).toBeNull();
    });

    it('detects skip markers', () => {
      const src = `// SKIP: mkdtemp cleanup — special case\nconst d = mkdtemp(join(tmpdir(), 'prefix-'));`;
      // The comment itself contains the word "mkdtemp", so find the actual
      // call site (the last occurrence) rather than the first.
      const beforeCall = src.slice(0, src.lastIndexOf('mkdtemp'));
      expect(SKIP_MARKER.test(beforeCall)).toBe(true);
    });

    it('detects cleanup mechanisms', () => {
      const rmSyncSrc = `
        afterEach(() => {
          rmSync(tempRoot, { recursive: true, force: true });
        });
      `;
      expect(CLEANUP_PATTERN.test(rmSyncSrc)).toBe(true);

      const destroySrc = `
        afterEach(async () => {
          await destroyGitSandbox(scratch);
        });
      `;
      expect(CLEANUP_PATTERN.test(destroySrc)).toBe(true);
    });
  });
});
