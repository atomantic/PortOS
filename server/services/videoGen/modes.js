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
 * The alphabet lives in `lib/generationModes.js`, below both validation and the
 * generation services. This module re-exports it beside the service-owned
 * usability and resolution helpers for compatibility.
 *
 * Careful: local video renders ALSO use a `params.mode` for the t2v/i2v semantic
 * ('text' | 'image' | 'fflf' | 'a2v' | 'extend' | an IC-LoRA remix id — see
 * `videoGen/local.js`'s `helperMode`). That namespace never collides with the
 * literal 'grok', which is exactly why the cloud discriminator can share the
 * key; a grok job carries the semantic separately as `videoMode`.
 *
 * Validation imports the leaf directly, so this service module can retain the
 * settings-aware backend resolver without inverting the dependency graph.
 */

import {
  CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES,
} from '../../lib/generationModes.js';
import { normalizeRenderPinValue } from '../../lib/renderTargets.js';

export { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES };

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
  // fal.ai is a metered REST API rather than an opt-in-toggle CLI, so
  // usability is gated on an API key actually being configured (settings or
  // FAL_KEY env) — see videoGen/fal.js#resolveFalApiKey.
  if (mode === VIDEO_GEN_MODE.FAL) {
    return Boolean((settings?.videoGen?.fal?.apiKey || '').trim() || (process.env.FAL_KEY || '').trim());
  }
  // reactor.inc is likewise a metered REST API — usability gated on a
  // configured API key (settings or REACTOR_API_KEY env), same shape as fal.
  if (mode === VIDEO_GEN_MODE.REACTOR) {
    return Boolean((settings?.videoGen?.reactor?.apiKey || '').trim() || (process.env.REACTOR_API_KEY || '').trim());
  }
  return mode === VIDEO_GEN_MODE.LOCAL;
}

/**
 * Resolve the video backend for a render through the video pin ladder (#3231
 * Phase 4): per-request/per-record override → the surface's saved
 * `renderDefaults[target].videoMode` pin → the install-wide
 * `settings.videoGen.mode` pin → LOCAL. Every rung is usability-gated (a
 * pinned grok whose `imageGen.grok.enabled` toggle is off degrades instead of
 * bricking the render — same contract as the image side's
 * resolveRenderTargetConfig).
 *
 * Mirrors `pickUsableMode` (imageGen/cloudProviderConfig.js) in shape and
 * intent, but the FALLBACK differs deliberately: image gen prefers an enabled
 * cloud backend, while video falls back to LOCAL. A local video render is free
 * and fully controllable (model/frames/fps/LoRAs); grok video spends remote
 * quota and only delivers 6s or 10s clips (see lib/grokVideoClip.js). Silently
 * upgrading every unpinned video render to a paid backend because the user
 * enabled grok for IMAGES would be a surprise spend — grok video renders only
 * when a request, record, or explicit user pin names it.
 */
// The ONE enumeration of the video pin rungs (target pin, then install pin) —
// both the resolver below and hasVideoPin walk this list, so adding a rung is
// one edit and the "is anything pinned?" question can't drift from the ladder.
const videoPinRungs = (settings, target) => [
  target ? normalizeRenderPinValue(settings?.renderDefaults?.[target]?.videoMode) : null,
  normalizeRenderPinValue(settings?.videoGen?.mode),
];

/**
 * Does ANY video pin rung name a backend for this surface? Presence only — no
 * usability gating — so callers with a byte-identical-when-auto contract (the
 * creative agent's enforceRenderBackendPin) can gate on the same rung list the
 * resolver walks instead of re-enumerating it.
 */
export function hasVideoPin(settings, { target = null } = {}) {
  return videoPinRungs(settings, target).some(Boolean);
}

export function resolveVideoMode(requested, settings, { target = null } = {}) {
  for (const mode of [requested, ...videoPinRungs(settings, target)]) {
    if (mode && isVideoModeUsable(settings, mode)) return mode;
  }
  return VIDEO_GEN_MODE.LOCAL;
}
