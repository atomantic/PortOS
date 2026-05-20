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
import { ServerError } from '../../lib/errorHandler.js';
import * as external from './external.js';
import * as local from './local.js';
import * as codex from './codex.js';
import { IMAGE_GEN_MODE, IMAGE_GEN_MODES } from './modes.js';

// Re-export the enum + array so the existing import surface from this module
// keeps working. `IMAGE_GEN_MODE.X` is the preferred form at dispatch sites
// (server + client); `IMAGE_GEN_MODES` is the alphabet for Zod / OpenAI
// tool-spec enums. Defined in `./modes.js` to avoid a circular import with
// the provider modules above.
export { IMAGE_GEN_MODE, IMAGE_GEN_MODES };
const DEFAULT_MODE = IMAGE_GEN_MODE.EXTERNAL;

const cfg = (s) => s?.imageGen || {};
const sdapiUrl = (s) => cfg(s).external?.sdapiUrl || cfg(s).sdapiUrl || null;
const pythonPath = (s) => cfg(s).local?.pythonPath || null;
const codexCfg = (s) => cfg(s).codex || {};

// Body wins when explicit (per-render checkbox); otherwise inherit the saved
// per-mode default. Shared by `/generate` (stamps the resolved value onto the
// request so all three dispatch paths agree) and `generateImage()` (safety net
// for direct callers like `generateAvatar`).
export function resolveAutoClean(bodyValue, settings, mode) {
  if (typeof bodyValue === 'boolean') return bodyValue;
  return cfg(settings)[mode]?.autoClean === true;
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
  if (mode === IMAGE_GEN_MODE.CODEX) {
    const c = codexCfg(s);
    if (!c.enabled) return { connected: false, mode, reason: 'Codex Imagegen is disabled in settings' };
    return codex.checkConnection({ codexPath: c.codexPath });
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
  // i2i is supported by local (mflux/diffusers --image-path) and codex
  // (gpt-image-2 image-edit via codex CLI's -i flag). External SD-API has no
  // i2i wiring in this codebase, so drop the init image there rather than
  // failing the whole render — the prompt still produces a useful txt2img.
  if (mode === IMAGE_GEN_MODE.EXTERNAL && (normalized.initImagePath || normalized.initImageStrength != null)) {
    delete normalized.initImagePath;
    delete normalized.initImageStrength;
  }
  // Auto-clean is per-provider-mode, opt-in. The route layer already resolves
  // this so the queue/route paths agree, but resolve here too for direct
  // callers (e.g. `generateAvatar`) that skip the route. Strip from
  // `normalized` so the explicit arg on each provider call isn't shadowed by
  // the spread.
  const autoClean = resolveAutoClean(normalized.autoClean, s, mode);
  delete normalized.autoClean;
  if (mode === IMAGE_GEN_MODE.CODEX) {
    const c = codexCfg(s);
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    return codex.generateImage({ codexPath: c.codexPath, model: c.model, autoClean, ...normalized });
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    return local.generateImage({ pythonPath: pythonPath(s), autoClean, ...normalized });
  }
  return external.generateImage({ sdapiUrl: sdapiUrl(s), autoClean, ...normalized });
}

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';

export async function generateAvatar({ name, characterClass, prompt }) {
  const defaultPrompt = `fantasy portrait of ${name || 'an adventurer'}, ${characterClass || 'warrior'} class, D&D character art, detailed, dramatic lighting, painterly style`;
  return generateImage({
    prompt: prompt || defaultPrompt,
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
  const jobs = [local.getActiveJob(), external.getActiveJob(), codex.getActiveJob()].filter(Boolean);
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
  return false;
};

export const cancel = () => {
  // The "stop everything" dispatcher — invoked by routes/imageGen.js's
  // `/cancel` fallback when no specific jobId or queue entry is targeted.
  // local has at most one in-flight, codex can have N (parallel lane), so
  // codex's bulk variant is the right one here. Return whether anything
  // was actually cancelled — short-circuiting on the first hit would
  // orphan a codex job whenever local is also active.
  const localCancelled = local.cancel();
  const codexCancelled = codex.cancelAll();
  return localCancelled || codexCancelled;
};

// Re-exports so routes can hit a specific backend directly when the request
// is shape-specific (gallery, LoRAs). The dispatcher is for the generic
// generate/status flow used by all modes.
export { local, external, codex };
