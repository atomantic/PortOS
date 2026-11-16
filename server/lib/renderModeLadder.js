/**
 * Image-gen mode resolution ladder — the pure "which backend actually
 * renders" resolver shared by every server surface AND the client (#6815).
 *
 * Dependency-free leaf (imports only the sibling `generationModes.js` and
 * `renderTargets.js`) so the browser bundle can import it directly, the same
 * way `client/src/lib/imageGenModes.js` already imports those two siblings —
 * see that file's header. Before this existed, `VisualGenSettings.jsx`
 * hand-copied the ladder for its "Auto → …" label and drifted from the real
 * one: #3231 added two rungs to the server ladder (a per-record pin, a
 * per-render-target pin) that the hand copy never got.
 *
 * `services/imageGen/cloudProviderConfig.js` re-exports `isModeUsable` /
 * `pickUsableMode` / `renderTargetDefaults` for its existing callers — this
 * module is the one place they're defined.
 *
 * Fall-through semantics (the part worth getting right before editing this
 * file): every entry in a candidate list is a PREFERENCE, not a guarantee. A
 * pin naming a backend that is disabled, removed, or was never enabled on
 * this install falls through to the next candidate rather than failing the
 * render — see `pickUsableMode`. The one thing that is NOT a preference is a
 * caller's own explicit per-request mode (an API body's `mode`, or a stage's
 * non-"auto" `genConfig.imageMode`): callers prepend that ahead of
 * `imageModeCandidates`'s output themselves, because "usable or reject" at
 * that rung is the caller's own contract, not this ladder's.
 */

import {
  CLOUD_IMAGE_GEN_MODES,
  IMAGE_GEN_MODE,
  QUEUEABLE_IMAGE_MODES,
} from './generationModes.js';
import { normalizeRenderPinValue, recordRenderPin } from './renderTargets.js';

/**
 * Can the queue-backed surfaces render in `mode` right now? Local is always
 * usable (its own pythonPath/model validation happens per call site);
 * external isn't queueable at all; a cloud CLI needs its own opt-in toggle.
 *
 * `QUEUEABLE_IMAGE_MODES` is LOCAL plus every mode in `CLOUD_IMAGE_GEN_MODES`
 * — by construction, every cloud mode is one this install can enable/disable
 * via `settings.imageGen.<mode>.enabled` — so this needs no per-provider spec
 * lookup. Contrast `resolveCloudProviderConfig` (imageGen/cloudProviderConfig.js),
 * which assembles the FULL per-provider job-param bundle and is not safe to
 * import from a dependency-free leaf.
 *
 * There is no edit/i2i variant: every queueable backend accepts an input
 * image, so an i2i render walks this exact ladder too.
 */
export function isModeUsable(settings, mode) {
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) return false;
  if (mode === IMAGE_GEN_MODE.LOCAL) return true;
  return settings?.imageGen?.[mode]?.enabled === true;
}

/**
 * First usable mode from an ordered candidate list, falling back to the
 * cloud providers (in `CLOUD_IMAGE_GEN_MODES` order) and finally local.
 *
 * A record pinned to a DISABLED backend falls through to the next usable one
 * rather than failing — a pin is a preference (the enforceRenderBackendPin
 * contract). LOCAL is always usable, so the tail always resolves.
 */
export function pickUsableMode(settings, candidates = []) {
  const ordered = [...candidates, ...CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE.LOCAL];
  return ordered.find((m) => m && isModeUsable(settings, m)) || IMAGE_GEN_MODE.LOCAL;
}

/**
 * The user's saved per-surface pins for one render target (#3231 Phase 2) —
 * `settings.renderDefaults[target]`, normalized: the `'auto'` sentinel and
 * blank strings collapse to null ("no pin — fall through").
 */
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
 * The image-mode candidate order shared by every "auto-resolve a backend for
 * this surface" caller, declared ONCE so a new rung (or a reordering) can't
 * drift between the server resolver and a UI's own display of what it will
 * resolve to (#6815):
 *
 *   1. `record`'s own persisted pin (a series/universe/sprite's `imageMode`)
 *      — "this record renders on codex" beats the surface default.
 *   2. The render target's saved `renderDefaults` pin (#3231 Phase 2) — "this
 *      surface renders on codex" beats the install-wide default.
 *   3. The install-wide `settings.imageGen.mode` default.
 *
 * `record` is optional — omit it (or pass null) for a surface with no
 * per-record pin concept. Every entry is usability-gated by
 * `pickUsableMode`/`isModeUsable` when the caller resolves the list, not
 * here — this function only declares the order. The caller's own explicit
 * per-request override (not a preference) is not part of this list; prepend
 * it: `pickUsableMode(settings, [explicitMode, ...imageModeCandidates(...)])`.
 */
export function imageModeCandidates(settings, target, record = null) {
  return [
    recordRenderPin(record).mode,
    renderTargetDefaults(settings, target).imageMode,
    settings?.imageGen?.mode,
  ];
}

/**
 * Pure pin projection shared by browser previews and server dispatch. A
 * mode-only pin inherits models from lower pins on the SAME usable backend.
 * Keep all candidates so local catalog/hardware validation can skip stale pins.
 */
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
