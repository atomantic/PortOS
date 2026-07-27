/**
 * Video Gen — render-backend mode enum (#3135).
 *
 * The video lane of the media job queue has always discriminated its backend on
 * `job.params.mode`, but only INLINE against the *image* module's constant:
 * `mediaJobQueue/index.js` reads `params.mode === IMAGE_GEN_MODE.GROK` to pick
 * `videoGen/grok.js` over `videoGen/local.js`, and `routes/videoGen.js` stamps
 * that same image constant onto a grok video job. That reuse is correct (the two
 * lanes deliberately share one discriminator namespace) but it left video with
 * no enumerable alphabet — so a Zod schema, a UI picker, or a resolver had
 * nothing to derive from and had to hand-copy `['local', 'grok']`.
 *
 * This module is that alphabet. The values are DERIVED from `IMAGE_GEN_MODE`
 * rather than re-typed, so the queue's discriminator can never drift from what a
 * schema validates.
 *
 * Careful: local video renders ALSO use a `params.mode` for the t2v/i2v semantic
 * ('text' | 'image' | 'fflf' | 'a2v' | 'extend' | an IC-LoRA remix id — see
 * `videoGen/local.js`'s `helperMode`). That namespace never collides with the
 * literal 'grok', which is exactly why the cloud discriminator can share the
 * key; a grok job carries the semantic separately as `videoMode`.
 *
 * Dependency-free apart from the image enum (which is itself a leaf), so
 * `lib/validation.js` and the commission validation leaf can both import it.
 */

import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

export const VIDEO_GEN_MODE = Object.freeze({
  LOCAL: IMAGE_GEN_MODE.LOCAL,
  GROK: IMAGE_GEN_MODE.GROK,
});

export const VIDEO_GEN_MODES = Object.freeze(Object.values(VIDEO_GEN_MODE));

// Cloud-CLI video backends — each render shells out to an external child that
// spends remote quota, so the queue routes them through its parallel cloud lane
// instead of serializing on the MLX runtime.
export const CLOUD_VIDEO_GEN_MODES = Object.freeze([VIDEO_GEN_MODE.GROK]);

/**
 * Is `mode` a video backend this install can actually render on right now?
 *
 * Grok video runs through the SAME `imageGen.grok.enabled` opt-in as grok image
 * gen (one CLI, one toggle — see the gate in `routes/videoGen.js` and the note
 * at the top of `videoGen/grok.js`). Local is always "usable" here; its own
 * pythonPath/model validation happens per call site in `generateVideo`.
 */
export function isVideoModeUsable(settings, mode) {
  if (mode === VIDEO_GEN_MODE.GROK) return settings?.imageGen?.grok?.enabled === true;
  return mode === VIDEO_GEN_MODE.LOCAL;
}

/**
 * Resolve the video backend for a render: the per-request/per-record override
 * when that backend is usable, else the install-wide default.
 *
 * Mirrors `pickUsableMode` (imageGen/cloudProviderConfig.js) in shape and
 * intent, but the DEFAULT differs deliberately: image gen prefers an enabled
 * cloud backend, while video defaults to LOCAL. A local video render is free and
 * fully controllable (model/frames/fps/LoRAs); grok video spends remote quota
 * and only delivers 6s or 10s clips (see lib/grokVideoClip.js). Silently
 * upgrading every unpinned video render to a paid backend because the user
 * enabled grok for IMAGES would be a surprise spend, so grok video stays opt-in
 * per record. There is no `settings.videoGen.mode` install-wide pin today; when
 * one lands it belongs as the second candidate here.
 */
export function resolveVideoMode(requested, settings) {
  if (requested && isVideoModeUsable(settings, requested)) return requested;
  return VIDEO_GEN_MODE.LOCAL;
}
