/**
 * A clip rendered from a storyboard panel (`guidanceImageFile`): the panel is
 * layout guidance and `referenceImageFiles` set the look, so neither is a start
 * frame. Only lanes that can build a first frame from references take it: Grok
 * (image_edit, then image_to_video) and a fal.ai reference-to-video model. The
 * prompt contract both share is lib/storyboardGuidance.js.
 */
import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import {
  FAL_STORYBOARD_GUIDANCE_MODEL, STORYBOARD_GUIDANCE_MAX_REFERENCES, falStoryboardGuidanceProblem,
} from '../../lib/storyboardGuidance.js';
import { VIDEO_GEN_MODE } from './modes.js';

const refuse = (message, code = 'STORYBOARD_GUIDANCE_INVALID') => new ServerError(message, { status: 400, code });

/**
 * Why this request cannot render from its storyboard panel, or null (also null
 * for a request that names no panel). A fal request naming no model gets the
 * default reference model written onto `body`.
 */
export function storyboardGuidanceRequestError({ body, uploads = {}, backend }) {
  if (!body.guidanceImageFile) return null;
  if (backend !== VIDEO_GEN_MODE.GROK && backend !== VIDEO_GEN_MODE.FAL) {
    return refuse('A clip from a storyboard panel renders on Grok or a fal.ai reference model. Pick one of those, or render the full still first.', 'STORYBOARD_GUIDANCE_UNSUPPORTED');
  }
  if (uploads.sourceImage || body.sourceImageFile || uploads.lastImage || body.lastImageFile || body.keyframes?.length) {
    return refuse('A storyboard panel is guidance, not a start or end frame: send it without a source or end frame.');
  }
  if (body.mode && body.mode !== 'text') return refuse(`A clip from a storyboard panel has no mode '${body.mode}'.`);
  const references = body.referenceImageFiles?.length || 0;
  if (references > STORYBOARD_GUIDANCE_MAX_REFERENCES) {
    return refuse(`A clip from a storyboard panel takes at most ${STORYBOARD_GUIDANCE_MAX_REFERENCES} reference images; this request has ${references}.`);
  }
  if (backend === VIDEO_GEN_MODE.FAL) {
    body.falModelId ||= FAL_STORYBOARD_GUIDANCE_MODEL;
    const model = getFalVideoModel(body.falModelId);
    const problem = falStoryboardGuidanceProblem(model);
    if (problem) return refuse(problem, 'STORYBOARD_GUIDANCE_UNSUPPORTED');
    if (references + 1 > model.referenceImages.max) {
      return refuse(`${model.label} takes at most ${model.referenceImages.max} reference images, the panel included.`);
    }
  }
  return null;
}

/**
 * The panel's and the references' gallery paths. Throws a 400 naming a missing
 * file; `lenient` (the compose preview) names a missing file by its request name.
 */
export function resolveStoryboardGuidanceInputs(body, { lenient = false } = {}) {
  if (!body.guidanceImageFile) return {};
  const resolve = (file, what) => {
    const path = resolveGalleryImage(file);
    if (path || lenient) return path || file;
    throw refuse(`The ${what} is missing from the gallery: ${file}`, 'STORYBOARD_GUIDANCE_MISSING');
  };
  return {
    guidanceImagePath: resolve(body.guidanceImageFile, 'storyboard panel'),
    referenceImagePaths: (body.referenceImageFiles || []).map((file) => resolve(file, 'reference image')),
  };
}

/** The record a guided render's history entry keeps of its inputs (basenames only). */
export const storyboardGuidanceMeta = (guidanceImagePath, referenceImagePaths = []) => (guidanceImagePath
  ? { storyboardGuidance: { guidanceImageFile: basename(guidanceImagePath), referenceImageFiles: referenceImagePaths.map((p) => basename(p)) } }
  : {});

/** The guidance fields a hosted job carries to its provider. */
export const storyboardGuidanceJobParams = (prepared) => (prepared.guidanceImagePath
  ? { guidanceImagePath: prepared.guidanceImagePath, referenceImagePaths: prepared.referenceImagePaths || [] }
  : {});
