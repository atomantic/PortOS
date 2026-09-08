/**
 * Image Gen — shared cloud-CLI provider config resolver.
 *
 * Every surface that can enqueue (or directly run) a cloud-CLI image render
 * repeated the same three steps per provider: read `settings.imageGen.<mode>`,
 * reject when `enabled` isn't true, then assemble that provider's job-param
 * bundle. With two providers (codex, grok) that was ~7 sites × 2 branches of
 * copy-paste, and each new backend doubled it again.
 *
 * `resolveCloudProviderConfig(settings, mode)` collapses all of it into one
 * call. The per-provider knowledge lives in `CLOUD_PROVIDER_SPECS` below, so
 * adding a third cloud CLI is one spec entry instead of a sweep.
 *
 * Deliberately a sibling of `modes.js` rather than part of it: modes.js is the
 * no-dependency enum module both provider modules import, and this file needs
 * `ServerError`.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { normalizeRenderPinValue } from '../../lib/renderTargets.js';
import {
  cloudPromptRequired,
  IMAGE_GEN_PROVIDER_CAPABILITIES,
  maxInputImages,
} from '../../lib/imageGenCapabilities.js';
import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  CLOUD_IMAGE_GEN_MODES,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  IMAGE_GEN_MODE,
  QUEUEABLE_IMAGE_MODES,
} from './modes.js';

// The pure capability half of the specs below, plus the two predicates that
// read it, live in the dependency-free `lib/imageGenCapabilities.js` leaf so
// the client shares them instead of re-typing them. Re-exported here because
// every existing caller (inputImages, prepareParams, the providers,
// fableLoom/production) imports them from this module.
export { cloudPromptRequired, maxInputImages };

/**
 * Per-provider knowledge, keyed by mode:
 *  - `label`      — user-facing provider name used in every disabled message.
 *  - `modelId`    — the *effective* model id for display/metadata (codex and
 *                   agy default to their cheap tiers; grok's backend is fixed).
 *  - `params`     — the provider's knob bundle for a queue job / direct call.
 *                   Codex's `model` carries the effective (defaulted) id so the
 *                   queue row reports what actually renders; the provider
 *                   re-applies the same default, so rendering is unchanged.
 *  - the pure capability flags — `supportsModelOverride`, `maxInputImages`,
 *                   `promptRequiredWithInputImage` — are spread in from
 *                   IMAGE_GEN_PROVIDER_CAPABILITIES (lib/imageGenCapabilities.js),
 *                   which documents what each one means and how it was probed.
 *
 * `modelId`/`params` both take `(config, override)` where `override` is the
 * per-render model id (or a falsy value when the render inherits the saved
 * default). Precedence is override → saved default → provider default.
 */
export const CLOUD_PROVIDER_SPECS = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.CODEX],
    label: 'Codex Imagegen',
    errorCode: 'CODEX_IMAGEGEN_DISABLED',
    modelId: (c, override) => override || c.model || CODEX_IMAGEGEN_DEFAULT_MODEL,
    params: (c, override) => ({
      codexPath: c.codexPath,
      model: override || c.model || CODEX_IMAGEGEN_DEFAULT_MODEL,
      effort: c.effort,
    }),
  }),
  [IMAGE_GEN_MODE.GROK]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.GROK],
    label: 'Grok Imagegen',
    errorCode: 'GROK_IMAGEGEN_DISABLED',
    modelId: () => 'grok-imagegen',
    params: (g) => ({ grokPath: g.grokPath, aspectRatio: g.aspectRatio }),
  }),
  [IMAGE_GEN_MODE.AGY]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.AGY],
    label: 'Agy Imagegen',
    errorCode: 'AGY_IMAGEGEN_DISABLED',
    // The concrete cheap-tier pin (not the ANTIGRAVITY_CONFIGURED_DEFAULT
    // sentinel, which resolves to "no --model" and lets agy pick a possibly
    // reasoning-heavy session default) — see AGY_IMAGEGEN_DEFAULT_MODEL.
    modelId: (a, override) => override || a.model || AGY_IMAGEGEN_DEFAULT_MODEL,
    params: (a, override) => ({
      agyPath: a.agyPath,
      model: override || a.model || AGY_IMAGEGEN_DEFAULT_MODEL,
    }),
  }),
});

/**
 * Resolve a cloud-CLI provider's settings slice into everything a call site
 * needs. Returns `null` for non-cloud modes (local / external) so callers can
 * keep their own branch for those.
 *
 * Shape:
 *  - `enabled`        — the settings toggle (strict boolean).
 *  - `config`         — the raw `settings.imageGen[mode]` slice (never null).
 *  - `modelId`        — effective model id for response/queue metadata.
 *  - `providerParams` — knob bundle WITHOUT `mode` (direct provider calls,
 *                       which strip the dispatcher-only field).
 *  - `jobParams`      — `{ mode, ...providerParams }` for `enqueueJob`, where
 *                       `mode` is the queue's lane discriminator.
 *  - `disabledError`  — a ready-to-throw ServerError (null when enabled).
 *  - `disabledReason` — `'<mode>-disabled'`, for callers that skip silently.
 *  - `connectionReason` — reason string for `checkConnection` responses.
 *
 * `overrides.model` is the per-render model id (the request's `cloudModel`).
 * It only applies to providers whose spec sets `supportsModelOverride` — a
 * value passed for grok is ignored rather than silently changing nothing at
 * spawn time. Blank/whitespace is treated as "inherit the saved default", so
 * a cleared select in the UI round-trips to the settings value instead of
 * pinning an empty model id.
 */
export function resolveCloudProviderConfig(settings, mode, overrides = {}) {
  const spec = CLOUD_PROVIDER_SPECS[mode];
  if (!spec) return null;
  const config = settings?.imageGen?.[mode] || {};
  const enabled = config.enabled === true;
  const requestedModel = typeof overrides.model === 'string' ? overrides.model.trim() : '';
  const modelOverride = spec.supportsModelOverride && requestedModel ? requestedModel : null;
  const providerParams = spec.params(config, modelOverride);
  return {
    mode,
    config,
    enabled,
    supportsModelOverride: spec.supportsModelOverride === true,
    modelOverride,
    modelId: spec.modelId(config, modelOverride),
    providerParams,
    jobParams: { mode, ...providerParams },
    disabledError: enabled ? null : new ServerError(
      `${spec.label} is disabled — enable it in Settings → Image Gen first`,
      { status: 400, code: spec.errorCode },
    ),
    disabledReason: `${mode}-disabled`,
    connectionReason: `${spec.label} is disabled in settings`,
  };
}

/**
 * Can the queue-backed surfaces render in `mode` right now? Cloud CLIs need
 * their opt-in toggle; local is always usable (its own pythonPath/model
 * validation happens per call site); external isn't queueable at all.
 *
 * The predicate behind the candidate walk in `resolveMode`
 * (pipeline/visualStageHelpers.js), so the mode ladder no longer grows a
 * pairwise `if` per backend.
 *
 * There is no edit/i2i variant: every queueable backend accepts an input image
 * (see EDIT_INCAPABLE_IMAGE_MODES, whose sole member — external — is not
 * queueable), so an i2i render walks this exact ladder. #3243 threaded an
 * `{ edit }` flag through here to route redraws away from Agy; that turned out
 * to be a misreading of Agy's tool schema, and the flag is gone rather than
 * left as a branch that can never be taken.
 */
export function isModeUsable(settings, mode) {
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) return false;
  const cloud = resolveCloudProviderConfig(settings, mode);
  return cloud ? cloud.enabled : true;
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
 * Resolve one surface's image render config through the render-target ladder
 * (#3231 Phase 2): per-request/per-record override → the target's saved
 * `renderDefaults` pin → the install-wide `settings.imageGen.mode` → the
 * caller's own fallback. Every creative surface resolves through THIS (the
 * guard test in renderTargets.guard.test.js fails a direct
 * `resolveCloudProviderConfig` call outside the dispatcher) so a new surface
 * is one `RENDER_TARGET` entry + one call here — and so the target's saved
 * `imageModel` actually reaches the provider instead of being dropped, which
 * is exactly what all seven pre-#3231 call sites did.
 *
 * Options:
 *  - `mode`        — the surface's per-request mode override (e.g.
 *                    `body.mode`). Wins over every pin.
 *  - `model`       — per-request cloud model override. Wins over every pin.
 *  - `recordMode`  — the owning record's persisted backend pin (#3231 Phase 3
 *                    — universe/series/sprite `imageMode`, normalized via
 *                    `recordRenderPin`). Sits between the per-request override
 *                    and the target's `renderDefaults` pin, and is
 *                    usability-gated like the target pin (a since-disabled
 *                    backend degrades instead of bricking the record's
 *                    renders — the enforceRenderBackendPin contract).
 *  - `recordModel` — the owning record's persisted model pin. Rides only when
 *                    the resolved mode is the record's pinned backend (same
 *                    leak guard as the target's model pin).
 *  - `fallbackMode`— the surface's historical final fallback when nothing
 *                    else resolves (EXTERNAL for batch-reject surfaces, LOCAL
 *                    for local-first ones). Surfaces with their own usability
 *                    ladder (resolveQueueImageMode / pickUsableMode) resolve
 *                    mode first — seeding the ladder with the record pin then
 *                    `renderTargetDefaults(...).imageMode` — and pass the
 *                    result as `mode` here for model threading (keeping
 *                    `recordMode`/`recordModel` so the leak guard still knows
 *                    which backend the record pinned).
 *
 * Returns `{ mode, cloud }` — `cloud` is the resolveCloudProviderConfig
 * bundle (null for non-cloud modes), with the layered model threaded through.
 */
export function resolveRenderTargetConfig(settings, target, {
  mode = null,
  model = null,
  recordMode = null,
  recordModel = null,
  fallbackMode = null,
} = {}) {
  const defaults = renderTargetDefaults(settings, target);
  // Pins are usability-gated: a pinned backend whose enable toggle is off (or
  // that isn't queueable) falls through to the next rung instead of bricking
  // every render on this surface with a disabled-error. An explicit
  // per-request `mode` deliberately is NOT gated — it keeps each surface's
  // existing explicit-request error semantics.
  const recordPinnedMode = recordMode && isModeUsable(settings, recordMode) ? recordMode : null;
  const pinnedMode = defaults.imageMode && isModeUsable(settings, defaults.imageMode)
    ? defaults.imageMode
    : null;
  const finalMode = mode || recordPinnedMode || pinnedMode || settings?.imageGen?.mode || fallbackMode;
  // A model pin rides WITH its backend pin: apply recordModel/defaults.imageModel
  // only when the resolved mode is still that pin's backend. When the mode fell
  // back (pin disabled) or an explicit request chose another backend, the
  // pinned model must not leak — codex would happily accept `--model` with a
  // gemini id (supportsModelOverride gates by PROVIDER, not by id namespace).
  const requestedModel = (typeof model === 'string' && model.trim()) ? model.trim() : null;
  const finalModel = requestedModel
    || (recordMode && finalMode === recordMode ? recordModel : null)
    || (defaults.imageMode && finalMode === defaults.imageMode ? defaults.imageModel : null);
  return {
    mode: finalMode,
    cloud: resolveCloudProviderConfig(settings, finalMode, { model: finalModel }),
  };
}
