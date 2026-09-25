/**
 * Purge the learning buckets poisoned by the PARENT-WORKSPACE commit criterion
 * on CLAIM flows — the same #2696-class artifact migrations 197/198/234 handled
 * for other routes, arriving by a new one.
 *
 * Background:
 *   A claim flow (plan-task / claim-issue / claim-issue-gitlab / claim-issue-jira /
 *   claim-work) runs with `useWorktree: false` in the app's live checkout while
 *   the AGENT cuts its own `claim/<item>` worktree, opens the PR/MR, merges, and
 *   cleans up. `evaluateSuccessCriteria`'s run-window commit probe
 *   (`server/lib/gitCommitProbe.js`) is workspace-scoped: it counts commits in
 *   the workspace it is handed, so on the common path it sees NOTHING the claim
 *   run did. The PR-claim verification cannot backstop it either — claim flows
 *   carry `openPR: false` (the claim prompt owns the forge lifecycle), so
 *   `prClaimExpected` is false and the forge check never runs.
 *
 *   The declared boolean OVERRIDES the runner's exit code in task-learning
 *   (`outcomeSuccess = validationPassed ?? success`), so every exit-0 claim run
 *   recorded a FAILURE. On installs that lean on claim flows the bucket sits at
 *   ~0-25% while the runs visibly succeed — surfacing as the "may need prompt
 *   improvements" worst-performer warning on a healthy flow.
 *
 *   The criterion is now exempted at the source (`isClaimFlowDispatch` in
 *   taskTypeHooks.js, consumed by evaluateSuccessCriteria and the history
 *   backfill's fossil sanitizer), but that fix is PROSPECTIVE. Existing installs
 *   still carry the fabricated failures.
 *
 * Approach:
 *   DELETE the poisoned buckets rather than repair them — `validationPassed:
 *   false` overwrote the runner's real verdict at record time, so the truth of
 *   each historical run is not on disk. Deleting resets each type to an honest
 *   "no runs recorded yet". `removeTaskTypeFromLearningData` unwinds the
 *   contribution from every aggregate the bucket touched.
 *
 *   Scoped to the claim-flow buckets ONLY (both the `self-improve:` prefixed
 *   form a scheduled claim task lands in and the bare form a task typed on
 *   `taskType` alone can land in). Every other bucket keeps its history: the
 *   coordinator/tracker-filing shapes were handled by 197/198/234, and ordinary
 *   code-editing types have a satisfiable criterion.
 *
 *   No-op by construction on installs with no learning store or no claim-flow
 *   bucket (an install that never ran a claim flow keeps everything).
 *
 *   Destructive-rerun guard (#2770): opts into the runner's PURGE class
 *   (`purge: true`) so a rerun against a lost/rebuilt applied-list is recorded
 *   without executing, rather than dropping post-fix history.
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
