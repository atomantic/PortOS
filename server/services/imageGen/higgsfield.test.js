import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIGGSFIELD_IMAGE_DEFAULT_MODEL, higgsfieldImageFamily } from '../../lib/higgsfieldImageModels.js';
import { cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/paths.js';
import {
  awaitHiggsfieldRequest, cancelHiggsfieldRequest, submitHiggsfieldRequest, uploadHiggsfieldImage,
} from '../higgsfieldApi.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import {
  attachSseClient, cancel, cancelAll, checkConnection, generateImage, getActiveJobs, higgsfieldImageSentPrompt,
} from './higgsfield.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';

vi.mock('../../lib/paths.js', async (load) => {
  const { lazyTempDataRoot, makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await load(), { dataRoot: () => lazyTempDataRoot('portos-higgsfield-image-') });
});
vi.mock('../settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../higgsfieldApi.js', async (load) => ({
  ...await load(),
  awaitHiggsfieldRequest: vi.fn(),
  cancelHiggsfieldRequest: vi.fn(),
  submitHiggsfieldRequest: vi.fn(),
  uploadHiggsfieldImage: vi.fn(),
}));
vi.mock('../hostedRenderRemoteDelete.js', () => ({ autoDeleteHostedCopy: vi.fn() }));
vi.mock('./reviewedReference.js', async (load) => ({
  ...await load(),
  assertSnapshotForAdapter: vi.fn(),
}));

const apiKey = 'example-key:example-secret';
const model = 'alibaba/qwen-image-3/text-to-image';
const editModel = 'alibaba/qwen-image-3/edit';
const prompt = '  Paint a garden  ';
const negativePrompt = '  lettering  ';
const initImagePath = 'source.png';
const referenceImagePaths = ['palette.png'];
const editParams = { model, prompt, initImagePath, referenceImagePaths };
const sourceUrl = 'https://example.com/source.png';
const referenceUrl = 'https://example.com/palette.png';
const outputUrl = 'https://example.com/result.png';
const remote = { requestId: 'example-request', statusUrl: 'https://example.com/status', cancelUrl: 'https://example.com/cancel' };
const remoteEntry = { apiKey, requestId: remote.requestId, cancelUrl: remote.cancelUrl };
const addition = { id: 'style', label: 'Style', text: 'Watercolor' };
const fetchMock = vi.fn();
const terminal = new Map();
const onComplete = (event) => terminal.set(event.generationId, { type: 'completed', ...event });
const onFail = (event) => terminal.set(event.generationId, { type: 'failed', ...event });
let png;

const sidecarPath = (jobId) => join(PATHS.images, `${jobId}.metadata.json`);
const waitForTerminal = async (jobId) => {
  await vi.waitFor(() => expect(terminal.has(jobId)).toBe(true));
  return terminal.get(jobId);
};

beforeAll(async () => {
  const pixels = Buffer.from(Array.from({ length: 48 * 24 * 3 }, (_, i) => ((i % (48 * 3)) < 72 ? 32 : 224)));
  png = await sharp(pixels, { raw: { width: 48, height: 24, channels: 3 } }).png().toBuffer();
  await mkdir(PATHS.images, { recursive: true });
  await Promise.all([initImagePath, ...referenceImagePaths].map((name) => writeFile(join(PATHS.images, name), png)));
});
afterAll(cleanupTempDataRoots);

beforeEach(() => {
  vi.stubEnv('HIGGSFIELD_API_KEY', '');
  vi.stubGlobal('fetch', fetchMock.mockReset().mockImplementation(async () => {
    throw new Error('Unexpected Higgsfield network request');
  }));
  getSettings.mockReset().mockResolvedValue({ videoGen: { higgsfield: { apiKey } } });
  assertSnapshotForAdapter.mockReset().mockResolvedValue(null);
  uploadHiggsfieldImage.mockReset().mockResolvedValueOnce(sourceUrl).mockResolvedValueOnce(referenceUrl);
  submitHiggsfieldRequest.mockReset().mockResolvedValue(remote);
  awaitHiggsfieldRequest.mockReset().mockResolvedValue({ outcome: 'completed', outputUrl });
  cancelHiggsfieldRequest.mockReset().mockResolvedValue(undefined);
  autoDeleteHostedCopy.mockReset().mockResolvedValue(undefined);
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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

describe('Higgsfield image connection check', () => {
  it('reports configured credentials and normalizes the requested edit model to its family', async () => {
    expect(await checkConnection({ model: editModel })).toEqual({
      connected: true, mode: 'higgsfield', model: 'Qwen Image 3', modelId: model,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  });

  it('defaults an unknown model and reports missing credentials even when loading settings fails', async () => {
    getSettings.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Settings unavailable'));
    const disconnected = {
      connected: false, mode: 'higgsfield', model: 'Higgsfield Soul 2', modelId: HIGGSFIELD_IMAGE_DEFAULT_MODEL,
      reason: expect.stringContaining('No Higgsfield credential configured'),
    };
    expect(await checkConnection({ model: 'unknown/model' })).toEqual(disconnected);
    expect(await checkConnection()).toEqual(disconnected);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  });
});

it('previews folded negative text and labeled additions', () => {
  const { request, record } = higgsfieldImageSentPrompt({
    family: higgsfieldImageFamily(HIGGSFIELD_IMAGE_DEFAULT_MODEL), prompt, negativePrompt,
    inputImages: { initPath: null, referencePaths: [], paths: [] }, promptAdditions: [addition],
  });
  expect(request.body).toEqual({ prompt: 'Paint a garden\nAvoid: lettering', enhance_prompt: false });
  expect(record).toEqual({
    sentPrompt: request.body.prompt,
    promptAdditions: [addition, { id: 'avoid', label: 'Negative prompt, sent as "Avoid:"', text: 'lettering' }],
  });
});

it.each([
  ['missing credentials', { settings: {} }, 'HIGGSFIELD_NOT_CONFIGURED', /No Higgsfield credential configured/],
  ['unsupported model', { model: 'unknown/model' }, 'HIGGSFIELD_IMAGE_MODEL_UNKNOWN', /has no model/],
  ['too many inputs', { ...editParams, model: 'ideogram/v4.0' }, 'HIGGSFIELD_IMAGE_INPUT_INVALID', /takes at most 1 input image/],
  ['blank prompt', { prompt: '  ' }, 'VALIDATION_ERROR', /Prompt is required/],
])('refuses %s before starting a job or calling the provider', async (_name, params, code, message) => {
  await expect(generateImage({ prompt, ...params })).rejects.toMatchObject({
    status: 400, code, message: expect.stringMatching(message),
  });
  expect(getActiveJobs()).toEqual([]);
  expect(terminal.size).toBe(0);
  expect(uploadHiggsfieldImage).not.toHaveBeenCalled();
  expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('publishes an edit with its exact sent prompt before deleting the hosted copy', async () => {
  const complete = Promise.withResolvers();
  awaitHiggsfieldRequest.mockReturnValueOnce(complete.promise);
  fetchMock.mockImplementationOnce(async (url) => {
    if (url !== outputUrl) throw new Error('Unexpected download URL');
    return new Response(png);
  });
  const preview = higgsfieldImageSentPrompt({
    family: higgsfieldImageFamily(model), prompt, negativePrompt, width: 1920, height: 1080,
    inputImages: { initPath: initImagePath, referencePaths: referenceImagePaths, paths: [initImagePath, ...referenceImagePaths] },
    promptAdditions: [addition],
  });
  autoDeleteHostedCopy.mockImplementationOnce(async (_provider, _kind, filename) => {
    const jobId = filename.slice(0, -'.png'.length);
    return {
      bytes: readFileSync(join(PATHS.images, filename)),
      sidecar: JSON.parse(readFileSync(sidecarPath(jobId), 'utf8')),
    };
  });
  const job = await generateImage({ ...editParams, negativePrompt, seed: 0, width: 1920, height: 1080, promptAdditions: [addition] });
  const frames = [];
  const req = new EventEmitter();
  try {
    await vi.waitFor(() => expect(awaitHiggsfieldRequest).toHaveBeenCalledTimes(1));
    const [[poll]] = awaitHiggsfieldRequest.mock.calls;
    expect(poll).toMatchObject({ apiKey, kind: 'image', statusUrl: remote.statusUrl, entry: remoteEntry });
    expect(attachSseClient(job.jobId, { req, writeHead: vi.fn(), write: (frame) => frames.push(JSON.parse(frame.slice('data: '.length))) })).toBe(true);
    poll.onStatus('queued');
    poll.onStatus('in_progress');
  } finally {
    complete.resolve({ outcome: 'completed', outputUrl });
    req.emit('close');
  }

  expect(frames.filter(({ type }) => type === 'status').map(({ message }) => message)).toEqual([
    'Submitting to Higgsfield…', 'Queued at Higgsfield…', 'Rendering…',
  ]);
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed', mode: 'higgsfield', filename: job.filename, path: job.path });
  expect(uploadHiggsfieldImage.mock.calls).toEqual([initImagePath, ...referenceImagePaths].map((name) => [{
    apiKey, path: join(PATHS.images, name), bytes: null, signal: expect.any(AbortSignal),
  }]));
  expect(preview.request).toMatchObject({
    endpointId: editModel, body: { image_urls: ['pending:image-1', 'pending:image-2'], negative_prompt: 'lettering' },
  });
  expect(submitHiggsfieldRequest).toHaveBeenCalledExactlyOnceWith({
    apiKey, endpoint: editModel, signal: expect.any(AbortSignal),
    body: { ...preview.request.body, image_urls: [sourceUrl, referenceUrl], seed: 0 },
  });
  expect(preview.record).toMatchObject({
    sentPrompt: expect.stringMatching(/^Paint a garden\n\nThe first attached image is the source image to edit/),
    sentNegativePrompt: 'lettering',
    promptAdditions: [addition, expect.objectContaining({ id: 'image-roles', text: expect.stringContaining('visual reference') })],
  });
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(outputUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  await vi.waitFor(() => expect(autoDeleteHostedCopy).toHaveBeenCalledExactlyOnceWith('higgsfield', 'image', job.filename, { apiKey }));
  await expect(autoDeleteHostedCopy.mock.results[0].value).resolves.toMatchObject({
    bytes: png,
    sidecar: {
      ...preview.record, model: editModel, higgsfieldRequestId: remote.requestId,
      initImageFilename: initImagePath, referenceImageFilenames: referenceImagePaths,
      aspectRatio: '16:9', resolution: '2k', seed: 0, estimatedCostUsd: null,
    },
  });
});

it.each([
  ['canceled', { outcome: 'canceled' }, 'Canceled'],
  ['failed', { outcome: 'failed', reason: 'Provider rejected the render' }, 'Provider rejected the render'],
  ['threw', new Error('Status transport failed'), 'Higgsfield image generation failed: Status transport failed'],
])('finalizes a poll that %s without publishing', async (outcome, result, error) => {
  if (result instanceof Error) awaitHiggsfieldRequest.mockRejectedValueOnce(result);
  else awaitHiggsfieldRequest.mockResolvedValueOnce(result);
  const job = await generateImage({ prompt });
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', mode: 'higgsfield', error });
  if (outcome === 'threw') {
    expect(cancelHiggsfieldRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(remoteEntry));
  } else {
    expect(cancelHiggsfieldRequest).not.toHaveBeenCalled();
  }
  expect(fetchMock).not.toHaveBeenCalled();
  expect(autoDeleteHostedCopy).not.toHaveBeenCalled();
  await expect(access(join(PATHS.images, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(sidecarPath(job.jobId))).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('Higgsfield image submission boundaries', () => {
  it('honors cancellation during preparation before uploading any reference', async () => {
    const snapshot = Promise.withResolvers();
    assertSnapshotForAdapter.mockReturnValueOnce(snapshot.promise);
    const jobId = 'pending-cancel';
    const pending = generateImage({ ...editParams, jobId });
    try {
      await vi.waitFor(() => expect(assertSnapshotForAdapter).toHaveBeenCalled());
      expect(cancel(jobId)).toBe('pending');
    } finally {
      snapshot.resolve(null);
      await pending;
    }
    expect(await waitForTerminal(jobId)).toMatchObject({ type: 'failed', error: 'Canceled' });
    expect(uploadHiggsfieldImage).not.toHaveBeenCalled();
    expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  });

  it('refuses a paid submission when uploads consume the render deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    uploadHiggsfieldImage.mockReset().mockImplementation(async () => {
      now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
      return referenceUrl;
    });
    const job = await generateImage(editParams);
    expect(await waitForTerminal(job.jobId)).toMatchObject({
      type: 'failed', error: expect.stringContaining('deadline elapsed before submission'),
    });
    expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  });
});
