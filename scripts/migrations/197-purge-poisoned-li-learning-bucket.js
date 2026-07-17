/**
 * Purge the Layered Intelligence learning bucket poisoned by the commit-criterion
 * bug (#2700).
 *
 * Background:
 *   An LI run is a REASONING run: its prompt explicitly forbids committing or
 *   opening a PR (the worktree is discarded), and it returns its result through the
 *   `.agent-done` sentinel for an output hook to file. But `evaluateSuccessCriteria`
 *   only knew one machine-checkable criterion — a `[task-<id>]` commit — and fell
 *   through to it for LI. Since a declared verdict OVERRIDES the runner's exit code
 *   in task-learning (`outcomeSuccess` in taskLearning/metrics.js), every correctly
 *   executed LI run was recorded as a FAILURE.
 *
 *   `agentLifecycle.js` now exempts programmatic-I/O task types from that criterion,
 *   the same way pipeline/media jobs already were. But that fix is PROSPECTIVE: an
 *   install that has already run the agent-backed LI task carries a bucket whose
 *   `succeeded`/`successRate`/`recentOutcomes` are fabricated failures.
 *
 *   That stale data is not inert. The new `selfEval` LI source (#2700, default-ON
 *   for the PortOS install) reads this exact bucket to judge whether the loop's own
 *   execution is healthy, and would read the poisoned history as a ~0% success rate
 *   — permanently reporting "your execution is DEGRADED" and steering the reasoner
 *   away from filing, on evidence that was never true. The same numbers also feed
 *   routing, the CoS Learning card, and duration estimates.
 *
 * Approach:
 *   DELETE the bucket rather than trying to repair it. The recorded outcomes cannot
 *   be reconstructed: `validationPassed:false` overwrote the runner's real verdict,
 *   so the truth of each historical run is simply not on disk. Deleting resets LI to
 *   an honest "no runs recorded yet" — which the readers already model correctly
 *   (`readLiTaskMetrics` returns `{ read: true, metrics: null }` for an absent
 *   bucket, and selfEval renders "no LI runs recorded yet" and withholds the
 *   execution-health signal from its confidence math). Inventing a success rate to
 *   replace it would be the same sin in the opposite direction.
 *
 *   Reuses `removeTaskTypeFromLearningData` rather than hand-rolling the removal.
 *   The bucket is not the only place the fabricated failures landed — they were also
 *   folded into `totals`, `byModelTier`, `routingAccuracy`, `errorPatterns`,
 *   `failureSignatures`, and `correlationWindow`. Deleting only `byTaskType` would
 *   leave the global success rate (the CoS Learning card) and routing still skewed
 *   while reporting success, and a second hand-written unwind here would drift from
 *   the runtime's as aggregates are added.
 *
 *   Environmental failures are deliberately PRESERVED. `shouldDivertToEnvironmental`
 *   routes rate-limit/auth/network events to their own ledger and never into
 *   `byTaskType`, so they are recorded from real errors and are true regardless of
 *   this bug — unlike `resetTaskTypeLearning`, which purges them because a
 *   user-initiated reset means "forget this type entirely". This migration repairs
 *   mis-recorded data; it must not destroy a genuine outage history.
 *
 *   Scoped to `self-improve:layered-intelligence` — the ONLY registered
 *   programmatic-I/O task type (taskTypeHooks.js `HOOK_MODULES`), so no other bucket
 *   was affected by the bug and none are touched here.
 *
 *   No-op by construction on installs that never ran LI (the common case) — the
 *   file is only rewritten when the bucket is actually present.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { removeTaskTypeFromLearningData } from '../../server/services/taskLearning/metrics.js';

const LEARNING_REL = 'data/cos/learning.json';

// The key LI's runs are recorded under. A scheduled LI task carries
// `metadata.analysisType = 'layered-intelligence'`, and extractTaskType's first
// branch prefixes any such task into `self-improve:<type>` — so this, not the bare
// schedule name, is the poisoned bucket.
const LI_BUCKET = 'self-improve:layered-intelligence';

export default {
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

    await writeFile(path, JSON.stringify(data, null, 2) + '\n');
    console.log(`🧹 LI learning: purged ${purged} mis-recorded layered-intelligence run(s) (#2700)`);
    return { purged };
  },
};
