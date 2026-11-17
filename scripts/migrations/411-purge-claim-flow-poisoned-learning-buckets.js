/**
 * Purge the learning buckets poisoned by the PARENT-WORKSPACE commit criterion on CLAIM flows: the same #2696-class artifact migrations 197/198/234 handled for other routes.
 *
 * A claim flow (plan-task / claim-issue / claim-issue-gitlab / claim-issue-jira / claim-work) runs with `useWorktree: false` in the live checkout while the AGENT cuts its own `claim/<item>` worktree, opens the
 * PR/MR, merges and cleans up. The run-window commit probe (`server/lib/gitCommitProbe.js`) is workspace-scoped, so it sees NOTHING the run did, and the PR-claim check can't backstop it (claim flows carry
 * `openPR: false`, so `prClaimExpected` is false). The declared boolean OVERRIDES the runner's exit code (`outcomeSuccess = validationPassed ?? success`), so every exit-0 claim run recorded a FAILURE and healthy
 * flows showed ~0-25% with a "may need prompt improvements" warning. The criterion is now exempted at the source (`isClaimFlowDispatch` in taskTypeHooks.js), but that fix is PROSPECTIVE.
 *
 * DELETE the poisoned buckets rather than repair them (`validationPassed:false` overwrote the real verdict); `removeTaskTypeFromLearningData` unwinds every aggregate they touched. Scoped to the claim-flow buckets ONLY
 * (the `self-improve:` prefixed form and the bare form of a task typed on `taskType` alone); the coordinator/tracker-filing shapes were handled by 197/198/234 and code-editing types have a satisfiable criterion.
 * No-op without a learning store or claim-flow bucket.
 *
 * Destructive-rerun guard (#2770): opts into the runner's PURGE class (`purge: true`) so a rerun against a lost/rebuilt applied-list is recorded without executing.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { atomicWrite } from '../../server/lib/fileUtils.js';
import { removeTaskTypeFromLearningData } from '../../server/services/taskLearning/metrics.js';
import { CLAIM_FLOW_TASK_TYPES } from '../../server/lib/claimFlowTaskTypes.js';

const LEARNING_REL = 'data/cos/learning.json';

// The buckets this migration purges, derived from the runtime claim-flow set so
// a type added there cannot drift out of this list. `self-improve:` matches
// extractTaskType's first branch (taskLearning/store.js) for a scheduled claim
// task carrying `analysisType`; the bare form covers a task typed on `taskType`
// alone.
export const CLAIM_FLOW_BUCKETS = [
  ...[...CLAIM_FLOW_TASK_TYPES].map((t) => `self-improve:${t}`),
  ...CLAIM_FLOW_TASK_TYPES,
];

/** The claim-flow buckets present in a given `byTaskType` map. Pure. */
export function selectClaimFlowBuckets(byTaskType) {
  if (!byTaskType || typeof byTaskType !== 'object' || Array.isArray(byTaskType)) return [];
  return CLAIM_FLOW_BUCKETS.filter((bucket) => Object.hasOwn(byTaskType, bucket));
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
      console.log('✅ Claim-flow learning: no learning store — nothing to purge');
      return { purged: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A corrupt learning store is not this migration's problem to fix, and
      // rewriting it would risk destroying recoverable data.
      console.warn('⚠️ Claim-flow learning: store is not valid JSON — skipping');
      return { purged: 0, reason: 'unparseable' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('⚠️ Claim-flow learning: store is not an object — skipping');
      return { purged: 0, reason: 'unexpected-shape' };
    }

    const present = selectClaimFlowBuckets(data.byTaskType);
    if (present.length === 0) {
      console.log('✅ Claim-flow learning: no claim-flow bucket — no changes');
      return { purged: 0 };
    }

    let purged = 0;
    for (const bucket of present) {
      const previous = removeTaskTypeFromLearningData(data, bucket);
      purged += previous?.completed || 0;
    }

    await atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 Claim-flow learning: purged ${purged} mis-recorded run(s) across ${present.length} bucket(s) (parent-workspace commit criterion)`);
    return { purged, buckets: present };
  },
};
