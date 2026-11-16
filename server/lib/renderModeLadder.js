/**
 * Image-gen mode resolution ladder: the pure "which backend actually renders" resolver shared by every server surface AND the client (#6815).
 *
 * Dependency-free leaf (imports only `generationModes.js` and `renderTargets.js`, as `client/src/lib/imageGenModes.js` does) so the browser can import it; `VisualGenSettings.jsx` once hand-copied the ladder for its "Auto → …" label and drifted
 * (#3231 added a per-record pin and a per-render-target pin the copy never got). `services/imageGen/cloudProviderConfig.js` re-exports `isModeUsable` / `pickUsableMode` / `renderTargetDefaults`; this is where they're defined.
 * Fall-through semantics: every candidate is a PREFERENCE, not a guarantee; a pin naming a backend that is disabled, removed or never enabled falls through to the next candidate rather than failing the render (see `pickUsableMode`).
 * NOT a preference: a caller's own explicit per-request mode (an API body's `mode`, or a non-"auto" `genConfig.imageMode`), which callers prepend ahead of `imageModeCandidates`' output since "usable or reject" there is their contract.
 */

import {
  CLOUD_IMAGE_GEN_MODES,
  IMAGE_GEN_MODE,
  QUEUEABLE_IMAGE_MODES,
} from './generationModes.js';
import { normalizeRenderPinValue, recordRenderPin } from './renderTargets.js';

/**
 * Can the queue-backed surfaces render in `mode` right now? Local is always usable (its pythonPath/model validation happens per call site); external isn't queueable; a cloud CLI needs its own opt-in toggle. `QUEUEABLE_IMAGE_MODES` is LOCAL plus every
 * `CLOUD_IMAGE_GEN_MODES` mode (each enable/disable-able via `settings.imageGen.<mode>.enabled`), so no per-provider spec lookup is needed (contrast `resolveCloudProviderConfig`, imageGen/cloudProviderConfig.js, unsafe to import from a leaf).
 * No edit/i2i variant: every queueable backend accepts an input image.
 */
export function isModeUsable(settings, mode) {
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) return false;
  if (mode === IMAGE_GEN_MODE.LOCAL) return true;
  return settings?.imageGen?.[mode]?.enabled === true;
}

/** First usable mode from an ordered candidate list, falling back to the cloud providers (`CLOUD_IMAGE_GEN_MODES` order) then local. A pin to a DISABLED backend falls through (the enforceRenderBackendPin contract); LOCAL is always usable, so the tail resolves. */
export function pickUsableMode(settings, candidates = []) {
  const ordered = [...candidates, ...CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE.LOCAL];
  return ordered.find((m) => m && isModeUsable(settings, m)) || IMAGE_GEN_MODE.LOCAL;
}

/** The user's saved per-surface pins for one render target (#3231 Phase 2), `settings.renderDefaults[target]` normalized: the `'auto'` sentinel and blanks collapse to null ("no pin"). */
export function renderTargetDefaults(settings, target) {
  const d = settings?.renderDefaults?.[target] || {};
  return {
    imageMode: normalizeRenderPinValue(d.imageMode),
    imageModel: normalizeRenderPinValue(d.imageModel),
    videoMode: normalizeRenderPinValue(d.videoMode),
    videoModel: normalizeRenderPinValue(d.videoModel),
  };
}

/**
 * The image-mode candidate order for every "auto-resolve a backend" caller, declared ONCE so a new rung can't drift between the server resolver and a UI's display of it (#6815):
 *   1. `record`'s own persisted pin (a series/universe/sprite's `imageMode`); 2. the render target's saved `renderDefaults` pin (#3231 Phase 2); 3. the install-wide `settings.imageGen.mode`.
 * `record` is optional. Usability gating (`pickUsableMode`/`isModeUsable`) happens when the caller resolves the list, not here; the caller's explicit per-request override isn't part of this list: `pickUsableMode(settings, [explicitMode, ...imageModeCandidates(...)])`.
 */
export function imageModeCandidates(settings, target, record = null) {
  return [
    recordRenderPin(record).mode,
    renderTargetDefaults(settings, target).imageMode,
    settings?.imageGen?.mode,
  ];
}

/** Pure pin projection shared by browser previews and server dispatch: a mode-only pin inherits models from lower pins on the SAME usable backend; keeps all candidates so local catalog/hardware validation can skip stale pins. */
export function resolveRenderPins(sources, { mode = null, usable = () => true } = {}) {
  const pins = sources.map(recordRenderPin).filter((pin) => pin.mode && usable(pin.mode));
  const finalMode = mode || pins[0]?.mode || null;
  const modelCandidates = pins.filter((pin) => pin.mode === finalMode)
    .map((pin) => pin.modelId).filter(Boolean);
  return { mode: finalMode, modelId: modelCandidates[0] || null, modelCandidates };
}

/** Resolve preferences without filesystem, catalog, or provider dependencies. */
export function resolveRenderTargetPins(settings, target, {
  mode = null, model = null, recordMode = null, recordModel = null, fallbackMode = null,
  usableInstallFallback = false,
} = {}) {
  const defaults = renderTargetDefaults(settings, target);
  const sources = [
    { imageMode: recordMode, imageModelId: recordModel },
    { imageMode: defaults.imageMode, imageModelId: defaults.imageModel },
  ];
  const usable = (candidate) => isModeUsable(settings, candidate);
  const pin = resolveRenderPins(sources, { usable });
  const installMode = settings?.imageGen?.mode;
  // Saved cloud preferences may outlive their enable toggle. Keep explicit
  // requests exact, and preserve the legacy external install default.
  const needsUsableFallback = installMode
    ? CLOUD_IMAGE_GEN_MODES.includes(installMode) && !usable(installMode)
    : CLOUD_IMAGE_GEN_MODES.some(usable);
  const installFallback = usableInstallFallback && needsUsableFallback
    ? pickUsableMode(settings) : installMode;
  const finalMode = mode || pin.mode || installFallback || fallbackMode;
  const resolved = resolveRenderPins(sources, { mode: finalMode, usable });
  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  return { ...resolved, modelId: requestedModel || resolved.modelId };
}
