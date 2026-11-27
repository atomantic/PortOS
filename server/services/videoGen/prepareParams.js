/**
 * Prepares validated video-generation requests for submission to the media queue.
 *
 * Preparation owns multipart and durable inputs until it returns the rollback
 * hook to the caller. It also normalizes project dimensions, keyframe mode and
 * the worker offset for pre-sliced audio on the supplied request body.
 */

import { resolveContextFrames, resolveContinuityRequest } from '../../lib/videoContinuity.js';
import { getSettings } from '../settings.js';
import { resolveStoryboardGuidanceInputs } from './storyboardGuidance.js';
import { resolveRequestedVideoBackend, resolveVideoRequestModel, validateDeclaredInputs, validateVideoLorasAndSpeed } from './validateVideoContract.js';
import { createVideoInputStaging, stagePrimaryMedia, withStagedRollback } from './stageVideoInputs.js';
import { resolveReferenceInputs } from './resolveVideoReferences.js';

export { hostedReferenceInputsError, referenceImageUploadsError, resolveRequestedVideoBackend, unknownVideoModelMessage, validateVideoRetryParams } from './validateVideoContract.js';
export { cleanupMultipartTemp, withStagedRollback } from './stageVideoInputs.js';

/**
 * @param {object} opts
 * @param {object} opts.body    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.uploads - `req.files` from multer (may be empty)
 * @param {string[]} opts.localOnlyParamKeys - field names only the local runtimes
 *   consume; a request carrying any of them is not grok-deliverable. Passed in
 *   from the route (which owns their Zod schemas) so this module never has to
 *   import back into `routes/`.
 * @returns {Promise<object>} On the grok lane:
 *   `{ backend, grok, effectiveModel, sourceImagePath, uploadedTempPath,
 *   discardSourceImage, cleanupStaged }`.
 *   On the local lane, additionally `{ pythonPath, effectiveModelId, mode,
 *   lastImagePath, audioFilePath, icReferencePaths, resolvedKeyframes,
 *   extendFromVideoPath, uploadedTempPaths, loras, effectiveChunks,
 *   effectiveChunkPrompts }`.
 *   `cleanupStaged` is the caller's rollback hook for anything that can still
 *   throw after this resolves (today: `enqueueJob`) — pass it to
 *   `withStagedRollback`.
 */
export async function prepareVideoGenParams({ body, uploads, localOnlyParamKeys }) {
  const staging = createVideoInputStaging(uploads);
  return withStagedRollback(staging.cleanupStaged, async () => {
    const settings = await getSettings();
    const backend = resolveRequestedVideoBackend({ body, uploads, settings, localOnlyParamKeys });
    const request = await resolveVideoRequestModel({ backend, body, uploads, settings });
    const declared = validateDeclaredInputs({ body, uploads, backend, ...request });
    const primary = await stagePrimaryMedia({
      body, uploads, settings, backend, effectiveModel: request.effectiveModel,
      ...declared, ...staging, guidance: resolveStoryboardGuidanceInputs(body),
    });
    if (primary.hostedParams) return primary.hostedParams;

    const { icReferenceUploadPath, ...primaryMedia } = primary;
    const references = await resolveReferenceInputs({
      body, uploads, effectiveModel: request.effectiveModel, icSpec: declared.icSpec,
      icReferenceUploadPath, stageUploadDurable: staging.stageUploadDurable,
      sourceImagePath: primaryMedia.sourceImagePath, lastImagePath: primaryMedia.lastImagePath,
      extraUploadedTempPaths: primaryMedia.uploadedTempPaths,
    });
    return assembleQueuedVideoParams({ body, backend, ...request, icSpec: declared.icSpec, primaryMedia, references });
  });
}

// Chain-only request knobs, resolved against the final chunk count.
function resolveChainSettings({ body, effectiveChunks, effectiveModel }) {
  // Per-chunk prompt beats (#3695) — only meaningful once the RESOLVED request
  // really chains, so a single-chunk render (or an a2v/IC one the caller pinned to 1)
  // drops the list entirely rather than persisting a stale array into job params
  // that a resume would replay into the form.
  //
  // Sizing is forgiving in both directions: a stale overlong list (the user
  // typed beats, then lowered the chunk count) is truncated to the resolved
  // count, and a short list is left short — generateChainedVideo falls back to
  // the main prompt for any index the list doesn't cover. Blank entries become
  // an explicit null (absent beat → main prompt) rather than an empty string the
  // runner would render as an empty prompt. An all-blank list collapses to
  // undefined so "the user cleared every beat" and "no beats were sent" persist
  // identically instead of storing a useless array of nulls.
  const normalizedChunkPrompts = effectiveChunks > 1 && Array.isArray(body.chunkPrompts)
    ? body.chunkPrompts.slice(0, effectiveChunks)
      .map((p) => (typeof p === 'string' && p.trim() !== '' ? p : null))
    : undefined;
  const effectiveChunkPrompts = normalizedChunkPrompts?.some(Boolean)
    ? normalizedChunkPrompts
    : undefined;

  // Continuation context window — same "only meaningful once the request
  // really chains" rule as the beats above, so a single-chunk render doesn't
  // persist a knob that never applied and a resume can't replay it into the
  // form. Resolved (defaulted + clamped) here rather than at render time so
  // the persisted job records what the chain will actually do; note `0` is a
  // real value (last-frame chaining) and must not be dropped as falsy.
  const effectiveContextFrames = effectiveChunks > 1
    ? resolveContextFrames(body.contextFrames)
    : undefined;

  const continuation = effectiveChunks > 1 || body.continuityStrategy != null
    ? resolveContinuityRequest({ model: effectiveModel, continuityStrategy: body.continuityStrategy, contextFrames: body.contextFrames })
    : undefined;
  return { effectiveChunkPrompts, effectiveContextFrames, continuation };
}

async function assembleQueuedVideoParams({
  body, backend, pythonPath, effectiveModel, effectiveModelId, icSpec, primaryMedia, references,
}) {
  // Collapse the parallel loraFilenames/loraScales arrays into the internal
  // `[{ filename, scale }]` shape the service (resolveVideoLoras) and the
  // resume param echo consume. A defaulted scale keeps the worker contract
  // simple. Empty (picker cleared) → undefined.
  const loras = Array.isArray(body.loraFilenames) && body.loraFilenames.length
    ? body.loraFilenames.map((filename, i) => ({
        filename,
        scale: typeof body.loraScales?.[i] === 'number' ? body.loraScales[i] : 1.0,
      }))
    : undefined;

  // a2v and the IC remix modes both anchor a single render (audio track /
  // reference clip), so chaining is meaningless — pin to 1 chunk. The IC path
  // also hard-rejects an explicit chunks>1 above; this covers the default.
  const effectiveChunks = (body.mode === 'a2v' || icSpec) ? 1 : (body.chunks ?? 1);
  await validateVideoLorasAndSpeed(effectiveModel, {
    ...body,
    loras,
    sourceImagePath: primaryMedia.sourceImagePath,
    lastImagePath: primaryMedia.lastImagePath,
    keyframes: references.resolvedKeyframes,
    extendFromVideoPath: references.extendFromVideoPath,
    audioFilePath: primaryMedia.audioFilePath,
  });

  const { effectiveChunkPrompts, effectiveContextFrames, continuation } = resolveChainSettings({
    body, effectiveChunks, effectiveModel,
  });

  return {
    backend,
    pythonPath,
    effectiveModel,
    effectiveModelId,
    mode: body.mode,
    ...primaryMedia,
    ...references,
    loras,
    effectiveChunks,
    effectiveChunkPrompts,
    effectiveContextFrames,
    continuation,
  };
}
