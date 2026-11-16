/**
 * Video Gen — render-backend mode enum (#3135).
 *
 * The video lane discriminates its backend on `job.params.mode`, sharing the
 * image module's discriminator namespace. The enumerable alphabet lives in
 * `lib/generationModes.js`, re-exported here beside the settings-aware usability
 * and resolution helpers; validation imports the leaf directly so this module
 * doesn't invert the dependency graph.
 *
 * Local renders ALSO use `params.mode` for the t2v/i2v semantic (see
 * `videoGen/local.js`'s `helperMode`); it never collides with 'grok', whose job
 * carries the semantic separately as `videoMode`.
 */

import {
  CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES,
} from '../../lib/generationModes.js';
import { normalizeRenderPinValue } from '../../lib/renderTargets.js';

export { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES };

/**
 * Is `mode` a video backend this install can render on right now? Grok shares the
 * `imageGen.grok.enabled` opt-in with grok image gen; local is always "usable"
 * here (its own validation runs per call site in `generateVideo`).
 */
export function isVideoModeUsable(settings, mode) {
  if (mode === VIDEO_GEN_MODE.GROK) return settings?.imageGen?.grok?.enabled === true;
  // fal.ai is metered: gated on a configured key (settings or FAL_KEY), see videoGen/fal.js#resolveFalApiKey.
  if (mode === VIDEO_GEN_MODE.FAL) {
    return Boolean((settings?.videoGen?.fal?.apiKey || '').trim() || (process.env.FAL_KEY || '').trim());
  }
  // reactor.inc: metered REST API, gated on a configured key (settings or REACTOR_API_KEY).
  if (mode === VIDEO_GEN_MODE.REACTOR) {
    return Boolean((settings?.videoGen?.reactor?.apiKey || '').trim() || (process.env.REACTOR_API_KEY || '').trim());
  }
  // Runway: a key in settings or RUNWAYML_API_SECRET.
  if (mode === VIDEO_GEN_MODE.RUNWAY) {
    return Boolean((settings?.videoGen?.runway?.apiKey || '').trim() || (process.env.RUNWAYML_API_SECRET || '').trim());
  }
  if (mode === VIDEO_GEN_MODE.HIGGSFIELD) {
    return Boolean((settings?.videoGen?.higgsfield?.apiKey || '').trim() || (process.env.HIGGSFIELD_API_KEY || '').trim());
  }
  if (mode === VIDEO_GEN_MODE.GOOGLE) {
    return Boolean((settings?.videoGen?.google?.apiKey || '').trim() || (process.env.GOOGLE_CLOUD_API_KEY || '').trim());
  }
  // Gemini has no key to check: it renders in the PortOS Browser, whose sign-in only the render can read.
  if (mode === VIDEO_GEN_MODE.GEMINI) return true;
  return mode === VIDEO_GEN_MODE.LOCAL;
}

/**
 * Resolve the video backend for a render through the video pin ladder (#3231
 * Phase 4): per-request/per-record override → the surface's saved
 * `renderDefaults[target].videoMode` pin → install-wide `settings.videoGen.mode`
 * → LOCAL. Every rung is usability-gated, so a pinned-but-disabled backend
 * degrades instead of bricking the render. The fallback is LOCAL (free), never an
 * enabled paid cloud backend: enabling grok for IMAGES must not silently upgrade
 * unpinned video renders.
 */
// The ONE enumeration of the video pin rungs; the resolver and hasVideoPin both walk it.
const videoPinRungs = (settings, target) => [
  target ? normalizeRenderPinValue(settings?.renderDefaults?.[target]?.videoMode) : null,
  normalizeRenderPinValue(settings?.videoGen?.mode),
];

/**
 * Does ANY video pin rung name a backend for this surface? Presence only, no
 * usability gating, so byte-identical-when-auto callers share the resolver's rung list.
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
