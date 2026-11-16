/**
 * Purge the learning buckets poisoned by the unsatisfiable `[task-<id>]` commit criterion (#3637), the general case of migrations 197 and 198.
 *
 * `evaluateSuccessCriteria` decided `validationPassed` by grepping for a commit whose subject contained `[task-<id>]`, which NOTHING ever emitted (no prompt or slashdo command stamps a task id into a
 * subject, and the root CLAUDE.md forbids that shape). In `taskLearning/metrics.js` a declared boolean OVERRIDES the runner's exit code (`outcomeSuccess = validationPassed ?? success`), so every autonomous,
 * commit-expecting run recorded a FAILURE, feeding the CoS Learning card, routing, duration estimates and the scope-awareness classifier.
 *
 * 197/198 purged the first two affected buckets and #3637 replaced the criterion with the run-window commit probe (`server/lib/gitCommitProbe.js`), but that fix is PROSPECTIVE: every other autonomous bucket on an existing
 * install still carries fabricated failures. `withoutStaleCoordinatorVerdict` in `taskLearning/lifecycle.js` does NOT cover them (it only drops the fossil for `declaresNoCommitCriterion` types, i.e. the ones 197/198 handled).
 *
 * DELETE each affected bucket rather than repair it (`validationPassed:false` overwrote the real verdict at record time); `removeTaskTypeFromLearningData` unwinds every aggregate the bucket touched.
 *
 * KEPT (never poisoned): `user-task` (`evaluateSuccessCriteria` returns the null sentinel for `taskType === 'user'`), and the buckets 197/198 already purged (layered-intelligence + the
 * NON_COMMITTING_COORDINATOR_TASK_TYPES set, derived from the runtime source of truth so a new coordinator type can't drift out); they declare no commit criterion since #2696/#2700, so re-purging would delete earned data.
 *
 * No-op without a learning store or purgeable bucket. Destructive-rerun guard (#2770): opts into the runner's PURGE class (`purge: true`) so a rerun against a lost/rebuilt applied-list is recorded without executing.
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
