/**
 * Image Gen — Mode-aware dispatcher.
 *
 * Reads settings.imageGen.mode (default 'external' for backward compat) and
 * routes generate/status calls to one of three providers: external SD-API,
 * local mflux/diffusers, or the Codex CLI built-in image_gen tool.
 *
 * Per-request mode override: callers (the route, the voice tool) may pass
 * `params.mode` to force a specific backend without changing the saved
 * default. The Codex backend is also user-gated — even with `mode: 'codex'`
 * we refuse unless `imageGen.codex.enabled` is true, because that toggle
 * exists for users whose Codex plan doesn't expose the image_gen tool.
 */

import { getSettings } from '../settings.js';
import { resolveCleanersFromConfig } from '../../lib/imageClean.js';
import * as external from './external.js';
import * as local from './local.js';
import * as codex from './codex.js';
import * as grok from './grok.js';
import { IMAGE_GEN_MODE, IMAGE_GEN_MODES, CLOUD_IMAGE_GEN_MODES } from './modes.js';
import { resolveCloudProviderConfig } from './cloudProviderConfig.js';

// Cloud-CLI provider modules keyed by mode, so the shared gate in
// checkConnection/generateImage dispatches without a per-provider branch.
const CLOUD_PROVIDERS = { [IMAGE_GEN_MODE.CODEX]: codex, [IMAGE_GEN_MODE.GROK]: grok };

// Re-export the enum + array so the existing import surface from this module
// keeps working. `IMAGE_GEN_MODE.X` is the preferred form at dispatch sites
// (server + client); `IMAGE_GEN_MODES` is the alphabet for Zod / OpenAI
// tool-spec enums. Defined in `./modes.js` to avoid a circular import with
// the provider modules above.
export { IMAGE_GEN_MODE, IMAGE_GEN_MODES, CLOUD_IMAGE_GEN_MODES };
const DEFAULT_MODE = IMAGE_GEN_MODE.EXTERNAL;

const cfg = (s) => s?.imageGen || {};
const sdapiUrl = (s) => cfg(s).external?.sdapiUrl || cfg(s).sdapiUrl || null;
const pythonPath = (s) => cfg(s).local?.pythonPath || null;

// Resolve the cleaner flags from body overrides + saved per-mode settings.
// Body fields win when explicit (per-render checkbox); otherwise inherit
// the saved per-mode defaults via `resolveCleanersFromConfig`. Shared by
// `/generate` and `generateImage()` (safety net for direct callers like
// `generateAvatar`).
export function resolveImageCleaners(body, settings, mode) {
  const saved = resolveCleanersFromConfig(cfg(settings)[mode], mode);
  return {
    cleanC2PA: typeof body?.cleanC2PA === 'boolean' ? body.cleanC2PA : saved.cleanC2PA,
    denoise: typeof body?.denoise === 'boolean' ? body.denoise : saved.denoise,
  };
}

export async function getMode() {
  const s = await getSettings();
  return cfg(s).mode || DEFAULT_MODE;
}

export async function checkConnection({ mode: modeOverride } = {}) {
  const s = await getSettings();
  const mode = modeOverride || cfg(s).mode || DEFAULT_MODE;
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    const py = pythonPath(s);
    if (!py) return { connected: false, mode, reason: 'Python path not configured' };
    return { connected: true, mode, model: 'mflux/local', pythonPath: py };
  }
  const cloudCheck = resolveCloudProviderConfig(s, mode);
  if (cloudCheck) {
    if (!cloudCheck.enabled) return { connected: false, mode, reason: cloudCheck.connectionReason };
    return CLOUD_PROVIDERS[mode].checkConnection(cloudCheck.providerParams);
  }
  const status = await external.checkConnection(sdapiUrl(s));
  return { ...status, mode };
}

export async function generateImage(params) {
  const s = await getSettings();
  const requestedMode = params?.mode;
  const mode = requestedMode || cfg(s).mode || DEFAULT_MODE;
  // Param normalization: A1111 clients (and the /sdapi/v1/txt2img bridge)
  // send `cfgScale`; local mflux reads `guidance`. Map cfgScale -> guidance
  // when guidance is not explicitly set so both spellings work in both modes.
  const normalized = { ...params };
  if (normalized.guidance == null && normalized.cfgScale != null) {
    normalized.guidance = normalized.cfgScale;
  }
  // Strip the dispatcher-only `mode` field — providers don't expect it.
  delete normalized.mode;
  // i2i is supported by local (mflux/diffusers --image-path), codex
  // (gpt-image-2 image-edit via codex CLI's -i flag), and grok (image_edit).
  // External SD-API has no i2i wiring in this codebase, so drop the init
  // image there rather than failing the whole render — the prompt still
  // produces a useful txt2img.
  if (mode === IMAGE_GEN_MODE.EXTERNAL && (normalized.initImagePath || normalized.initImageStrength != null)) {
    delete normalized.initImagePath;
    delete normalized.initImageStrength;
  }
  // Cleaners are per-provider-mode. The route layer already resolves them so
  // the queue/route paths agree, but resolve here too for direct callers
  // (e.g. `generateAvatar`) that skip the route. Strip from `normalized`
  // so the explicit args on each provider call aren't shadowed by the spread.
  const { cleanC2PA, denoise } = resolveImageCleaners(normalized, s, mode);
  delete normalized.cleanC2PA;
  delete normalized.denoise;
  delete normalized.autoClean; // legacy body field — accept-and-ignore
  // Cloud CLIs (codex, grok) share one gate + param bundle — the per-provider
  // knobs (codexPath/model/effort vs grokPath/aspectRatio) come from the
  // resolver's spec, so a saved override always wins over the provider's own
  // internal defaults.
  const cloud = resolveCloudProviderConfig(s, mode);
  if (cloud) {
    if (!cloud.enabled) throw cloud.disabledError;
    return CLOUD_PROVIDERS[mode].generateImage({ ...cloud.providerParams, cleanC2PA, denoise, ...normalized });
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    return local.generateImage({ pythonPath: pythonPath(s), cleanC2PA, denoise, ...normalized });
  }
  return external.generateImage({ sdapiUrl: sdapiUrl(s), cleanC2PA, denoise, ...normalized });
}

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';

// Build the default avatar prompt for the human-centered Character surface (#2677).
// The Character page portrays the real human user, so a blank identity must NOT
// fall back to the old generic D&D adventurer/warrior prompt: an empty name/class
// yields a neutral human portrait, and any provided identity fields shape a
// photographic (not fantasy) prompt. Callers that genuinely want a fantasy/RPG
// avatar pass an explicit `prompt` to opt out of this default.
export function buildAvatarPrompt({ name, characterClass } = {}) {
  const descriptors = [name, characterClass]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .join(', ');
  const subject = descriptors ? `portrait of ${descriptors}` : 'portrait of a person';
  return `${subject}, photographic, natural lighting, detailed, high quality`;
}

export async function generateAvatar({ name, characterClass, prompt }) {
  return generateImage({
    prompt: prompt || buildAvatarPrompt({ name, characterClass }),
    width: 512,
    height: 512,
    negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, nude, nsfw`,
  });
}

// Snapshot of any in-flight generation across all modes — lets the UI
// rehydrate prompt + settings + progress + last frame after navigating away
// during a render. Each provider enforces its own single-job invariant
// (cancel() relies on this — see the note there), so up to three jobs can
// be in flight concurrently. Return the most-recently-started one based on
// `createdAt`, falling back to provider order if timestamps are missing.
// Callers wanting all of them can read individual providers via the
// re-exports below.
export async function getActiveJob() {
  const jobs = [local.getActiveJob(), external.getActiveJob(), codex.getActiveJob(), grok.getActiveJob()].filter(Boolean);
  if (!jobs.length) return null;
  return jobs.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  })[0];
}

// Try-each-provider SSE attach + cancel — the route only knows the jobId,
// not which backend produced it, so we ask each provider in turn and let
// the first one that owns the job handle the attach.
export const attachSseClient = (jobId, res) => {
  if (local.attachSseClient(jobId, res)) return true;
  if (codex.attachSseClient(jobId, res)) return true;
  if (grok.attachSseClient(jobId, res)) return true;
  return false;
};

export const cancel = () => {
  // The "stop everything" dispatcher — invoked by routes/imageGen.js's
  // `/cancel` fallback when no specific jobId or queue entry is targeted.
  // local has at most one in-flight, codex/grok can have N (parallel cloud
  // lane), so their bulk variants are the right ones here. Return whether
  // anything was actually cancelled — short-circuiting on the first hit
  // would orphan a cloud job whenever local is also active.
  const localCancelled = local.cancel();
  const codexCancelled = codex.cancelAll();
  const grokCancelled = grok.cancelAll();
  return localCancelled || codexCancelled || grokCancelled;
};

// Re-exports so routes can hit a specific backend directly when the request
// is shape-specific (gallery, LoRAs). The dispatcher is for the generic
// generate/status flow used by all modes.
export { local, external, codex, grok };
