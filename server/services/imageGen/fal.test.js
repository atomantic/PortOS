import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

const TEST_ROOT = join(tmpdir(), `portos-fal-image-test-${process.pid}-${Date.now()}`);
const FAKE_IMAGES_DIR = join(TEST_ROOT, 'data-images');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.images = FAKE_IMAGES_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: getSettingsMock }));

const fal = await import('./fal.js');
const { imageGenEvents } = await import('../imageGenEvents.js');

const QUEUE = 'https://queue.fal.run';
const CDN_URL = 'https://cdn.example.com/out';

// A frame with real content — the degenerate-frame guard rejects flat canvases.
const noiseImage = (width, height, format = 'png') => {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 7) * 91) % 256;
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  return (format === 'jpeg' ? img.jpeg() : img.png()).toBuffer();
};

const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const binaryResponse = (buf) => ({
  ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});

/**
 * A scripted fal.ai: records every call, answers the submit with a receipt,
 * the status poll from `statuses` (last one repeats), the response URL with an
 * images[] result, and the CDN with `output` bytes.
 */
const fakeFal = ({ endpoint, statuses = ['COMPLETED'], output, result = {}, onStatus } = {}) => {
  const calls = [];
  const requestBase = `${QUEUE}/${endpoint}/requests/req-1`;
  let statusIndex = 0;
  const fetchMock = vi.fn(async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (url === `${QUEUE}/${endpoint}` && opts.method === 'POST') {
      return jsonResponse({
        request_id: 'req-1', status_url: `${requestBase}/status`, response_url: requestBase, cancel_url: `${requestBase}/cancel`,
      });
    }
    if (url === `${requestBase}/status`) {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      await onStatus?.(status);
      return jsonResponse(typeof status === 'string' ? { status } : status);
    }
    if (url === `${requestBase}/cancel`) return jsonResponse({});
    if (url === requestBase) return jsonResponse({ images: [{ url: CDN_URL }], ...result });
    if (url === CDN_URL) return binaryResponse(output);
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, submits: () => calls.filter((c) => c.method === 'POST') };
};

const terminal = new Map();
const waitForTerminal = async (jobId) => {
  await vi.waitFor(() => expect(terminal.get(jobId)).toBeTruthy(), { timeout: 5000 });
  return terminal.get(jobId);
};

beforeEach(async () => {
  imageGenEvents.removeAllListeners();
  terminal.clear();
  for (const type of ['completed', 'failed']) {
    imageGenEvents.on(type, (event) => terminal.set(event.generationId, { type, ...event }));
  }
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_IMAGES_DIR, { recursive: true });
  getSettingsMock.mockReset().mockResolvedValue({ videoGen: { fal: { apiKey: 'test-key' } } });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  imageGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('imageGen/fal — generateImage', () => {
  it('renders text-only on the family text endpoint, transcodes to PNG, and records model + cost in the sidecar', async () => {
    const started = vi.fn();
    imageGenEvents.on('started', started);
    const { calls, submits } = fakeFal({
      endpoint: 'fal-ai/nano-banana-2', output: await noiseImage(64, 36, 'jpeg'), result: { seed: 42 },
    });

    const job = await fal.generateImage({
      model: 'fal-ai/nano-banana-2', prompt: ' a neon harbour ', negativePrompt: 'blurry', width: 1920, height: 1080,
    });
    expect(job).toMatchObject({ mode: 'fal', status: 'running', filename: `${job.jobId}.png`, path: `/data/images/${job.jobId}.png` });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ generationId: job.jobId }));

    const event = await waitForTerminal(job.jobId);
    expect(event).toMatchObject({ type: 'completed', mode: 'fal', filename: `${job.jobId}.png` });

    expect(submits()).toHaveLength(1);
    expect(submits()[0].headers.Authorization).toBe('Key test-key');
    expect(submits()[0].body).toEqual({
      prompt: 'a neon harbour\nAvoid: blurry', output_format: 'png', aspect_ratio: '16:9', resolution: '2K',
    });
    // The CDN download is public — the key must not ride along to it.
    expect(calls.find((c) => c.url === CDN_URL).headers).toBeUndefined();

    const png = await readFile(join(FAKE_IMAGES_DIR, `${job.jobId}.png`));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const sidecar = JSON.parse(await readFile(join(FAKE_IMAGES_DIR, `${job.jobId}.metadata.json`), 'utf8'));
    expect(sidecar).toMatchObject({
      mode: 'fal', model: 'fal-ai/nano-banana-2', modelFamily: 'nano-banana-2', prompt: 'a neon harbour',
      aspectRatio: '16:9', resolution: '2K', seed: 42,
      // $0.08 × 1.5 for a 2K render.
      estimatedCostUsd: 0.12,
    });
    expect(sidecar.renderMs).toEqual(expect.any(Number));
  });

  it('routes a render with references to the /edit endpoint as data URIs, capped at the model\'s reference limit', async () => {
    const refs = [];
    for (let i = 0; i < 11; i += 1) {
      const name = `ref-${i}.png`;
      await writeFile(join(FAKE_IMAGES_DIR, name), await noiseImage(16, 16));
      refs.push(name);
    }
    const { submits } = fakeFal({ endpoint: 'fal-ai/flux-2-pro/edit', output: await noiseImage(32, 48) });

    const job = await fal.generateImage({
      model: 'fal-ai/flux-2-pro', prompt: 'character sheet', width: 1000, height: 1500, referenceImagePaths: refs,
    });
    expect((await waitForTerminal(job.jobId)).type).toBe('completed');

    const { body } = submits()[0];
    // FLUX.2 [pro] edit takes at most 9 references; the surplus is dropped
    // before anything is encoded or billed.
    expect(body.image_urls).toHaveLength(9);
    expect(body.image_urls.every((u) => u.startsWith('data:image/png;base64,'))).toBe(true);
    expect(body.image_size).toEqual({ width: 1008, height: 1504 });
    expect(body.prompt).toContain('character sheet');
    expect(body.prompt).toContain('visual references for style, characters, and subject matter');
    expect(body).not.toHaveProperty('num_images');
    const sidecar = JSON.parse(await readFile(join(FAKE_IMAGES_DIR, `${job.jobId}.metadata.json`), 'utf8'));
    expect(sidecar).toMatchObject({ model: 'fal-ai/flux-2-pro/edit', inputImageCount: 9 });
  });

  it('defaults to Nano Banana Pro and switches to its /edit endpoint when an init image is attached', async () => {
    await writeFile(join(FAKE_IMAGES_DIR, 'source.png'), await noiseImage(16, 16));
    const { submits } = fakeFal({ endpoint: 'fal-ai/nano-banana-pro/edit', output: await noiseImage(16, 16) });
    const job = await fal.generateImage({ prompt: 'make it dusk', initImagePath: 'source.png', initImageStrength: 0.1 });
    expect((await waitForTerminal(job.jobId)).type).toBe('completed');
    expect(submits()[0].body.image_urls).toHaveLength(1);
    expect(submits()[0].body.prompt).toContain('The first attached image is the source image to edit');
  });

  it('refuses before any paid call when the model is outside the catalog or no key is configured', async () => {
    const { calls } = fakeFal({ endpoint: 'fal-ai/nano-banana-pro' });
    await expect(fal.generateImage({ model: 'fal-ai/not-curated', prompt: 'x' }))
      .rejects.toMatchObject({ status: 400, code: 'FAL_IMAGE_MODEL_UNKNOWN' });
    getSettingsMock.mockResolvedValue({});
    const prevEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    await expect(fal.generateImage({ prompt: 'x' })).rejects.toMatchObject({ status: 400, code: 'FAL_NOT_CONFIGURED' });
    if (prevEnv !== undefined) process.env.FAL_KEY = prevEnv;
    expect(calls).toHaveLength(0);
  });

  it('fails without writing anything or sending a cancel when fal.ai reports ERROR', async () => {
    const { calls } = fakeFal({ endpoint: 'fal-ai/nano-banana-pro', statuses: [{ status: 'ERROR', error: 'content policy' }] });
    const job = await fal.generateImage({ prompt: 'x' });
    const event = await waitForTerminal(job.jobId);
    expect(event).toMatchObject({ type: 'failed', mode: 'fal', error: expect.stringContaining('content policy') });
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
    expect(existsSync(join(FAKE_IMAGES_DIR, `${job.jobId}.png`))).toBe(false);
  });

  it('cancel(jobId) stops polling, cancels the billed remote request once, and lands nothing in the gallery', async () => {
    vi.useFakeTimers();
    const { calls } = fakeFal({ endpoint: 'fal-ai/nano-banana-pro', statuses: ['IN_PROGRESS'] });
    const job = await fal.generateImage({ prompt: 'x' });
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/status'))).toBe(true));

    expect(fal.cancel(job.jobId)).toBe(true);
    expect(fal.cancel(job.jobId)).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    const event = await waitForTerminal(job.jobId);

    expect(event).toMatchObject({ type: 'failed', error: 'Canceled' });
    const cancels = calls.filter((c) => c.url.endsWith('/cancel'));
    expect(cancels).toHaveLength(1);
    expect(cancels[0].method).toBe('PUT');
    expect(calls.some((c) => c.url === CDN_URL)).toBe(false);
    expect(existsSync(join(FAKE_IMAGES_DIR, `${job.jobId}.png`))).toBe(false);
    expect(fal.cancel(job.jobId)).toBe(false);
  });
});

describe('imageGen/fal — checkConnection', () => {
  it('reports a missing key without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getSettingsMock.mockResolvedValue({});
    const prevEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    const status = await fal.checkConnection({});
    if (prevEnv !== undefined) process.env.FAL_KEY = prevEnv;
    expect(status).toMatchObject({ connected: false, mode: 'fal', reason: expect.stringContaining('No fal.ai API key') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies the key on the free pricing endpoint and never submits a paid request', async () => {
    const fetchMock = vi.fn(async (url) => jsonResponse({
      prices: [{ endpoint_id: 'fal-ai/bytedance/seedream/v5/lite/text-to-image', unit_price: 0.035, unit: 'images', currency: 'USD' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const status = await fal.checkConnection({ model: 'fal-ai/bytedance/seedream/v5/lite/edit' });
    expect(status).toMatchObject({ connected: true, mode: 'fal', model: 'Seedream 5.0 Lite — $0.035/image' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai%2Fbytedance%2Fseedream%2Fv5%2Flite%2Ftext-to-image');
    expect(opts.method ?? 'GET').toBe('GET');
  });

  it('reports a rejected key as not connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'nope' }, false, 401)));
    expect(await fal.checkConnection({})).toMatchObject({ connected: false, reason: expect.stringContaining('HTTP 401') });
  });
});
