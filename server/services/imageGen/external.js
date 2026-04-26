/**
 * Image Gen — External provider.
 *
 * Talks to a remote AUTOMATIC1111 / Forge WebUI over its /sdapi/v1/* surface.
 * Used when settings.imageGen.mode === 'external' and a sdapiUrl is configured.
 * Streams diffusion progress to imageGenEvents (bridged to Socket.IO).
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { imageGenEvents } from '../imageGenEvents.js';

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';
const PROGRESS_POLL_INTERVAL = 500;
const IMAGE_PREVIEW_THROTTLE = 2000;
const MODEL_CACHE_TTL = 5 * 60 * 1000;

let cachedModel = { name: null, timestamp: 0, baseUrl: null };

export function validateSdUrl(rawUrl) {
  if (!rawUrl) throw new ServerError('No SD API URL configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  let url;
  try { url = new URL(rawUrl); } catch { throw new ServerError('Invalid SD API URL — must be a valid http/https URL', { status: 400, code: 'INVALID_SD_URL' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerError('Invalid SD API URL — only http and https are allowed', { status: 400, code: 'INVALID_SD_URL' });
  }
  return url.origin;
}

async function detectModel(baseUrl) {
  if (cachedModel.name && cachedModel.baseUrl === baseUrl && Date.now() - cachedModel.timestamp < MODEL_CACHE_TTL) {
    return cachedModel.name;
  }
  const res = await fetchWithTimeout(`${baseUrl}/sdapi/v1/options`, {}, 10000).catch(() => null);
  if (!res?.ok) return 'unknown';
  const options = await res.json().catch(() => null);
  const model = options?.sd_model_checkpoint || 'unknown';
  cachedModel = { name: model, timestamp: Date.now(), baseUrl };
  return model;
}

export async function checkConnection(sdapiUrl) {
  if (!sdapiUrl) return { connected: false, reason: 'No SD API URL configured' };
  let baseUrl;
  try { baseUrl = validateSdUrl(sdapiUrl); } catch (err) { return { connected: false, reason: err.message }; }

  const res = await fetchWithTimeout(`${baseUrl}/sdapi/v1/options`, {}, 10000).catch(() => null);
  if (!res?.ok) return { connected: false, reason: 'SD API unreachable' };
  const options = await res.json().catch(() => null);
  const model = options?.sd_model_checkpoint || 'unknown';
  cachedModel = { name: model, timestamp: Date.now(), baseUrl };
  return { connected: true, model, mode: 'external', baseUrl };
}

function startProgressPolling(baseUrl, generationId) {
  let lastProgress = -1;
  let lastImageEmit = 0;
  let inFlight = false;
  const interval = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetchWithTimeout(`${baseUrl}/sdapi/v1/progress`, {}, 5000).catch(() => null);
      if (!res?.ok) return;
      const data = await res.json().catch(() => null);
      if (!data) return;

      const progress = Math.round(data.progress * 100);
      if (progress === lastProgress) return;
      lastProgress = progress;

      const now = Date.now();
      const includeImage = data.current_image && (now - lastImageEmit >= IMAGE_PREVIEW_THROTTLE);
      if (includeImage) lastImageEmit = now;

      imageGenEvents.emit('progress', {
        generationId,
        progress: data.progress,
        eta: data.eta_relative,
        step: data.state?.sampling_step,
        totalSteps: data.state?.sampling_steps,
        currentImage: includeImage ? data.current_image : null
      });
      if (activeJob && activeJob.generationId === generationId) {
        activeJob.progress = data.progress;
        activeJob.step = data.state?.sampling_step ?? activeJob.step;
        activeJob.totalSteps = data.state?.sampling_steps ?? activeJob.totalSteps;
        if (includeImage) activeJob.currentImage = data.current_image;
      }
    } finally {
      inFlight = false;
    }
  }, PROGRESS_POLL_INTERVAL);

  return () => clearInterval(interval);
}

let activeJob = null;
export const getActiveJob = () => activeJob;

export async function generateImage({ sdapiUrl, prompt, negativePrompt, width, height, steps, cfgScale, seed }) {
  const baseUrl = validateSdUrl(sdapiUrl);
  const model = await detectModel(baseUrl);
  const isFlux = model?.toLowerCase().includes('flux');

  const payload = {
    prompt,
    negative_prompt: negativePrompt || DEFAULT_NEGATIVE_PROMPT,
    steps: steps || (isFlux ? 15 : 25),
    width: width || (isFlux ? 832 : 512),
    height: height || (isFlux ? 1216 : 768),
    cfg_scale: cfgScale ?? (isFlux ? 1 : 7),
    sampler_name: isFlux ? 'Euler' : 'Euler a',
    ...(isFlux && { scheduler: 'simple' }),
    batch_size: 1,
    ...(seed != null && seed >= 0 && { seed })
  };

  const generationId = randomUUID();
  console.log(`🎨 Generating image [${generationId.slice(0, 8)}] external→${baseUrl}: ${prompt.slice(0, 60)}... (${payload.width}x${payload.height}, ${payload.steps} steps)`);
  imageGenEvents.emit('started', { generationId, totalSteps: payload.steps });
  activeJob = {
    generationId, prompt, negativePrompt,
    width: payload.width, height: payload.height, steps: payload.steps,
    cfgScale: payload.cfg_scale, seed: payload.seed,
    modelId: model, mode: 'external',
    step: 0, progress: 0, totalSteps: payload.steps, currentImage: null,
    createdAt: new Date().toISOString(),
  };

  const stopPolling = startProgressPolling(baseUrl, generationId);

  let res;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/sdapi/v1/txt2img`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      300000
    );
  } catch (err) {
    stopPolling();
    activeJob = null;
    imageGenEvents.emit('failed', { generationId, error: 'Network error contacting image generation service' });
    throw err;
  }
  stopPolling();

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    activeJob = null;
    imageGenEvents.emit('failed', { generationId, error: `SD API error ${res.status}` });
    throw new Error(`SD API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.images?.length) {
    activeJob = null;
    imageGenEvents.emit('failed', { generationId, error: 'No images returned' });
    throw new Error('SD API returned no images');
  }

  await ensureDir(PATHS.images);
  const filename = `${randomUUID()}.png`;
  await writeFile(join(PATHS.images, filename), Buffer.from(data.images[0], 'base64'));
  const path = `/data/images/${filename}`;
  console.log(`🖼️ Image saved: ${filename}`);
  activeJob = null;
  imageGenEvents.emit('completed', { generationId, path, filename });
  return { generationId, filename, path, mode: 'external', model };
}
