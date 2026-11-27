/**
 * Finish a video draft (#3696): decide whether one stored render can be re-rendered on its declared delivery model, and which model that is.
 *
 * A draft is finishable only when the record alone reproduces the same composition at higher quality: written by the finish-aware writer (`renderInputsVersion`; legacy records degrade to "not finishable", absent must never read as "empty"),
 * NO conditioning inputs and a plain text-to-video render (image / FFLF / extend / a2v / IC drafts have no durable reference; deliberate first slice), a single render (not stitched/chained/upscaled), the resolved seed it rendered with, and a model
 * declaring a `finishModelId` that is present in the runnable model list. Mirrors `finishTargetForModel` in `server/lib/videoFinishProfiles.js`; registry edges are server-declared and ride on the `/api/video-gen/status` model entries, so there is no client pair table to drift.
 */

// Mirror of RENDER_INPUTS_VERSION in server/services/videoGen/generateVideoHelpers.js.
export const MIN_RENDER_INPUTS_VERSION = 1;

const hasResolvedSeed = (seed) => seed != null && seed !== '' && Number.isFinite(Number(seed));

const hasPrompt = (prompt) => typeof prompt === 'string' && prompt.trim() !== '' && prompt !== '(no prompt)';

/**
 * True when `record` is a fully reproducible text-to-video render (carries every input the re-render needs), independent of model availability so callers can explain "no compatible model" separately.
 * "this draft isn't reproducible".
 * @param {object|null|undefined} record - RAW video history record
 */
export const isReproducibleTextToVideo = (record) => {
  if (!record || typeof record !== 'object') return false;
  if (!(Number(record.renderInputsVersion) >= MIN_RENDER_INPUTS_VERSION)) return false;
  if (!Array.isArray(record.conditioning) || record.conditioning.length > 0) return false;
  if (record.mode !== 'text') return false;
  if (!hasResolvedSeed(record.seed)) return false;
  if (!hasPrompt(record.prompt)) return false;
  if (record.chainedFrom || record.stitchedFrom || record.upscaledFrom) return false;
  return true;
};

/**
 * Resolve the delivery model a stored draft finishes into, or `null` when the
 * draft isn't finishable on this install.
 * @param {object|null|undefined} record - RAW video history record
 * @param {Array<object>} models - video model entries from the status payload
 * @returns {object|null} the delivery model entry
 */
export const finishTargetForRecord = (record, models) => {
  if (!Array.isArray(models) || models.length === 0) return null;
  if (!isReproducibleTextToVideo(record)) return null;
  const draftModel = models.find((m) => m?.id === record.modelId);
  const targetId = draftModel?.finishModelId;
  if (typeof targetId !== 'string' || targetId.length === 0) return null;
  return models.find((m) => m?.id === targetId) || null;
};
