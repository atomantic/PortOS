/**
 * Image Generation Service
 *
 * Handles communication with Stable Diffusion API (AUTOMATIC1111 / Forge WebUI).
 * Generated images are stored in data/images/.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getSettings } from './settings.js';

const DEFAULT_NEGATIVE_PROMPT = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';

// Cache detected model to avoid extra HTTP round-trip per generation
let cachedModel = { name: null, timestamp: 0 };
const MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

  const model = await detectModel(baseUrl);
  if (model === 'unknown' && !cachedModel.timestamp) {
    return { connected: false, reason: 'SD API unreachable' };
  }
  return { connected: true, model };
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

  console.log(`🎨 Generating image: ${prompt.slice(0, 80)}... (${payload.width}x${payload.height}, ${payload.steps} steps)`);

  const res = await fetchWithTimeout(
    `${baseUrl}/sdapi/v1/txt2img`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    },
    300000
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`SD API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.images?.length) throw new Error('SD API returned no images');

  await ensureDir(PATHS.images);
  const filename = `${randomUUID()}.png`;
  await writeFile(join(PATHS.images, filename), Buffer.from(data.images[0], 'base64'));

  console.log(`🖼️ Image saved: ${filename}`);
  return { filename, path: `/data/images/${filename}` };
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
