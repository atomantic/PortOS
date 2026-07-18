/**
 * Purge the gh/git COORDINATOR learning buckets poisoned by the commit-criterion
 * bug (#2696) — the branch-reconcile / issue-reconcile analogue of migration 197.
 *
 * Background:
 *   branch-reconcile and issue-reconcile are COORDINATOR tasks: their coordinator agent
 *   runs in the app's LIVE checkout (useWorktree/openPR locked off — see taskSchedule.js
 *   MANAGED_AGENT_OPTIONS) and delivers its work through git+gh side effects (a merged PR,
 *   a resolved conflict, healed issue state), NEVER a `[task-<id>]` commit. But
 *   `evaluateSuccessCriteria` only knew one machine-checkable criterion — a `[task-<id>]`
 *   commit — and, because these tasks DO have a workspacePath (the live checkout), fell
 *   through to it. Since a declared verdict OVERRIDES the runner's exit code in
 *   task-learning (`outcomeSuccess` in taskLearning/metrics.js), every correctly executed
 *   coordinator run was recorded as a FAILURE, dragging both buckets to ~0% (the exact
 *   symptom #2696 reports for `self-improve:branch-reconcile`).
 *
 *   `agentLifecycle.js` now exempts these coordinator task types from the commit criterion
 *   (NON_COMMITTING_COORDINATOR_TASK_TYPES), the same way pipeline/media jobs and the
 *   programmatic-I/O reasoning run already were. But that fix is PROSPECTIVE: an install
 *   that has already run branch-reconcile / issue-reconcile carries buckets whose
 *   `succeeded`/`successRate`/`recentOutcomes` are fabricated failures.
 *
 *   That stale data is not inert — it feeds the CoS Learning card, routing, duration
 *   estimates, and the #2760 scope-awareness classifier, which would keep steering the
 *   loop away from these scopes on evidence that was never true.
 *
 * Approach:
 *   DELETE each bucket rather than repair it — the recorded outcomes cannot be
 *   reconstructed (`validationPassed:false` overwrote the runner's real verdict), so the
 *   truth of each historical run is not on disk. Deleting resets each type to an honest
 *   "no runs recorded yet". Reuses `removeTaskTypeFromLearningData` so the fabricated
 *   failures are unwound from every aggregate they touched (totals, byModelTier,
 *   routingAccuracy, errorPatterns, failureSignatures, correlationWindow), not just
 *   `byTaskType`. Environmental failures (rate-limit/auth/network) are PRESERVED — they
 *   never landed in `byTaskType` and are true regardless of this bug.
 *
 *   Scoped to the two gh/git coordinator types. NOT accessibility: accessibility's prompt
 *   ends "Test and commit changes" — it is a fixing task that genuinely commits, so its
 *   commit criterion is real and its bucket was never poisoned by this bug. Kept in lockstep
 *   with NON_COMMITTING_COORDINATOR_TASK_TYPES in agentLifecycle.js.
 *
 *   No-op by construction on installs that never ran these types — the file is only
 *   rewritten when at least one bucket is actually present.
 */

import { readFile, writeFile } from 'fs/promises';
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

    await writeFile(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 Coordinator learning: purged ${purged} mis-recorded coordinator run(s) across ${present.length} bucket(s) (#2696)`);
    return { purged, buckets: present };
  },
};
