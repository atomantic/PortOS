import { maintenance } from '../../lib/maintenanceAdmission.js';
/**
 * Factory for pipeline media-job filename hooks.
 *
 * Stage-specific hooks (comicPages, storyboards, …) share the same skeleton:
 * subscribe to mediaJobEvents 'completed', parse the job's owner string,
 * stamp a `filename` onto the matching stage record so the path survives
 * the mediaJobQueue's 24h archive TTL. The differences are the owner-parse
 * function, the target stage id, and the per-shape reducer that applies
 * the filename. Everything else — idempotent init, error logging, log
 * narrative on success, test reset — is identical.
 *
 * `applyFilename(currentStage, parsed, job, filename)` returns either
 *   { patch, label }  → stage gets the patch; label is logged
 * or `null` to skip (e.g. stale jobId after a re-render — see AGENTS.md
 * "Pending socket-request tracking" for the same generation-aware idea).
 *
 * Optional `onStamped({ parsed, job, filename, label })` fires once *after*
 * the stage write actually commits AND the reducer chose to stamp. Used by
 * the comic-pages hook to file cover renders into a universe's collection
 * — gating on commit avoids a stale-render or write-failure landing in the
 * universe bucket. The callback is awaited inside the same outer
 * try/catch frame as the hook, so a thrown error is logged and swallowed
 * the same way as other hook failures (bookkeeping must not fail renders).
 *
 * **Completion ownership.** The mediaJobEvents listener can't return the
 * handler's promise to anyone, so each run — stage write AND `onStamped`
 * side effect — is registered with a run tracker. `__testing.drain()`
 * resolves once every run in flight (including runs started while draining)
 * has settled, and `__testing.reset()` detaches the listener and THEN
 * drains, so a test fixture can't wipe shared stores underneath a prior
 * test's still-running write (#9634).
 */

import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateStageWithLatest } from './issues.js';

/**
 * Owned completion boundary for fire-and-forget hook runs. `track(promise)`
 * registers a run (the promise must never reject — hook runs end in their
 * own `.catch`); `drain()` resolves when no tracked run is in flight,
 * looping so a run that starts mid-drain is awaited too. Shared with
 * `seasonCoverFilenameHook.js`, which can't use the issue-scoped factory.
 */
export function createHookRunTracker() {
  const inFlight = new Set();
  const track = (promise) => {
    inFlight.add(promise);
    const settle = () => { inFlight.delete(promise); };
    promise.then(settle, settle);
    return promise;
  };
  const drain = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };
  return { track, drain };
}

export function createFilenameHook({ name, stageId, kind = 'image', parseOwner, applyFilename, onStamped = null }) {
  let registeredHandler = null;
  const runs = createHookRunTracker();

  const handler = (job) => {
    // Admitted synchronously so the stage-row stamp is never split by a backup cut.
    void runs.track(withBackupAssetPublication(async () => {
      if (!job || job.kind !== kind) return;
      const filename = job.result?.filename;
      if (typeof filename !== 'string' || !filename) return;
      const parsed = parseOwner(job.owner);
      if (!parsed) return;

      const shortId = String(job.id || '').slice(0, 8);
      // Track BOTH "reducer chose to stamp" AND "write actually committed."
      // The reducer flag alone isn't enough: if updateStageWithLatest throws
      // *after* the reducer ran (validation, IO), the `.catch` below fires
      // but `stampedLabel` keeps its truthy value — without `writeOk` we'd
      // log "stamped" and fire `onStamped` for a write that never landed.
      let stampedLabel = null;
      let writeOk = false;
      await updateStageWithLatest(
        parsed.issueId,
        stageId,
        (currentStage) => {
          const result = applyFilename(currentStage, parsed, job, filename);
          if (!result) return {};
          stampedLabel = result.label || null;
          return result.patch || {};
        },
      ).then(() => { writeOk = true; }).catch((err) => {
        maintenance.markCurrentUnsettled();
        console.error(`❌ ${name} filename hook failed for job ${shortId}: ${err?.message || err}`);
      });

      if (stampedLabel && writeOk) {
        console.log(`📎 ${name} filename stamped — issue=${parsed.issueId.slice(0, 8)} ${stampedLabel} ← ${filename}`);
        if (onStamped) {
          await onStamped({ parsed, job, filename, label: stampedLabel }).catch((err) => {
        maintenance.markCurrentUnsettled();
            console.error(`❌ ${name} onStamped hook failed for job ${shortId}: ${err?.message || err}`);
          });
        }
      }
    }).catch((err) => {
        maintenance.markCurrentUnsettled();
      console.error(`❌ ${name} filename hook crashed: ${err?.message || err}`);
    }));
  };

  function init() {
    if (registeredHandler) return;
    registeredHandler = handler;
    mediaJobEvents.on('completed', registeredHandler);
    console.log(`📎 ${name} filename hook initialized`);
  }

  // Detach first so no new run can start, then wait out the runs already in
  // flight — callers reset shared fixture state right after this resolves.
  async function reset() {
    if (registeredHandler) {
      mediaJobEvents.off('completed', registeredHandler);
      registeredHandler = null;
    }
    await runs.drain();
  }

  return { init, __testing: { reset, drain: runs.drain } };
}
