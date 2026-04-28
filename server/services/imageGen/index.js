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

export const IMAGE_GEN_MODES = Object.freeze(['external', 'local', 'codex']);
const DEFAULT_MODE = 'external';

const cfg = (s) => s?.imageGen || {};
const sdapiUrl = (s) => cfg(s).external?.sdapiUrl || cfg(s).sdapiUrl || null;
const pythonPath = (s) => cfg(s).local?.pythonPath || null;
const codexCfg = (s) => cfg(s).codex || {};

export async function getMode() {
  const s = await getSettings();
  return cfg(s).mode || DEFAULT_MODE;
}

export async function checkConnection({ mode: modeOverride } = {}) {
  const s = await getSettings();
  const mode = modeOverride || cfg(s).mode || DEFAULT_MODE;
  if (mode === 'local') {
    const py = pythonPath(s);
    if (!py) return { connected: false, mode, reason: 'Python path not configured' };
    return { connected: true, mode, model: 'mflux/local', pythonPath: py };
  }
  if (mode === 'codex') {
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
  if (mode === 'codex') {
    const c = codexCfg(s);
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    return codex.generateImage({ codexPath: c.codexPath, model: c.model, ...normalized });
  }
  if (mode === 'local') {
    return local.generateImage({ pythonPath: pythonPath(s), ...normalized });
  }
  return external.generateImage({ sdapiUrl: sdapiUrl(s), ...normalized });
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
// during a render.
export async function getActiveJob() {
  return local.getActiveJob() || external.getActiveJob() || codex.getActiveJob() || null;
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
  // Each provider enforces its own single-job invariant independently, so
  // both can have a job in flight simultaneously. Cancel them all and
  // return whether anything was actually cancelled — short-circuiting on
  // the first hit would orphan a codex job whenever local is active.
  const localCancelled = local.cancel();
  const codexCancelled = codex.cancel();
  return localCancelled || codexCancelled;
};

// Re-exports so routes can hit a specific backend directly when the request
// is shape-specific (gallery, LoRAs). The dispatcher is for the generic
// generate/status flow used by all modes.
export { local, external, codex };
