import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_IMAGE_DEFAULT_MODEL, googleImageFamily } from '../../lib/googleImageModels.js';
import { cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/paths.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { cancel, cancelAll, checkConnection, generateImage, getActiveJobs, googleImageSentPrompt } from './google.js';

vi.mock('../../lib/paths.js', async (original) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-google-image-') });
});
vi.mock('../settings.js', () => ({ getSettings: vi.fn() }));

const GEMINI = GOOGLE_IMAGE_DEFAULT_MODEL;
const IMAGEN = 'imagen-4.0-generate-001';
const KEY = 'test-google-key';
const googleSettings = (options = {}) => ({ videoGen: { google: { apiKey: KEY, ...options } } });
const fetchMock = vi.fn();
const terminal = new Map();
const onComplete = (event) => terminal.set(event.generationId, { type: 'completed', ...event });
const onFail = (event) => terminal.set(event.generationId, { type: 'failed', ...event });
const waitForTerminal = async (jobId) => {
  await vi.waitFor(() => expect(terminal.has(jobId)).toBe(true));
  return terminal.get(jobId);
};
const sidecarPath = (jobId) => join(PATHS.images, `${jobId}.metadata.json`);

let generatedPng;
beforeAll(async () => {
  const width = 64;
  const height = 32;
  // A dark left half and a light right half make clockwise vs counterclockwise observable.
  const landscape = Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i % (width * 3) < (width / 2) * 3 ? 32 : 224)));
  generatedPng = await sharp(landscape, { raw: { width, height, channels: 3 } }).png().toBuffer();
  await mkdir(PATHS.images, { recursive: true });
});
afterAll(cleanupTempDataRoots);

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLOUD_API_KEY', '');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  fetchMock.mockReset().mockImplementation(async () => {
    throw new Error('Unexpected Google request');
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getSettings).mockReset().mockResolvedValue(googleSettings());
  imageGenEvents.on('completed', onComplete);
  imageGenEvents.on('failed', onFail);
});

afterEach(async () => {
  try {
    cancelAll();
    await vi.waitFor(() => expect(getActiveJobs()).toEqual([]));
  } finally {
    imageGenEvents.off('completed', onComplete);
    imageGenEvents.off('failed', onFail);
    terminal.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const geminiImage = () => ({ candidates: [{ content: { parts: [
  { inlineData: { mimeType: 'image/png', data: generatedPng.toString('base64') } },
] } }] });

async function generateWithReference(filename, source) {
  await writeFile(join(PATHS.images, filename), source);
  fetchMock.mockImplementationOnce(async () => Response.json(geminiImage()));
  const job = await generateImage({ prompt: 'Refine the sketch', referenceImagePaths: [filename] });
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = JSON.parse(fetchMock.mock.calls[0][1].body);
  return request.contents[0].parts[1].inlineData;
}

describe('Google image connection check', () => {
  it('defaults unknown models to the default Gemini family and makes a free read', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({}));
    expect(await checkConnection({ model: 'example-unknown' })).toMatchObject({
      connected: true, mode: 'google', modelId: GEMINI,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${GEMINI}`,
      { headers: { 'x-goog-api-key': KEY }, signal: expect.any(AbortSignal) },
    );
  });

  it('reports a regional Imagen probe failure', async () => {
    vi.mocked(getSettings).mockResolvedValue(googleSettings({ projectId: 'example-project', location: 'us-central1' }));
    fetchMock.mockImplementationOnce(async () => Response.json({ error: { message: 'Model access denied' } }, { status: 403 }));
    expect(await checkConnection({ model: IMAGEN })).toMatchObject({
      connected: false, modelId: IMAGEN, reason: 'Google answered HTTP 403 — Model access denied',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models/${IMAGEN}`,
      expect.objectContaining({ headers: { 'x-goog-api-key': KEY } }),
    );
  });

  it('refuses missing or invalid configuration and unsupported express models before probing', async () => {
    vi.mocked(getSettings).mockRejectedValueOnce(new Error('Settings unavailable'));
    expect(await checkConnection()).toMatchObject({ connected: false, reason: expect.stringContaining('No Google credential') });
    vi.mocked(getSettings).mockResolvedValueOnce(googleSettings({ projectId: 'invalid project' }));
    expect(await checkConnection()).toMatchObject({ connected: false, reason: expect.stringContaining('valid Google Cloud project id') });
    expect(await checkConnection({ model: IMAGEN })).toMatchObject({ connected: false, reason: expect.stringContaining('express mode') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Google image prompt record', () => {
  it('records the Gemini edit text and labels each carried and provider-added instruction', () => {
    const carried = { id: 'style', label: 'Style', text: 'Watercolor' };
    const { request, record } = googleImageSentPrompt({
      family: googleImageFamily(GEMINI),
      prompt: '  Paint the garden  ', negativePrompt: '  lettering  ',
      inputImages: { initPath: 'source.png', referencePaths: [], paths: ['source.png'] },
      initImageStrength: 0.1, promptAdditions: [carried],
    });
    expect(record.sentPrompt).toMatch(/^Paint the garden\n\nThe first attached image is the source image to edit .*\nAvoid: lettering$/);
    expect(request.body.contents[0].parts[0].text).toBe(record.sentPrompt);
    expect(record.promptAdditions).toEqual([carried,
      { id: 'image-roles', label: 'How to read the attached images', text: expect.stringContaining('preserve composition') },
      { id: 'avoid', label: 'Negative prompt, sent as "Avoid:"', text: 'lettering' },
    ]);
  });

  it('records Imagen text and refuses an Imagen preview with attachments', () => {
    const preview = { family: googleImageFamily(IMAGEN), prompt: 'Paint the garden', negativePrompt: 'lettering' };
    const { request, record } = googleImageSentPrompt({ ...preview,
      inputImages: { initPath: null, referencePaths: [], paths: [] },
    });
    expect(request.body.instances).toEqual([{ prompt: 'Paint the garden\nAvoid: lettering' }]);
    expect(record.sentPrompt).toBe(request.body.instances[0].prompt);
    expect(() => googleImageSentPrompt({ ...preview,
      inputImages: { initPath: null, referencePaths: ['ref.png'], paths: ['ref.png'] },
    })).toThrow(expect.objectContaining({ code: 'GOOGLE_IMAGE_INPUT_INVALID', status: 400 }));
  });
});

describe('Google image generation', () => {
  it('strips EXIF without re-encoding a small, upright input', async () => {
    const source = await sharp(generatedPng).withExif({ IFD0: { Orientation: '1', Make: 'Test Camera' } }).png().toBuffer();
    expect(await sharp(source).metadata()).toMatchObject({ orientation: 1, exif: expect.any(Buffer) });
    const { mimeType, data } = await generateWithReference('upright.png', source);
    expect(mimeType).toBe('image/png');
    const inline = Buffer.from(data, 'base64');
    expect(await sharp(inline).metadata()).not.toHaveProperty('exif');
    expect(inline).toEqual(generatedPng);
  });

  it('rotates small portrait EXIF inputs clockwise before stripping metadata', async () => {
    const source = await sharp(generatedPng).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(await sharp(source).metadata()).toMatchObject({ width: 64, height: 32, orientation: 6 });
    const { mimeType, data } = await generateWithReference('portrait.jpg', source);
    expect(mimeType).toBe('image/jpeg');
    const inline = sharp(Buffer.from(data, 'base64'));
    const metadata = await inline.metadata();
    expect(metadata).toMatchObject({ width: 32, height: 64 });
    expect(metadata).not.toHaveProperty('orientation');
    expect(metadata).not.toHaveProperty('exif');
    const { data: pixels, info } = await inline.raw().toBuffer({ resolveWithObject: true });
    expect(pixels[8 * info.width * info.channels]).toBeLessThan(64);
    expect(pixels[56 * info.width * info.channels]).toBeGreaterThan(192);
  });

  it('downscales a long input while preserving aspect ratio and alpha', async () => {
    const source = await sharp({
      create: { width: 4096, height: 128, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
    }).png().toBuffer();
    const { mimeType, data } = await generateWithReference('oversized.png', source);
    expect(mimeType).toBe('image/png');
    expect(await sharp(Buffer.from(data, 'base64')).metadata()).toMatchObject({ width: 2048, height: 64, hasAlpha: true });
  });

  it.each([
    { model: GEMINI, payload: geminiImage, method: 'generateContent', estimatedCostUsd: 0.134, sentSeed: 0 },
    { model: IMAGEN, payload: () => ({ predictions: [{ bytesBase64Encoded: generatedPng.toString('base64') }] }),
      method: 'predict', estimatedCostUsd: 0.04, sentSeed: undefined },
  ])('publishes $model output with the requested seed policy and estimated cost', async ({
    model, payload, method, estimatedCostUsd, sentSeed,
  }) => {
    vi.mocked(getSettings).mockResolvedValue(googleSettings({ projectId: 'example-project' }));
    fetchMock.mockImplementationOnce(async () => Response.json(payload()));
    const job = await generateImage({ model, prompt: '  Paint the garden  ', negativePrompt: 'lettering', seed: 0, width: 1920, height: 1080 });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed', filename: job.filename });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [[url, { body }]] = fetchMock.mock.calls;
    expect(new URL(url).pathname.split('/').at(-1)).toBe(`${model}:${method}`);
    const request = JSON.parse(body);
    const parameters = request.generationConfig ?? request.parameters;
    if (sentSeed === undefined) expect(parameters).not.toHaveProperty('seed');
    else expect(parameters.seed).toBe(sentSeed);
    const sentPrompt = request.contents?.[0].parts[0].text ?? request.instances[0].prompt;
    expect(sentPrompt).toBe('Paint the garden\nAvoid: lettering');
    expect(await readFile(join(PATHS.images, job.filename))).toEqual(generatedPng);
    const sidecar = JSON.parse(await readFile(sidecarPath(job.jobId), 'utf8'));
    expect(sidecar).toMatchObject({ model, estimatedCostUsd, resolution: '2K', aspectRatio: '16:9', sentPrompt });
    if (sentSeed === undefined) expect(sidecar).not.toHaveProperty('seed');
    else expect(sidecar.seed).toBe(sentSeed);
  });

  it.each([
    { model: IMAGEN, payload: { predictions: [{ raiFilteredReason: 'Filtered reference' }] }, reason: 'Filtered reference' },
    { model: GEMINI, payload: { promptFeedback: { blockReason: 'SAFETY' } }, reason: 'prompt blocked (SAFETY)' },
    { model: GEMINI, payload: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, reason: 'finish reason IMAGE_SAFETY' },
    { model: GEMINI, payload: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Try\na new prompt' }] } }] },
      reason: 'the model answered "Try a new prompt"' },
  ])('reports an image-free response with $reason', async ({ model, payload, reason }) => {
    vi.mocked(getSettings).mockResolvedValue(googleSettings({ projectId: 'example-project' }));
    fetchMock.mockImplementationOnce(async () => Response.json(payload));
    const job = await generateImage({ model, prompt: 'Paint the garden' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: `Google returned no image: ${reason}` });
    await expect(access(sidecarPath(job.jobId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts the in-flight POST, clears its unreferenced heartbeat, and leaves no output', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const submitted = Promise.withResolvers();
    fetchMock.mockImplementationOnce(async (_url, { signal }) => {
      submitted.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const job = await generateImage({ prompt: 'Paint the garden' });
    const signal = await submitted.promise;
    const heartbeat = interval.mock.results[interval.mock.calls.findIndex(([, delay]) => delay === 5000)]?.value;
    const heldProcessOpen = heartbeat?.hasRef();
    expect(cancel(job.jobId)).toBe(true);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Canceled' });
    expect(signal.aborted).toBe(true);
    expect(heldProcessOpen).toBe(false);
    expect(clear).toHaveBeenCalledWith(heartbeat);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(access(join(PATHS.images, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(sidecarPath(job.jobId))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
