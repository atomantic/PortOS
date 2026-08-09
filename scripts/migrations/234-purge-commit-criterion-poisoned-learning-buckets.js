/**
 * Purge the learning buckets poisoned by the unsatisfiable `[task-<id>]` commit
 * criterion (#3637) — the general case of migrations 197 and 198.
 *
 * Background:
 *   `evaluateSuccessCriteria` decided a run's `validationPassed` by grepping the
 *   repo for a commit whose subject contained `[task-<id>]`. NOTHING ever emitted
 *   that marker — no prompt, template, or slashdo command asked an agent to stamp
 *   a task id into a commit subject, and the root CLAUDE.md forbids exactly that
 *   shape of subject line. So the criterion was unsatisfiable.
 *
 *   That verdict is not inert: in `taskLearning/metrics.js`, a declared boolean
 *   OVERRIDES the runner's exit code (`outcomeSuccess = validationPassed ?? success`).
 *   Every autonomous, commit-expecting run therefore recorded a FAILURE no matter
 *   how well it went, and those fabricated failures feed the CoS Learning card,
 *   routing, duration estimates, and the scope-awareness classifier.
 *
 *   197 and 198 purged the two buckets where the artifact was first noticed
 *   (layered-intelligence, the gh/git coordinators). #3637 replaces the criterion
 *   itself with the run-window commit probe (`server/lib/gitCommitProbe.js`), which
 *   is satisfiable — but that fix is PROSPECTIVE. Every other autonomous bucket on
 *   an existing install still carries the fabricated failures.
 *
 *   `taskLearning/lifecycle.js`'s `withoutStaleCoordinatorVerdict` does NOT cover
 *   them: it drops the fossil only for tasks where `declaresNoCommitCriterion` is
 *   true, i.e. exactly the exempt types 197/198 already handled. Ordinary
 *   code-editing runs were never in its scope, so a migration is required.
 *
 * Approach:
 *   DELETE each affected bucket rather than repair it — `validationPassed:false`
 *   overwrote the runner's real verdict at record time, so the truth of each
 *   historical run is not on disk. Deleting resets each type to an honest "no runs
 *   recorded yet". `removeTaskTypeFromLearningData` unwinds the contribution from
 *   every aggregate the bucket touched, not just `byTaskType`.
 *
 *   KEPT (never poisoned, so purging them would destroy real history):
 *     - `user-task` — `evaluateSuccessCriteria` returns the null sentinel for
 *       `taskType === 'user'`, so those runs were always exit-code-judged.
 *     - the buckets 197/198 already purged (layered-intelligence + the
 *       NON_COMMITTING_COORDINATOR_TASK_TYPES set). They have declared no commit
 *       criterion since #2696/#2700, so everything recorded after those purges is
 *       honest — re-purging would delete legitimately-earned data.
 *
 *   Derived from the runtime sources of truth (`NON_COMMITTING_COORDINATOR_TASK_TYPES`)
 *   so a coordinator type added there can't drift out of this exemption list.
 *
 *   No-op by construction on installs with no learning store or no purgeable bucket.
 *
 *   Destructive-rerun guard (#2770): opts into the runner's PURGE class
 *   (`purge: true`) so a rerun against a lost/rebuilt applied-list is recorded
 *   without executing, rather than dropping post-fix history.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { atomicWrite } from '../../server/lib/fileUtils.js';
import { removeTaskTypeFromLearningData } from '../../server/services/taskLearning/metrics.js';
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from '../../server/services/taskTypeHooks.js';

const LEARNING_REL = 'data/cos/learning.json';

// Buckets that were NEVER judged by the commit criterion, so their recorded
// outcomes are honest and must survive this purge. `self-improve:` prefixes match
// extractTaskType's first branch (taskLearning/store.js).
export const PRESERVED_BUCKETS = new Set([
  'user-task',
  'self-improve:layered-intelligence', // migration 197
  ...[...NON_COMMITTING_COORDINATOR_TASK_TYPES].map((t) => `self-improve:${t}`), // migration 198
  // The bare form too. extractTaskType prefixes any task carrying an
  // `analysisType`, which a scheduled coordinator always does — but a task typed
  // on `taskType` alone (a shape `isNonCommittingCoordinatorTask` recognizes and
  // exempts) can land in a bucket without the prefix. Purging that would delete
  // honest history for a run the old criterion never judged.
  ...NON_COMMITTING_COORDINATOR_TASK_TYPES,
]);

/** The buckets this migration would purge from a given `byTaskType` map. Pure. */
export function selectPoisonedBuckets(byTaskType) {
  if (!byTaskType || typeof byTaskType !== 'object' || Array.isArray(byTaskType)) return [];
  return Object.keys(byTaskType).filter((bucket) => !PRESERVED_BUCKETS.has(bucket));
}

export default {
  purge: true,
  async up({ rootDir }) {
    const path = join(rootDir, LEARNING_REL);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log('✅ Commit-criterion learning: no learning store — nothing to purge');
      return { purged: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A corrupt learning store is not this migration's problem to fix, and
      // rewriting it would risk destroying recoverable data.
      console.warn('⚠️ Commit-criterion learning: store is not valid JSON — skipping');
      return { purged: 0, reason: 'unparseable' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('⚠️ Commit-criterion learning: store is not an object — skipping');
      return { purged: 0, reason: 'unexpected-shape' };
    }

    const present = selectPoisonedBuckets(data.byTaskType);
    if (present.length === 0) {
      console.log('✅ Commit-criterion learning: no poisoned bucket — no changes');
      return { purged: 0 };
    }

    let purged = 0;
    for (const bucket of present) {
      const previous = removeTaskTypeFromLearningData(data, bucket);
      purged += previous?.completed || 0;
    }

    await atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 Commit-criterion learning: purged ${purged} mis-recorded run(s) across ${present.length} bucket(s) (#3637)`);
    return { purged, buckets: present };
  },
};
