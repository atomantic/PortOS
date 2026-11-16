/**
 * Purge the gh/git COORDINATOR learning buckets poisoned by the commit-criterion bug (#2696), the branch-reconcile / issue-reconcile analogue of migration 197.
 *
 * Those coordinator tasks run in the app's LIVE checkout (useWorktree/openPR off, taskSchedule.js MANAGED_AGENT_OPTIONS) and deliver through git+gh side effects, NEVER a `[task-<id>]` commit; but
 * `evaluateSuccessCriteria` only knew that criterion and, since they have a workspacePath, applied it. A declared verdict OVERRIDES the runner's exit code (`outcomeSuccess` in taskLearning/metrics.js),
 * so every correct run was recorded as a FAILURE (~0% for `self-improve:branch-reconcile`). `agentLifecycle.js` now exempts them (NON_COMMITTING_COORDINATOR_TASK_TYPES), but that is PROSPECTIVE: existing
 * installs carry fabricated failures that feed the CoS Learning card, routing, duration estimates and the #2760 scope-awareness classifier.
 *
 * DELETE each bucket rather than repair it (`validationPassed:false` overwrote the real verdict). `removeTaskTypeFromLearningData` unwinds every aggregate the failures touched (totals, byModelTier,
 * routingAccuracy, errorPatterns, failureSignatures, correlationWindow), not just `byTaskType`; environmental failures (rate-limit/auth/network) are PRESERVED, as they never landed in `byTaskType`.
 *
 * Scoped to the two gh/git coordinator types, kept in lockstep with NON_COMMITTING_COORDINATOR_TASK_TYPES in agentLifecycle.js. NOT accessibility: its prompt ends "Test and commit changes", so its commit
 * criterion is real. No-op on installs that never ran these types.
 *
 * Destructive-rerun guard (#2770): the target is identified by bucket PRESENCE, so a rerun after data/migrations.applied.json is lost (the runner rebuilds the ledger from [] and reruns everything) would drop
 * post-fix history. It opts into the runner's PURGE class (`purge: true`): run-migrations.js records a purge migration as applied WITHOUT executing it whenever the applied-list started empty/rebuilt; shared with 197.
 */

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { join } from 'path';

import { removeTaskTypeFromLearningData } from '../../server/services/taskLearning/metrics.js';
import { NON_COMMITTING_COORDINATOR_TASK_TYPES } from '../../server/services/taskTypeHooks.js';

const LEARNING_REL = 'data/cos/learning.json';

// The keys the coordinator runs are recorded under. A scheduled coordinator task carries
// `metadata.analysisType = '<type>'`, and extractTaskType's first branch prefixes any such
// task into `self-improve:<type>` — so these, not the bare schedule names, are the poisoned
// buckets. Derived from NON_COMMITTING_COORDINATOR_TASK_TYPES (the runtime source of truth)
// so a new coordinator type added there is automatically healed on upgrade — the two can't drift.
const COORDINATOR_BUCKETS = [...NON_COMMITTING_COORDINATOR_TASK_TYPES].map((t) => `self-improve:${t}`);

export default {
  // Opt into the runner's non-idempotent PURGE class — no-op on a rerun against
  // a rebuilt-from-[] ledger so post-fix learning data is never destroyed (#2770).
  purge: true,
  async up({ rootDir }) {
    const path = join(rootDir, LEARNING_REL);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log('✅ Coordinator learning: no learning store — nothing to purge');
      return { purged: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A corrupt learning store is not this migration's problem to fix, and rewriting it
      // would risk destroying recoverable data.
      console.warn('⚠️ Coordinator learning: store is not valid JSON — skipping');
      return { purged: 0, reason: 'unparseable' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('⚠️ Coordinator learning: store is not an object — skipping');
      return { purged: 0, reason: 'unexpected-shape' };
    }

    const byTaskType = data.byTaskType;
    const present = (byTaskType && typeof byTaskType === 'object' && !Array.isArray(byTaskType))
      ? COORDINATOR_BUCKETS.filter((b) => Object.hasOwn(byTaskType, b))
      : [];
    if (present.length === 0) {
      console.log('✅ Coordinator learning: no branch-reconcile/issue-reconcile bucket — no changes');
      return { purged: 0 };
    }

    // Unwinds each bucket AND its contribution to every other aggregate. The environmental
    // ledger is intentionally left alone.
    let purged = 0;
    for (const bucket of present) {
      const previous = removeTaskTypeFromLearningData(data, bucket);
      purged += previous?.completed || 0;
    }

    await atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 Coordinator learning: purged ${purged} mis-recorded coordinator run(s) across ${present.length} bucket(s) (#2696)`);
    return { purged, buckets: present };
  },
};
