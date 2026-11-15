/**
 * ci.yml's jobs with its local composite actions expanded inline — the steps
 * GitHub actually runs — for the workflow-contract tests.
 *
 * Both reads are anchored at import.meta.url on purpose: the test memo
 * (scripts/lib/testMemo.js) keys a test on the repository files its closure
 * names through anchored paths, so a test importing this module is
 * re-verified whenever ci.yml or anything under .github/actions/ changes. A
 * repo-root parameter would hide both inputs from the memo.
 *
 * ZERO external dependencies — see githubOutput.js.
 */
import { readFileSync } from 'node:fs';
import { expandLocalActions, workflowJobs } from './workflowJobs.js';

const CI_WORKFLOW = new URL('../../.github/workflows/ci.yml', import.meta.url);
const ACTIONS_DIR = new URL('../../.github/actions/', import.meta.url);
const ACTIONS_PREFIX = '.github/actions/';

/** @returns {Record<string, string>} job id → expanded job body */
export function readCiJobs() {
  const readAction = (path) => {
    if (!path.startsWith(ACTIONS_PREFIX)) throw new Error(`Not a local action path: ${path}`);
    return readFileSync(new URL(path.slice(ACTIONS_PREFIX.length), ACTIONS_DIR), 'utf8');
  };
  return expandLocalActions(workflowJobs(readFileSync(CI_WORKFLOW, 'utf8')), readAction);
}
