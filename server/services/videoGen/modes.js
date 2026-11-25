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
  CLOUD_VIDEO_GEN_MODES, HOSTED_MEDIA_BACKENDS, VIDEO_GEN_MODE, VIDEO_GEN_MODES,
} from '../../lib/generationModes.js';
import { CREDENTIALS } from '../../lib/credentialRegistry.js';
import { normalizeRenderPinValue } from '../../lib/renderTargets.js';

export { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, VIDEO_GEN_MODES };

const settingAt = (settings, path) => path.split('.').reduce((value, key) => value?.[key], settings);
const hasKey = (value) => typeof value === 'string' && value.trim() !== '';

/** Check whether this install can select the backend before per-render validation. */
export function isVideoModeUsable(settings, mode) {
  if (mode === VIDEO_GEN_MODE.LOCAL) return true;
  const backend = HOSTED_MEDIA_BACKENDS.find(({ id, video }) => video && id === mode);
  if (!backend) return false;
  if (backend.alwaysUsable) return true;
  if (backend.enabledSetting) return settingAt(settings, backend.enabledSetting) === true;
  const credential = CREDENTIALS.find(({ id }) => id === backend.credentialId);
  return Boolean(credential && (
    (credential.settingsPath && hasKey(settingAt(settings, credential.settingsPath)))
    || credential.envVars.some(name => hasKey(process.env[name]))
  ));
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
