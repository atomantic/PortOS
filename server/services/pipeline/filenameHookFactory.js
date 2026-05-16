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
 */

import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { updateStageWithLatest } from './issues.js';

export function createFilenameHook({ name, stageId, kind = 'image', parseOwner, applyFilename }) {
  let registeredHandler = null;

  const handler = (job) => {
    void (async () => {
      if (!job || job.kind !== kind) return;
      const filename = job.result?.filename;
      if (typeof filename !== 'string' || !filename) return;
      const parsed = parseOwner(job.owner);
      if (!parsed) return;

      const shortId = String(job.id || '').slice(0, 8);
      let stampedLabel = null;
      await updateStageWithLatest(
        parsed.issueId,
        stageId,
        (currentStage) => {
          const result = applyFilename(currentStage, parsed, job, filename);
          if (!result) return {};
          stampedLabel = result.label || null;
          return result.patch || {};
        },
      ).catch((err) => {
        console.error(`❌ ${name} filename hook failed for job ${shortId}: ${err?.message || err}`);
      });

      if (stampedLabel) {
        console.log(`📎 ${name} filename stamped — issue=${parsed.issueId.slice(0, 8)} ${stampedLabel} ← ${filename}`);
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
