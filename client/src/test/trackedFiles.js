/**
 * Shared file walker for the repo-hygiene test suites.
 *
 * Several guards (`src/a11yConventions.test.js`, `src/hooks/mountedRefConventions.test.js`)
 * enforce a rule across the whole client tree by grepping its sources. They all
 * need the same answer to "which files count", and that answer has been revised
 * before — the a11y guard originally scanned only `.jsx` and had to grow a `.js`
 * variant once a shared hook reintroduced the pattern it was policing. Keeping
 * one definition means the next such correction lands for every guard at once.
 *
 * Scoped to git-tracked files so an untracked scratch file can't fail a suite,
 * and test files are excluded so a guard can't trip over its own fixtures.
 *
 * Node-only (`child_process`, `fs`) — imported by test files exclusively, never
 * by app code, so it stays out of the browser bundle. It lives in `src/test/`
 * rather than `src/lib/` for that reason: `lib/` carries the enforced barrel +
 * README rule, and a node-builtin module has no business in a browser barrel.
 */

import { execSync } from 'child_process';

const isTest = (f) => f.includes('.test.');

function gitTracked(clientRoot) {
  const out = execSync('git ls-files src', { cwd: clientRoot, encoding: 'utf8' });
  return out.trim().split('\n');
}

/** Git-tracked non-test `.jsx` under `client/src`. */
export function trackedJsxFiles(clientRoot) {
  return gitTracked(clientRoot).filter((f) => f.endsWith('.jsx') && !isTest(f));
}

/**
 * Git-tracked non-test `.js` AND `.jsx` under `client/src`. Hooks and services
 * hold JSX and refs too, so a rule that only scans `.jsx` has a hole exactly
 * where a shared helper would reintroduce the pattern for many call sites at once.
 */
export function trackedSourceFiles(clientRoot) {
  return gitTracked(clientRoot).filter((f) => /\.jsx?$/.test(f) && !isTest(f));
}

/**
 * Git-tracked TEST files under `client/src` — the inverse of the filters above,
 * for a guard whose subject is the tests themselves rather than the app code
 * (`src/test/timeouts.test.js` polices inline async bounds that the per-test
 * budget would cut short). Kept here so "which files count" still has exactly
 * one definition.
 */
export function trackedTestFiles(clientRoot) {
  return gitTracked(clientRoot).filter(isTest);
}
