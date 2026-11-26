import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/fileUtils.js';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { abandonGoogleOperation, awaitGoogleOperation, googleInlineImage, submitGoogleOperation } from '../googleCloudApi.js';
import { videoGenEvents } from './events.js';
import { attachSseClient, cancel, generateVideo, getActiveJob } from './google.js';
import { loadHistory } from './history.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => join(lazyTempDataRoot('portos-google-video-'), 'data') }));

vi.mock('../googleCloudApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    submitGoogleOperation: vi.fn(),
    awaitGoogleOperation: vi.fn(),
    abandonGoogleOperation: vi.fn(actual.abandonGoogleOperation),
    googleInlineImage: vi.fn(actual.googleInlineImage),
  };
});

vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...await importOriginal(),
  optimizeForStreaming: vi.fn(async () => {}),
  generateThumbnail: vi.fn(async () => null),
  probeVideoGeometry: vi.fn(),
}));

const root = dirname(PATHS.data);
const modelId = 'veo-3.1-generate-001';
const settings = { videoGen: { google: { apiKey: 'test-key', projectId: 'test-project' } } };
const operationName = 'projects/test-project/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/test-operation';
const videoBytes = Buffer.from('mock Veo output');
const geometry = { width: 1280, height: 720, durationSec: 4 };

const terminalEvents = new Map();
const started = ({ generationId }) => terminalEvents.set(generationId, null);
const completed = (event) => terminalEvents.set(event.generationId, { type: 'completed', ...event });
const failed = (event) => terminalEvents.set(event.generationId, { type: 'failed', ...event });

beforeAll(() => {
  videoGenEvents.on('started', started);
  videoGenEvents.on('completed', completed);
  videoGenEvents.on('failed', failed);
});

beforeEach(async () => {
  vi.stubEnv('GOOGLE_CLOUD_API_KEY', '');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  vi.clearAllMocks();
  terminalEvents.clear();
  await mkdir(PATHS.uploads, { recursive: true });
  submitGoogleOperation.mockReset().mockResolvedValue(operationName);
  awaitGoogleOperation.mockReset().mockResolvedValue({
    outcome: 'completed',
    response: { videos: [{ bytesBase64Encoded: videoBytes.toString('base64') }] },
  });
  probeVideoGeometry.mockReset().mockResolvedValue(geometry);
});

afterEach(async () => {
  await vi.waitFor(() => expect([...terminalEvents.values()]).not.toContain(null), { timeout: 5000 });
  await rm(PATHS.data, { recursive: true, force: true });
});

afterAll(() => {
  videoGenEvents.off('started', started);
  videoGenEvents.off('completed', completed);
  videoGenEvents.off('failed', failed);
  vi.unstubAllEnvs();
  cleanupTempDataRoots();
});

async function writePng(path, width, height) {
  await sharp({ create: { width, height, channels: 3, background: '#336699' } }).png().toFile(path);
  return path;
}

async function waitForTerminal(jobId) {
  await vi.waitFor(() => expect(terminalEvents.get(jobId)).toBeTruthy(), { timeout: 5000 });
  return terminalEvents.get(jobId);
}

async function expectNoPublication() {
  expect(await loadHistory()).toEqual([]);
  expect(await readdir(PATHS.videos)).toEqual([]);
}

describe('Google Veo video generation', () => {
  it.each([
    ['an unknown model', { modelId: 'not-a-veo-model' }, 'VALIDATION_ERROR', /not a Google video model/],
    ['an end frame without a start frame', { lastImagePath: 'missing-end.png' }, 'VALIDATION_ERROR', /end frame needs a start frame/],
    ['missing credentials', { settings: {} }, 'GOOGLE_NOT_CONFIGURED', /No Google credential/],
    ['an API key without a project', { settings: { videoGen: { google: { apiKey: 'test-key' } } } }, 'GOOGLE_PROJECT_REQUIRED', /Set your Google Cloud project/],
  ])('refuses %s before submitting', async (_label, params, code, message) => {
    await expect(generateVideo({ settings, modelId, prompt: 'A lighthouse at dawn', ...params }))
      .rejects.toMatchObject({ status: 400, code, message: expect.stringMatching(message) });
    expect(submitGoogleOperation).not.toHaveBeenCalled();
    expect(getActiveJob()).toBeNull();
    await expectNoPublication();
  });

  it('cancels during frame preparation before a billed submission and removes the staged upload', async () => {
    const sourceImagePath = await writePng(join(PATHS.uploads, 'start.png'), 64, 64);
    const job = await generateVideo({ settings, modelId, sourceImagePath, uploadedTempPath: sourceImagePath, frameAspect: '16:9' });
    expect(cancel(job.jobId)).toBe(true);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Canceled' });
    expect(submitGoogleOperation).not.toHaveBeenCalled();
    expect(abandonGoogleOperation).not.toHaveBeenCalled();
    expect(await readdir(PATHS.uploads)).toEqual([]);
    await expectNoPublication();
  });

  it('conforms both clip frames and publishes the video, operation name and seed', async () => {
    const sourceImagePath = await writePng(join(root, 'start.png'), 64, 64);
    const lastImagePath = await writePng(join(root, 'end.png'), 80, 60);
    const job = await generateVideo({
      settings, modelId, prompt: 'A lighthouse at dawn', negativePrompt: 'flicker', duration: 4,
      sourceImagePath, lastImagePath, frameAspect: '16:9', seed: 0,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed', filename: job.filename });

    expect(submitGoogleOperation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ projectId: 'test-project' }),
      modelId,
      {
        instances: [{ prompt: 'A lighthouse at dawn', image: expect.any(Object), lastFrame: expect.any(Object) }],
        parameters: { sampleCount: 1, durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', seed: 0, generateAudio: false, negativePrompt: 'flicker' },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(awaitGoogleOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entry: expect.objectContaining({ operationName }), modelId,
    }));
    const { image, lastFrame } = submitGoogleOperation.mock.calls[0][2].instances[0];
    for (const [frame, width, height] of [[image, 64, 36], [lastFrame, 80, 45]]) {
      expect(frame.mimeType).toBe('image/png');
      expect(await sharp(Buffer.from(frame.bytesBase64Encoded, 'base64')).metadata()).toMatchObject({ width, height });
    }
    expect(await readFile(join(PATHS.videos, job.filename))).toEqual(videoBytes);
    expect(await loadHistory()).toMatchObject([{
      id: job.jobId, filename: job.filename, modelId: `google:${modelId}`, mode: 'image',
      googleOperationName: operationName, seed: 0, ...geometry,
      frameConformed: { aspect: '16:9', start: { from: '64x64', to: '64x36' }, end: { from: '80x60', to: '80x45' } },
    }]);

    const client = { req: new EventEmitter(), writeHead: vi.fn(), write: vi.fn() };
    expect(attachSseClient(job.jobId, client)).toBe(true);
    client.req.emit('close');
    const payload = JSON.parse(client.write.mock.calls[0][0].slice('data: '.length));
    expect(payload).toMatchObject({ type: 'complete', result: { filename: job.filename, path: job.path, seed: 0 } });
  });

  it('sends asset references at their original dimensions and records their file names', async () => {
    const path = await writePng(join(root, 'subject.png'), 64, 64);
    const job = await generateVideo({
      settings, modelId, prompt: 'A lighthouse at dawn', duration: 8, frameAspect: '16:9', referenceImagePaths: [path],
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    const { instances, parameters } = submitGoogleOperation.mock.calls[0][2];
    expect(instances).toEqual([{
      prompt: 'A lighthouse at dawn',
      referenceImages: [{ referenceType: 'asset', image: { mimeType: 'image/png', bytesBase64Encoded: (await readFile(path)).toString('base64') } }],
    }]);
    expect(parameters).toMatchObject({ aspectRatio: '16:9', durationSeconds: 8 });
    const [entry] = await loadHistory();
    expect(entry).toMatchObject({ id: job.jobId, clipReferenceFiles: ['subject.png'] });
    expect(entry).not.toHaveProperty('frameConformed');
  });

  it('rejects unsupported image bytes before submitting', async () => {
    const sourceImagePath = join(PATHS.uploads, 'invalid.png');
    await writeFile(sourceImagePath, 'not an image');
    const job = await generateVideo({ settings, modelId, sourceImagePath, uploadedTempPath: sourceImagePath });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringContaining('Google accepts PNG, JPEG or WebP input images') });
    expect(googleInlineImage.mock.results).toMatchObject([{ type: 'throw', value: { status: 400, code: 'GOOGLE_INPUT_INVALID' } }]);
    expect(submitGoogleOperation).not.toHaveBeenCalled();
    expect(await readdir(PATHS.uploads)).toEqual([]);
    await expectNoPublication();
  });

  it('reports the safety filter reason and leaves no history or output', async () => {
    awaitGoogleOperation.mockResolvedValue({
      outcome: 'completed',
      response: { videos: [], raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Example safety reason'] },
    });
    const job = await generateVideo({ settings, modelId, prompt: 'A lighthouse at dawn' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Google returned no video: Example safety reason' });
    expect(probeVideoGeometry).not.toHaveBeenCalled();
    expect(abandonGoogleOperation).not.toHaveBeenCalled();
    await expectNoPublication();
  });

  it('abandons the submitted operation and removes unpublished bytes when measuring output fails', async () => {
    const sourceImagePath = await writePng(join(PATHS.uploads, 'start.png'), 64, 64);
    let measuredBytes;
    probeVideoGeometry.mockImplementation(async (path) => {
      measuredBytes = await readFile(path);
      throw new Error('Cannot measure the video');
    });
    const job = await generateVideo({ settings, modelId, sourceImagePath, uploadedTempPath: sourceImagePath });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Google video generation failed: Cannot measure the video' });
    expect(measuredBytes).toEqual(videoBytes);
    expect(abandonGoogleOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationName }));
    expect(await readdir(PATHS.uploads)).toEqual([]);
    await expectNoPublication();
  });
});
