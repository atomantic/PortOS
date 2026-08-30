/**
 * Finish a video draft (#3696) — decide whether one stored render can be
 * re-rendered on its declared delivery model, and which model that is.
 *
 * A draft is finishable only when the record alone is enough to reproduce the
 * same composition at higher quality. That means all of:
 *   - it was written by the finish-aware writer (`renderInputsVersion`), so its
 *     conditioning inventory can be trusted. Legacy records predate the field
 *     and degrade to "not finishable" rather than being assumed unconditioned —
 *     absent must never read as "empty" here.
 *   - it used NO conditioning inputs (`conditioning` is an empty array) and is
 *     a plain text-to-video render. Image / FFLF / extend / a2v / IC drafts
 *     have no durable reference to re-render from, so Finish is not offered for
 *     them at all (deliberate first slice — see issue #3696).
 *   - it is a single render, not a stitched/chained/upscaled derivative.
 *   - it carries the resolved seed it actually rendered with.
 *   - its model declares a `finishModelId` AND that delivery model is present
 *     in the model list this install can actually run.
 *
 * Mirrors `finishTargetForModel` in `server/lib/videoFinishProfiles.js`; the
 * registry edges themselves are server-declared and ride to the client on the
 * `/api/video-gen/status` model entries, so there is no client-side pair table
 * to drift.
 */

// Mirror of RENDER_INPUTS_VERSION in server/services/videoGen/generateVideoHelpers.js.
export const MIN_RENDER_INPUTS_VERSION = 1;

const hasResolvedSeed = (seed) => seed != null && seed !== '' && Number.isFinite(Number(seed));

const hasPrompt = (prompt) => typeof prompt === 'string' && prompt.trim() !== '' && prompt !== '(no prompt)';

/**
 * True when `record` is a fully reproducible text-to-video render — i.e. the
 * record itself carries every input the re-render needs. Independent of model
 * availability, so callers can explain "no compatible model" separately from
 * "this draft isn't reproducible".
 *
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
 *
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

/**
 * True when `model` sits at the DELIVERY end of the finish graph — i.e. some
 * other entry in `models` names it as its `finishModelId`.
 *
 * Mirror of `isDeliveryVideoModel` in `server/lib/videoFinishProfiles.js`, which
 * is what `draftDecodeDeclineReason` consults: a delivery model always decodes
 * on its own decoder, whatever a request asked for. The client needs the same
 * reading so the decode picker SHOWS what the render will do instead of
 * offering a draft decode the server will silently decline.
 *
 * @param {object|null|undefined} model
 * @param {Array<object>} models - video model entries from the status payload
 */
export const isDeliveryVideoModel = (model, models) => {
  const id = model?.id;
  if (typeof id !== 'string' || id.length === 0 || !Array.isArray(models)) return false;
  return models.some((entry) => entry?.finishModelId === id);
};
