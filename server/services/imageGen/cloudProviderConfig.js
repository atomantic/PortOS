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
import {
  CLOUD_IMAGE_GEN_MODES,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  IMAGE_GEN_MODE,
  QUEUEABLE_IMAGE_MODES,
} from './modes.js';

/**
 * Per-provider knowledge, keyed by mode:
 *  - `label`      — user-facing provider name used in every disabled message.
 *  - `modelId`    — the *effective* model id for display/metadata (codex
 *                   defaults to the cheap tier; grok's backend is fixed).
 *  - `params`     — the provider's knob bundle for a queue job / direct call.
 *                   Codex's `model` carries the effective (defaulted) id so the
 *                   queue row reports what actually renders; the provider
 *                   re-applies the same default, so rendering is unchanged.
 */
export const CLOUD_PROVIDER_SPECS = Object.freeze({
  [IMAGE_GEN_MODE.CODEX]: Object.freeze({
    label: 'Codex Imagegen',
    errorCode: 'CODEX_IMAGEGEN_DISABLED',
    modelId: (c) => c.model || CODEX_IMAGEGEN_DEFAULT_MODEL,
    params: (c) => ({ codexPath: c.codexPath, model: c.model || CODEX_IMAGEGEN_DEFAULT_MODEL, effort: c.effort }),
  }),
  [IMAGE_GEN_MODE.GROK]: Object.freeze({
    label: 'Grok Imagegen',
    errorCode: 'GROK_IMAGEGEN_DISABLED',
    // Grok's image tools run on xAI's fixed image backend — no model knob.
    modelId: () => 'grok-imagegen',
    params: (g) => ({ grokPath: g.grokPath, aspectRatio: g.aspectRatio }),
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
 */
export function resolveCloudProviderConfig(settings, mode) {
  const spec = CLOUD_PROVIDER_SPECS[mode];
  if (!spec) return null;
  const config = settings?.imageGen?.[mode] || {};
  const enabled = config.enabled === true;
  const providerParams = spec.params(config);
  return {
    mode,
    config,
    enabled,
    modelId: spec.modelId(config),
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
 */
export function isModeUsable(settings, mode) {
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) return false;
  const cloud = resolveCloudProviderConfig(settings, mode);
  return cloud ? cloud.enabled : true;
}

/**
 * First usable mode from an ordered candidate list, falling back to the
 * cloud providers (in `CLOUD_IMAGE_GEN_MODES` order) and finally local.
 */
export function pickUsableMode(settings, candidates = []) {
  const ordered = [...candidates, ...CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE.LOCAL];
  return ordered.find((m) => m && isModeUsable(settings, m)) || IMAGE_GEN_MODE.LOCAL;
}
