/**
 * Shared file walker for the repo-hygiene test suites.
 *
 * Several guards (the checks in `src/test/guards/`) enforce a rule across the client tree by grepping sources, and need one answer to "which files count" (the a11y guard first scanned only `.jsx`, then needed `.js` too), so a correction lands for every guard.
 * Scoped to git-tracked files (an untracked scratch file can't fail a suite) and excluding test files (a guard can't trip over its own fixtures). Node-only (`child_process`, `fs`), imported by test files exclusively; it lives in `src/test/` rather than `src/lib/` because `lib/` carries the enforced barrel + README rule.
 */

// The shared guard corpus: one listing per process, which every client check reads through.
import { trackedFiles } from '../../../scripts/lib/guardCorpus.js';

const isTest = (f) => f.includes('.test.');

function gitTracked(clientRoot) {
  return trackedFiles(clientRoot, ['src']);
}

export function trackedJsxFiles(clientRoot) {
  return gitTracked(clientRoot).filter((f) => f.endsWith('.jsx') && !isTest(f));
}

/**
 * Git-tracked non-test `.js` AND `.jsx` under `client/src`: hooks and services hold JSX and refs too, so a `.jsx`-only scan has a hole where a shared helper reintroduces a pattern for many call sites.
 */
export function trackedSourceFiles(clientRoot) {
  return gitTracked(clientRoot).filter((f) => /\.jsx?$/.test(f) && !isTest(f));
}

/**
 * Git-tracked TEST files under `client/src`, the inverse of the filters above, for a guard whose subject is the tests (`client/src/test/guards/ui/timeouts.test.js`), so "which files count" keeps one definition.
 */
export function trackedTestFiles(clientRoot) {
  return gitTracked(clientRoot).filter(isTest);
}
