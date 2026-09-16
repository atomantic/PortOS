/**
 * Guard for the pre-install zone: the CI `Plan test impact` job checks out the
 * repo and immediately runs `node scripts/ci-base-sha.js` and
 * `node scripts/ci-test-plan.js` — with no `npm ci` before them. Those two
 * scripts, and everything they transitively import, therefore have to load
 * from a bare checkout, using Node builtins only.
 *
 * Nothing enforces that today, and the failure is invisible until it isn't:
 * `server/lib/` is one `import { z } from 'zod'` away from unloadable (its
 * barrel already is), so "just move the shared helper somewhere tidier" would
 * take out the first job in CI — the one that decides what every other job
 * runs. That makes it latent rather than live, which is exactly why it needs a
 * guard rather than a comment.
 *
 * This is also why scripts/lib/directInvocation.js stays in scripts/lib/
 * rather than moving to server/lib/ alongside the other pure helpers: it is
 * imported by both pre-install entrypoints.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run by the CI `impact` job before any dependency install. */
const PRE_INSTALL_ENTRYPOINTS = [
  'scripts/ci-base-sha.js',
  'scripts/ci-test-plan.js',
  'scripts/scan-diff-hidden-content.js',
];

/**
 * Scripts that must ALSO load from a bare checkout, but for their own reason
 * rather than because CI runs them first — so they get the builtin-only
 * assertion without the CI-wiring one.
 *
 * `doctor.js` is here because a missing `node_modules` is precisely the
 * failure it exists to explain (#5304): if it needed `npm install` to have
 * succeeded, the one install state that most needs a diagnostic would get a
 * module-resolution stack trace instead. Its `pg` import is a dynamic
 * `import()` inside the database probe for the same reason, which is why it
 * does not show up in this static walk.
 *
 * `cancel-current-ci-run.js` is here because it runs from an `if: failure()`
 * workflow step that may fire before or during a failed dependency install.
 *
 * `ci-gate-report.js` runs on the two gate jobs, which check out the repo for
 * this one script and deliberately install nothing; `ci-retry-cancelled-run.js`
 * is the whole body of the `workflow_run` recovery workflow, which does the
 * same. Both would otherwise be one careless import away from making the
 * required check — or the thing that recovers a cancelled one — unloadable.
 */
const BARE_CHECKOUT_SCRIPTS = [
  'scripts/cancel-current-ci-run.js',
  'scripts/ci-gate-report.js',
  'scripts/ci-retry-cancelled-run.js',
  'scripts/doctor.js',
];

const BUILTINS = new Set(builtinModules);
const isBuiltin = (specifier) => BUILTINS.has(specifier.replace(/^node:/, ''));

/** Static `from '...'` / bare `import '...'` specifiers, comments stripped. */
function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(([, s]) => s);
}

/**
 * Every specifier reachable from `entry`, transitively, split into the bare
 * ones and the repo-relative FILES the walk visited (`entry` included).
 */
function specifiersReachableFrom(entry) {
  const files = new Set();
  const bare = new Set();
  // `relative()` yields backslashes on Windows, where every repo-relative
  // comparison below ("does this start with scripts/?") would then be false
  // and the cone assertion would fail on win32 CI only.
  const posix = (path) => path.split(sep).join('/');
  const walk = (relativePath) => {
    if (files.has(relativePath)) return;
    files.add(relativePath);
    for (const specifier of importSpecifiers(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      walk(posix(relative(REPO_ROOT, resolve(dirname(join(REPO_ROOT, relativePath)), specifier))));
    }
  };
  walk(entry);
  return { bare: [...bare], files: [...files] };
}

const bareSpecifiersReachableFrom = (entry) => specifiersReachableFrom(entry).bare;

describe('scripts that must load from a bare checkout', () => {
  // The walker decides whether the assertions below mean anything, so it is
  // verified against this file's own known imports rather than trusted.
  it('bareSpecifiersReachableFrom follows relative imports and collects bare ones', () => {
    const found = bareSpecifiersReachableFrom('scripts/ci-base-sha.js');
    expect(found).toContain('child_process');
    // Reached only through ./lib/directInvocation.js — proves it recursed.
    expect(found).toContain('fs');
    expect(found.every(isBuiltin)).toBe(true);
    expect(isBuiltin('zod')).toBe(false);
  });

  it.each(PRE_INSTALL_ENTRYPOINTS)('%s is still wired into the CI impact job', (entry) => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain(`node ${entry}`);
  });

  it.each([...PRE_INSTALL_ENTRYPOINTS, ...BARE_CHECKOUT_SCRIPTS])(
    '%s imports only Node builtins, transitively',
    (entry) => {
      const nonBuiltins = bareSpecifiersReachableFrom(entry).filter((s) => !isBuiltin(s));
      expect(nonBuiltins).toEqual([]);
    },
  );
});

/**
 * Builtin-only is NOT the same contract as fits-in-a-sparse-checkout, and the
 * difference is invisible until CI breaks: `scripts/run-ci-tests.js` reaches
 * `../server/lib/bufferedSpawn.js` today, which is builtin-only and would be
 * ABSENT under `sparse-checkout: scripts`. One such import added to a gate
 * script blocks every pull request with a module-not-found error, or leaves
 * the cancel-recovery workflow erroring instead of recovering.
 */
describe('scripts that run from a sparse checkout of scripts/', () => {
  /** Jobs that pass `sparse-checkout: scripts` → the script each one runs. */
  const SPARSE_CHECKOUT_SCRIPTS = [
    'scripts/ci-gate-report.js',
    'scripts/ci-retry-cancelled-run.js',
  ];

  it('the sparse jobs are exactly the ones claiming a sparse checkout', () => {
    // Discovery floor: a THIRD sparse job added without a row above would
    // never be held to the cone contract below.
    const workflows = ['.github/workflows/ci.yml', '.github/workflows/ci-cancel-recovery.yml']
      .map((rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'))
      .join('\n');
    // The `with:` key at the start of a line, not the literal anywhere: a
    // comment mentioning it must neither inflate the count nor evade it.
    const sparseJobs = (workflows.match(/^ +sparse-checkout: scripts$/gm) || []).length;
    // ci.yml's two gate jobs both run ci-gate-report.js; the recovery workflow
    // runs the other one.
    expect(sparseJobs).toBe(3);
    for (const entry of SPARSE_CHECKOUT_SCRIPTS) {
      expect(workflows, entry).toContain(`node ${entry}`);
    }
  });

  it.each(SPARSE_CHECKOUT_SCRIPTS)('%s reaches no file outside scripts/', (entry) => {
    const outside = specifiersReachableFrom(entry).files
      .filter((file) => !file.startsWith('scripts/'));

    expect(outside).toEqual([]);
  });

  it('the cone assertion can fail', () => {
    // Negative control against the exact escape it exists to catch.
    expect(specifiersReachableFrom('scripts/run-ci-tests.js').files)
      .toContain('server/lib/bufferedSpawn.js');
  });

  it('reports posix paths, so the cone check holds on Windows', () => {
    // `relative()` returns backslashes on win32. Without normalising, EVERY
    // reached file reads as outside scripts/ and the suite fails on Windows
    // CI alone — which is exactly how this was found.
    const { files } = specifiersReachableFrom('scripts/ci-gate-report.js');
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((file) => file.includes('\\'))).toEqual([]);
    expect(files).toContain('scripts/lib/directInvocation.js');
  });
});
