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
 * or `null` to skip (e.g. stale jobId after a re-render — see CLAUDE.md
 * "Pending socket-request tracking" for the same generation-aware idea).
 *
 * Optional `onStamped({ parsed, job, filename, label })` fires once *after*
 * the stage write actually commits AND the reducer chose to stamp. Used by
 * the comic-pages hook to file cover renders into a universe's collection
 * — gating on commit avoids a stale-render or write-failure landing in the
 * universe bucket. The callback is awaited inside the same outer
 * try/catch frame as the hook, so a thrown error is logged and swallowed
 * the same way as other hook failures (bookkeeping must not fail renders).
 */

import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateStageWithLatest } from './issues.js';

export function createFilenameHook({ name, stageId, kind = 'image', parseOwner, applyFilename, onStamped = null }) {
  let registeredHandler = null;

  const handler = (job) => {
    void (async () => {
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
        console.error(`❌ ${name} filename hook failed for job ${shortId}: ${err?.message || err}`);
      });

      if (stampedLabel && writeOk) {
        console.log(`📎 ${name} filename stamped — issue=${parsed.issueId.slice(0, 8)} ${stampedLabel} ← ${filename}`);
        if (onStamped) {
          await onStamped({ parsed, job, filename, label: stampedLabel }).catch((err) => {
            console.error(`❌ ${name} onStamped hook failed for job ${shortId}: ${err?.message || err}`);
          });
        }
      }
    })().catch((err) => {
      console.error(`❌ ${name} filename hook crashed: ${err?.message || err}`);
    });
  };

  function init() {
    if (registeredHandler) return;
    registeredHandler = handler;
    mediaJobEvents.on('completed', registeredHandler);
    console.log(`📎 ${name} filename hook initialized`);
  }

  function reset() {
    if (registeredHandler) {
      mediaJobEvents.off('completed', registeredHandler);
      registeredHandler = null;
    }
  }

  return { init, __testing: { reset } };
}
