/**
 * Image Gen — shared cloud-CLI provider config resolver.
 *
 * `resolveCloudProviderConfig(settings, mode)` reads `settings.imageGen.<mode>`,
 * rejects when `enabled` isn't true, and assembles that provider's job-param
 * bundle. Per-provider knowledge lives in `CLOUD_PROVIDER_SPECS`, so adding a
 * cloud backend is one spec entry.
 *
 * A sibling of `modes.js` rather than part of it: modes.js is the no-dependency
 * enum module both provider modules import, and this file needs `ServerError`.
 */

import { ServerError } from '../../lib/errorHandler.js';
import {
  cloudPromptRequired,
  IMAGE_GEN_PROVIDER_CAPABILITIES,
  maxInputImages,
} from '../../lib/imageGenCapabilities.js';
import {
  isModeUsable,
  pickUsableMode,
  renderTargetDefaults,
  resolveRenderTargetPins,
} from '../../lib/renderModeLadder.js';
import { RUNWAY_IMAGE_DEFAULT_MODEL, RUNWAY_IMAGE_MODEL_IDS, getRunwayImageModel } from '../../lib/runwayImageModels.js';
import { FAL_IMAGE_DEFAULT_MODEL, FAL_IMAGE_MODEL_IDS, isFalImageModel } from '../../lib/falImageModels.js';
import { HIGGSFIELD_IMAGE_DEFAULT_MODEL, HIGGSFIELD_IMAGE_MODEL_IDS, higgsfieldImageFamily } from '../../lib/higgsfieldImageModels.js';
import { GOOGLE_IMAGE_DEFAULT_MODEL, GOOGLE_IMAGE_MODEL_IDS, googleImageFamily } from '../../lib/googleImageModels.js';
import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  IMAGE_GEN_MODE,
} from './modes.js';

// A saved `imageGen.fal.model` outside the catalog degrades to the shipped default
// rather than bricking every fal render; an explicit per-render override is refused
// instead — see `knownModels` below.
const falModelFrom = (c, override) => override
  || (isFalImageModel(c.model) ? c.model.trim() : FAL_IMAGE_DEFAULT_MODEL);
const higgsfieldModelFrom = (c, override) => override
  || (higgsfieldImageFamily(c.model) ? c.model.trim() : HIGGSFIELD_IMAGE_DEFAULT_MODEL);
const googleModelFrom = (c, override) => override
  || (googleImageFamily(c.model) ? c.model.trim() : GOOGLE_IMAGE_DEFAULT_MODEL);

// The pure capability half of the specs below, plus the predicates that read it, live
// in the dependency-free `lib/imageGenCapabilities.js` leaf so the client shares them.
// Re-exported because existing callers import them from this module.
export { cloudPromptRequired, maxInputImages };

// The pure resolution ladder lives in the dependency-free `lib/renderModeLadder.js`
// leaf so the client can import it directly; see that module for the fall-through
// semantics (a pin is a preference, not a guarantee). Re-exported for existing callers.
export { isModeUsable, pickUsableMode, renderTargetDefaults };

/**
 * Per-provider knowledge, keyed by mode:
 *  - `label`      — user-facing provider name used in every disabled message.
 *  - `modelId`    — the *effective* model id for display/metadata.
 *  - `knownModels` — optional catalog for a per-render override. A provider whose
 *                   model ids are prices (fal.ai) must not let a typo or a stale pin
 *                   from another backend reach the wire, so a rejected override is a
 *                   400 (`unknownModelCode`), not a silent fallback.
 *  - `params`     — the provider's knob bundle for a queue job / direct call. Codex's
 *                   `model` carries the effective (defaulted) id so the queue row
 *                   reports what actually renders.
 *  - the pure capability flags (`supportsModelOverride`, `maxInputImages`,
 *    `promptRequiredWithInputImage`) are spread in from
 *    IMAGE_GEN_PROVIDER_CAPABILITIES (lib/imageGenCapabilities.js).
 *
 * `modelId`/`params` take `(config, override)` where `override` is the per-render
 * model id (falsy when inheriting). Precedence: override → saved default → provider default.
 */
export const CLOUD_PROVIDER_SPECS = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.CODEX],
    label: 'Codex Imagegen',
    errorCode: 'CODEX_IMAGEGEN_DISABLED',
    modelId: (c, override) => override || c.model || CODEX_IMAGEGEN_DEFAULT_MODEL,
    params: (c, override, overrideIsShippedDefault = false) => ({
      codexPath: c.codexPath,
      modelIsShippedDefault: overrideIsShippedDefault || (!override && !c.model),
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
    // The concrete cheap-tier pin, not the ANTIGRAVITY_CONFIGURED_DEFAULT sentinel (which
    // means "no --model" and lets agy pick a possibly reasoning-heavy default).
    modelId: (a, override) => override || a.model || AGY_IMAGEGEN_DEFAULT_MODEL,
    params: (a, override, overrideIsShippedDefault) => ({
      agyPath: a.agyPath,
      model: override || a.model || AGY_IMAGEGEN_DEFAULT_MODEL,
      // Provenance the resolved `model` erases: whether the id is PortOS's shipped pin or
      // a human's choice. The agy provider re-points a retired shipped pin and must never
      // do that to a user's. A caller that already walked the render-target ladder hands
      // the resolved id back as an override, so every id looks chosen; such a caller says
      // so with `overrideIsShippedDefault`.
      modelIsShippedDefault: overrideIsShippedDefault || (!override && !a.model),
    }),
  }),
  [IMAGE_GEN_MODE.RUNWAY]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.RUNWAY],
    label: 'Runway Imagegen', errorCode: 'RUNWAY_IMAGEGEN_DISABLED',
    knownModels: RUNWAY_IMAGE_MODEL_IDS, unknownModelCode: 'RUNWAY_IMAGE_MODEL_UNKNOWN',
    modelId: (c, override) => override || (getRunwayImageModel(c.model) ? c.model : RUNWAY_IMAGE_DEFAULT_MODEL),
    params: (c, override) => {
      const model = getRunwayImageModel(override || c.model) || getRunwayImageModel(RUNWAY_IMAGE_DEFAULT_MODEL);
      return { model: override || model.id, resolution: model.ratios[c.resolution] ? c.resolution : model.defaultResolution };
    },
  }),
  [IMAGE_GEN_MODE.FAL]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.FAL],
    label: 'fal.ai Imagegen',
    errorCode: 'FAL_IMAGEGEN_DISABLED',
    knownModels: FAL_IMAGE_MODEL_IDS,
    unknownModelCode: 'FAL_IMAGE_MODEL_UNKNOWN',
    modelId: falModelFrom,
    // No key here: the queue persists job params in plaintext, so the provider
    // re-resolves the fal.ai key from live settings at dispatch.
    params: (c, override) => ({ model: falModelFrom(c, override) }),
  }),
  [IMAGE_GEN_MODE.HIGGSFIELD]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.HIGGSFIELD],
    label: 'Higgsfield Imagegen',
    errorCode: 'HIGGSFIELD_IMAGEGEN_DISABLED',
    knownModels: HIGGSFIELD_IMAGE_MODEL_IDS,
    unknownModelCode: 'HIGGSFIELD_IMAGE_MODEL_UNKNOWN',
    modelId: higgsfieldModelFrom,
    // No key: queue params persist in plaintext, so the provider re-resolves it at dispatch.
    params: (c, override) => ({ model: higgsfieldModelFrom(c, override) }),
  }),
  [IMAGE_GEN_MODE.GOOGLE]: Object.freeze({
    ...IMAGE_GEN_PROVIDER_CAPABILITIES[IMAGE_GEN_MODE.GOOGLE],
    label: 'Google Imagegen',
    errorCode: 'GOOGLE_IMAGEGEN_DISABLED',
    knownModels: GOOGLE_IMAGE_MODEL_IDS,
    unknownModelCode: 'GOOGLE_IMAGE_MODEL_UNKNOWN',
    modelId: googleModelFrom,
    // No credential: queue params persist in plaintext, so the provider re-resolves it at dispatch.
    params: (c, override) => ({ model: googleModelFrom(c, override) }),
  }),
});

/**
 * Resolve a cloud-CLI provider's settings slice into everything a call site needs.
 * Returns `null` for non-cloud modes (local / external).
 *
 * Shape:
 *  - `enabled`        — the settings toggle (strict boolean).
 *  - `config`         — the raw `settings.imageGen[mode]` slice (never null).
 *  - `modelId`        — effective model id for response/queue metadata.
 *  - `providerParams` — knob bundle WITHOUT `mode` (direct provider calls).
 *  - `jobParams`      — `{ mode, ...providerParams }` for `enqueueJob`, where `mode`
 *                       is the queue's lane discriminator.
 *  - `modelIsShippedDefault` — whether `modelId` is PortOS's shipped pin rather than a
 *                       choice, for providers that re-point a retired shipped default
 *                       (agy). Always false elsewhere.
 *  - `disabledError`  — a ready-to-throw ServerError (null when enabled).
 *  - `disabledReason` — `'<mode>-disabled'`, for callers that skip silently.
 *  - `connectionReason` — reason string for `checkConnection` responses.
 *
 * `overrides.model` is the per-render model id (the request's `cloudModel`).
 * `overrides.modelIsShippedDefault` is its PROVENANCE, set only by a caller
 * re-resolving an id this resolver already produced from the shipped default
 * (see `prepareParams.js`); ignored without an override. Overrides apply only to
 * providers whose spec sets `supportsModelOverride`. Blank/whitespace means
 * "inherit the saved default", so a cleared UI select doesn't pin an empty id.
 */
export function resolveCloudProviderConfig(settings, mode, overrides = {}) {
  const spec = CLOUD_PROVIDER_SPECS[mode];
  if (!spec) return null;
  const config = settings?.imageGen?.[mode] || {};
  const enabled = config.enabled === true;
  const requestedModel = typeof overrides.model === 'string' ? overrides.model.trim() : '';
  const modelOverride = spec.supportsModelOverride && requestedModel ? requestedModel : null;
  if (modelOverride && spec.knownModels && !spec.knownModels.includes(modelOverride)) {
    throw new ServerError(
      `${spec.label} has no model "${modelOverride}" — choose one of: ${spec.knownModels.join(', ')}`,
      { status: 400, code: spec.unknownModelCode },
    );
  }
  // Only meaningful alongside an override, so a stray marker can never invent
  // provenance for a user's pin.
  const overrideIsShippedDefault = Boolean(modelOverride) && overrides.modelIsShippedDefault === true;
  const providerParams = spec.params(config, modelOverride, overrideIsShippedDefault);
  return {
    mode,
    config,
    enabled,
    supportsModelOverride: spec.supportsModelOverride === true,
    modelOverride,
    // Re-surfaced at the top level so a caller threading this bundle's model onward can
    // thread its provenance without reaching into `providerParams`.
    modelIsShippedDefault: providerParams.modelIsShippedDefault === true,
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
 * Resolve one surface's image render config through the render-target ladder:
 * per-request/per-record override → the target's saved `renderDefaults` pin → the
 * install-wide `settings.imageGen.mode` → the caller's own fallback. Every creative
 * surface resolves through THIS (server/test/guards/modules/imageGenRenderTargets.test.js fails a direct
 * `resolveCloudProviderConfig` call outside the dispatcher) so the target's saved
 * `imageModel` reaches the provider.
 *
 * Options:
 *  - `mode`        — the surface's per-request mode override. Wins over every pin.
 *  - `model`       — per-request cloud model override. Wins over every pin.
 *  - `recordMode`  — the owning record's persisted backend pin (normalized via
 *                    `recordRenderPin`). Sits between the per-request override and the
 *                    target's `renderDefaults` pin, and is usability-gated like the
 *                    target pin (a since-disabled backend degrades instead of bricking
 *                    the record's renders).
 *  - `recordModel` — the record's persisted model pin. Rides only when the resolved
 *                    mode is the record's pinned backend (same leak guard as the
 *                    target's model pin).
 *  - `fallbackMode`— the surface's final fallback when nothing else resolves. Surfaces
 *                    with their own usability ladder resolve mode first and pass it as
 *                    `mode` here for model threading, keeping `recordMode`/`recordModel`
 *                    so the leak guard knows which backend the record pinned.
 *
 * `usableInstallFallback` opts inherited browser renders into a usable install
 * fallback; batch callers retain their disabled-provider skip contract.
 *
 * Returns `{ mode, cloud, modelCandidates }` — `cloud` is the resolveCloudProviderConfig
 * bundle (null for non-cloud modes), with the layered model threaded through.
 */
export function resolveRenderTargetConfig(settings, target, {
  mode = null,
  model = null,
  recordMode = null,
  recordModel = null,
  fallbackMode = null,
  usableInstallFallback = false,
} = {}) {
  const resolved = resolveRenderTargetPins(settings, target, {
    mode, model, recordMode, recordModel, fallbackMode, usableInstallFallback,
  });
  return {
    mode: resolved.mode,
    modelCandidates: resolved.modelCandidates,
    cloud: resolveCloudProviderConfig(settings, resolved.mode, { model: resolved.modelId }),
  };
}
