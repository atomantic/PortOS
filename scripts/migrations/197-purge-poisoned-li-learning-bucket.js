/**
 * Purge the Layered Intelligence learning bucket poisoned by the commit-criterion bug (#2700).
 *
 * An LI run is a REASONING run (its prompt forbids committing or opening a PR; the result returns via the `.agent-done` sentinel), but `evaluateSuccessCriteria` only knew a
 * `[task-<id>]` commit criterion and applied it to LI. A declared verdict OVERRIDES the runner's exit code in task-learning (`outcomeSuccess` in taskLearning/metrics.js), so every
 * correctly executed LI run was recorded as a FAILURE. `agentLifecycle.js` now exempts programmatic-I/O task types, but that fix is PROSPECTIVE: installs that already ran LI carry a bucket
 * whose `succeeded`/`successRate`/`recentOutcomes` are fabricated failures, which the `selfEval` LI source (default-ON) would read as ~0% success ("execution DEGRADED"), and which also
 * feed routing, the CoS Learning card and duration estimates.
 *
 * DELETE the bucket rather than repair it: `validationPassed:false` overwrote the runner's real verdict, so the truth of each run is not on disk. Deleting resets LI to an honest "no runs
 * recorded yet" (`readLiTaskMetrics` returns `{ read: true, metrics: null }` for an absent bucket); inventing a success rate would be the same sin in reverse.
 *
 * Reuses `removeTaskTypeFromLearningData`: the fabricated failures were also folded into `totals`, `byModelTier`, `routingAccuracy`, `errorPatterns`, `failureSignatures` and
 * `correlationWindow`, and a second hand-written unwind would drift from the runtime's as aggregates are added.
 *
 * Environmental failures are deliberately PRESERVED: `shouldDivertToEnvironmental` routes rate-limit/auth/network events to their own ledger, never `byTaskType`, so they are true
 * regardless of this bug (unlike `resetTaskTypeLearning`, which purges them because a user reset means "forget this type"). Scoped to `self-improve:layered-intelligence`, the ONLY registered
 * programmatic-I/O task type (taskTypeHooks.js `HOOK_MODULES`). No-op on installs that never ran LI.
 *
 * The target is identified by bucket PRESENCE, so a rerun after data/migrations.applied.json is lost would drop legitimately-earned post-fix history; it opts into the runner's PURGE class
 * (`purge: true`): run-migrations.js records a purge migration as applied WITHOUT executing it whenever the applied-list started empty/rebuilt (#2770), shared with migration 198.
 */

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { join } from 'path';

import { removeTaskTypeFromLearningData } from '../../server/services/taskLearning/metrics.js';

const LEARNING_REL = 'data/cos/learning.json';

// The key LI's runs are recorded under: extractTaskType prefixes a task with `metadata.analysisType = 'layered-intelligence'` into `self-improve:<type>`, so this, not the bare schedule name, is the poisoned bucket.
const LI_BUCKET = 'self-improve:layered-intelligence';

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
      console.log('✅ LI learning: no learning store — nothing to purge');
      return { purged: 0, reason: 'no-file' };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A corrupt learning store is not this migration's problem to fix, and
      // rewriting it would risk destroying recoverable data.
      console.warn('⚠️ LI learning: store is not valid JSON — skipping');
      return { purged: 0, reason: 'unparseable' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.warn('⚠️ LI learning: store is not an object — skipping');
      return { purged: 0, reason: 'unexpected-shape' };
    }

    const byTaskType = data.byTaskType;
    const hasBucket = byTaskType && typeof byTaskType === 'object' && !Array.isArray(byTaskType)
      && Object.hasOwn(byTaskType, LI_BUCKET);
    if (!hasBucket) {
      console.log('✅ LI learning: no layered-intelligence bucket — no changes');
      return { purged: 0 };
    }

    // Unwinds the bucket AND its contribution to every other aggregate (totals,
    // byModelTier, routingAccuracy, errorPatterns, failureSignatures,
    // correlationWindow). The environmental ledger is intentionally left alone.
    const previous = removeTaskTypeFromLearningData(data, LI_BUCKET);
    const purged = previous?.completed || 0;

    await atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 LI learning: purged ${purged} mis-recorded layered-intelligence run(s) (#2700)`);
    return { purged };
  },
};
