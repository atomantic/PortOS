/**
 * Image Generation Service
 *
 * Handles communication with Stable Diffusion API (AUTOMATIC1111 / Forge WebUI).
 * Generated images are stored in data/images/.
 * Streams diffusion progress via Socket.IO during generation.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getSettings } from './settings.js';
import { imageGenEvents } from './imageGenEvents.js';

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';

// Cache detected model to avoid extra HTTP round-trip per generation
let cachedModel = { name: null, timestamp: 0 };
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const PROGRESS_POLL_INTERVAL = 500; // ms between progress polls

async function getSdApiUrl() {
  const settings = await getSettings();
  return settings.imageGen?.sdapiUrl || null;
}

async function detectModel(baseUrl) {
  if (cachedModel.name && Date.now() - cachedModel.timestamp < MODEL_CACHE_TTL) {
    return cachedModel.name;
  }
  const res = await fetchWithTimeout(`${baseUrl}/sdapi/v1/options`, {}, 10000).catch(() => null);
  if (!res?.ok) return 'unknown';
  const options = await res.json().catch(() => null);
  const model = options?.sd_model_checkpoint || 'unknown';
  cachedModel = { name: model, timestamp: Date.now() };
  return model;
}

export async function checkConnection() {
  const baseUrl = await getSdApiUrl();
  if (!baseUrl) return { connected: false, reason: 'No SD API URL configured' };

  // Always make a live request for status checks — bypass the model cache
  const res = await fetchWithTimeout(`${baseUrl}/sdapi/v1/options`, {}, 10000).catch(() => null);
  if (!res?.ok) return { connected: false, reason: 'SD API unreachable' };
  const options = await res.json().catch(() => null);
  const model = options?.sd_model_checkpoint || 'unknown';
  // Update the cache while we're at it
  cachedModel = { name: model, timestamp: Date.now() };
  return { connected: true, model };
}

const IMAGE_PREVIEW_THROTTLE = 2000; // only send base64 previews every 2s

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

      // Only emit if progress actually changed
      const progress = Math.round(data.progress * 100);
      if (progress === lastProgress) return;
      lastProgress = progress;

      // Throttle base64 preview images to reduce bandwidth
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
    } finally {
      inFlight = false;
    }
  }, PROGRESS_POLL_INTERVAL);

  return () => clearInterval(interval);
}

export async function generateImage({ prompt, negativePrompt, width, height, steps, cfgScale, seed }) {
  const baseUrl = await getSdApiUrl();
  if (!baseUrl) throw new Error('No SD API URL configured — set it in Settings > Image Gen');

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
  console.log(`🎨 Generating image [${generationId.slice(0, 8)}]: ${prompt.slice(0, 80)}... (${payload.width}x${payload.height}, ${payload.steps} steps)`);

  imageGenEvents.emit('started', {
    generationId,
    prompt: prompt.slice(0, 200),
    totalSteps: payload.steps
  });

  // Start polling progress in background
  const stopPolling = startProgressPolling(baseUrl, generationId);

  let res;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/sdapi/v1/txt2img`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      300000
    );
  } catch (err) {
    stopPolling();
    imageGenEvents.emit('failed', { generationId, error: 'Network error contacting image generation service' });
    throw err;
  }
  stopPolling();

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    imageGenEvents.emit('failed', { generationId, error: `SD API error ${res.status}` });
    throw new Error(`SD API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.images?.length) {
    imageGenEvents.emit('failed', { generationId, error: 'No images returned' });
    throw new Error('SD API returned no images');
  }

  await ensureDir(PATHS.images);
  const filename = `${randomUUID()}.png`;
  await writeFile(join(PATHS.images, filename), Buffer.from(data.images[0], 'base64'));

  const path = `/data/images/${filename}`;
  console.log(`🖼️ Image saved: ${filename}`);

  imageGenEvents.emit('completed', { generationId, path, filename });
  return { generationId, filename, path };
}

export async function generateAvatar({ name, characterClass, prompt }) {
  const defaultPrompt = `fantasy portrait of ${name || 'an adventurer'}, ${characterClass || 'warrior'} class, D&D character art, detailed, dramatic lighting, painterly style`;
  return generateImage({
    prompt: prompt || defaultPrompt,
    width: 512,
    height: 512,
    negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, nude, nsfw`
  });
}
