/**
 * Pipeline season (volume) cover — filename hook.
 *
 * Listens for mediaJobQueue 'completed' events and stamps `filename` onto
 * `series.seasons[].cover[slotKey]` (or `…[].backCover[slotKey]`) when the
 * job's owner string is a season-cover owner.
 *
 * Cannot use `createFilenameHook` from filenameHookFactory.js: the factory
 * is hard-coded to issue-scope (`updateStageWithLatest(parsed.issueId, …)`).
 * Season covers live on the series record, not on an issue stage — so we
 * write a small bespoke handler that routes through
 * `seriesSvc.updateSeasonOnSeries`, which serializes against the shared
 * `pipeline-series.json` via `seriesWriteTail`.
 *
 * Idempotency: skips when the slot's recorded `jobId` no longer matches
 * (a re-render landed between enqueue and this completion event). The
 * route stamps `{ jobId, filename: null }` at enqueue; this hook
 * stamps `filename` only when the jobId is still ours.
 */

import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { parseSeasonCoverOwner, slotKeyForVariant } from './owners.js';
import * as seriesSvc from './series.js';
import { fileCoverIntoUniverseCollection } from './coverUniverseFiler.js';

let registeredHandler = null;

const handler = (job) => {
  void (async () => {
    if (!job || job.kind !== 'image') return;
    const filename = job.result?.filename;
    if (typeof filename !== 'string' || !filename) return;
    const parsed = parseSeasonCoverOwner(job.owner);
    if (!parsed) return;

    const shortId = String(job.id || '').slice(0, 8);
    const slotKey = slotKeyForVariant(parsed.variant);
    const { seriesId, seasonId, target } = parsed;
    // Track BOTH that the reducer chose to stamp AND that the write actually
    // landed. Setting a flag inside the reducer alone isn't enough: a
    // validation/IO failure in updateSeasonOnSeries would still trigger the
    // universe filing with a filename that never persisted on the season.
    let reducerStamped = false;
    let writeOk = false;

    await seriesSvc.updateSeasonOnSeries(seriesId, seasonId, (cur) => {
      const record = cur?.[target];
      if (!record) return {}; // season cleared the cover record between enqueue + landing
      // Only stamp when THIS job is still the slot's active render. A
      // re-render queued after us would have replaced `[slotKey].jobId`
      // already — in that case dropping our completion is the correct
      // behavior (the newer job's filename will overwrite ours anyway).
      if (record[slotKey]?.jobId !== job.id) return {};
      reducerStamped = true;
      return {
        [target]: {
          ...record,
          [slotKey]: { ...record[slotKey], filename },
        },
      };
    }).then(() => { writeOk = true; }).catch((err) => {
      console.error(`❌ seasonCover filename hook failed for job ${shortId}: ${err?.message || err}`);
    });

    if (reducerStamped && writeOk) {
      console.log(`📎 seasonCover filename stamped — series=${seriesId.slice(0, 8)} season=${seasonId.slice(0, 8)} ${target}.${slotKey} ← ${filename}`);
      await fileCoverIntoUniverseCollection({ seriesId, filename });
    }
  })().catch((err) => {
    console.error(`❌ seasonCover filename hook crashed: ${err?.message || err}`);
  });
};

export function initSeasonCoverFilenameHook() {
  if (registeredHandler) return;
  registeredHandler = handler;
  mediaJobEvents.on('completed', registeredHandler);
  console.log('📎 seasonCover filename hook initialized');
}

export const __testing = {
  reset() {
    if (registeredHandler) {
      mediaJobEvents.off('completed', registeredHandler);
      registeredHandler = null;
    }
  },
};
