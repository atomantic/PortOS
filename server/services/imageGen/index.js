/**
 * Image Gen — Mode-aware dispatcher.
 *
 * Reads settings.imageGen.mode (default 'external' for backward compat) and
 * routes generate/status calls to either the external SD-API client or the
 * local (mflux/diffusers) backend. This module is the public entrypoint —
 * routes/imageGen.js, the A1111 proxy, and the CoS tools registry all go
 * through here so the underlying provider is interchangeable.
 */

import { getSettings } from '../settings.js';
import * as external from './external.js';
import * as local from './local.js';

const DEFAULT_MODE = 'external';

const cfg = (s) => s?.imageGen || {};
const sdapiUrl = (s) => cfg(s).external?.sdapiUrl || cfg(s).sdapiUrl || null;
const pythonPath = (s) => cfg(s).local?.pythonPath || null;

export async function getMode() {
  const s = await getSettings();
  return cfg(s).mode || DEFAULT_MODE;
}

export async function checkConnection() {
  const s = await getSettings();
  const mode = cfg(s).mode || DEFAULT_MODE;
  if (mode === 'local') {
    const py = pythonPath(s);
    if (!py) return { connected: false, mode, reason: 'Python path not configured' };
    return { connected: true, mode, model: 'mflux/local', pythonPath: py };
  }
  const status = await external.checkConnection(sdapiUrl(s));
  return { ...status, mode };
}

export async function generateImage(params) {
  const s = await getSettings();
  const mode = cfg(s).mode || DEFAULT_MODE;
  // Param normalization: A1111 clients (and the /sdapi/v1/txt2img bridge)
  // send `cfgScale`; local mflux reads `guidance`. Map cfgScale -> guidance
  // when guidance is not explicitly set so both spellings work in both modes.
  const normalized = { ...params };
  if (normalized.guidance == null && normalized.cfgScale != null) {
    normalized.guidance = normalized.cfgScale;
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

// Snapshot of any in-flight generation across both modes — lets the UI
// rehydrate prompt + settings + progress + last frame after navigating away
// during a render.
export async function getActiveJob() {
  return local.getActiveJob() || external.getActiveJob() || null;
}

// Re-exports so routes can hit the local backend directly when the request
// is shape-specific (SSE attach, gallery, LoRAs). The dispatcher is for the
// generic generate/status flow used by both modes.
export { local, external };
