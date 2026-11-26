import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { PATHS } from '../../lib/fileUtils.js';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import {
  awaitHiggsfieldRequest, cancelHiggsfieldRequest, submitHiggsfieldRequest, uploadHiggsfieldFile,
} from '../higgsfieldApi.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import { videoGenEvents } from './events.js';

vi.mock('../higgsfieldApi.js', async (load) => ({
  ...await load(),
  awaitHiggsfieldRequest: vi.fn(),
  cancelHiggsfieldRequest: vi.fn(),
  submitHiggsfieldRequest: vi.fn(),
  uploadHiggsfieldFile: vi.fn(),
}));
vi.mock('../../lib/fetchWithTimeout.js', async (load) => ({
  ...await load(),
  fetchWithTimeout: vi.fn(),
}));
vi.mock('../hostedRenderRemoteDelete.js', () => ({ autoDeleteHostedCopy: vi.fn() }));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(),
  generateThumbnail: vi.fn(async () => null),
  optimizeForStreaming: vi.fn(async () => {}),
  probeVideoGeometry: vi.fn(),
}));

const apiKey = 'example-key';
const imageUrl = 'https://example.com/cast.png';
const audioUrl = 'https://example.com/song.wav';
const outputUrl = 'https://example.com/result.mp4';
const remote = { requestId: 'request-1', statusUrl: 'https://example.com/status', cancelUrl: 'https://example.com/cancel' };
const mp4 = Buffer.from('example MP4 payload');
const geometry = { width: 1280, height: 720, fps: 24, durationSec: 4 };

const terminalEvents = new Map();
const onStarted = ({ generationId }) => terminalEvents.set(generationId, null);
const onCompleted = (event) => terminalEvents.set(event.generationId, { type: 'completed', ...event });
const onFailed = (event) => terminalEvents.set(event.generationId, { type: 'failed', ...event });

async function waitForTerminal(jobId) {
  await vi.waitFor(() => expect(terminalEvents.get(jobId)).toBeTruthy());
  return terminalEvents.get(jobId);
}

let root;
let originalPaths;
let higgsfield;
let loadHistory;
let framePath;

beforeAll(async () => {
  root = createTempDataRoot('portos-higgsfield-video-');
  originalPaths = { ...PATHS };
  // Rebase the real shared paths before modules capture their history/identity filenames.
  Object.assign(PATHS, makePathsProxy({ PATHS }, { dataRoot: root }).PATHS);
  higgsfield = await import('./higgsfield.js');
  ({ loadHistory } = await import('./history.js'));
  videoGenEvents.on('started', onStarted);
  videoGenEvents.on('completed', onCompleted);
  videoGenEvents.on('failed', onFailed);
});

beforeEach(async () => {
  terminalEvents.clear();
  await mkdir(PATHS.uploads, { recursive: true });
  framePath = join(PATHS.uploads, 'cast.png');
  await sharp({ create: { width: 48, height: 24, channels: 3, background: '#336699' } }).png().toFile(framePath);
  vi.stubEnv('HIGGSFIELD_API_KEY', '');
  uploadHiggsfieldFile.mockReset().mockImplementation(async ({ contentType }) => contentType === 'audio/wav' ? audioUrl : imageUrl);
  submitHiggsfieldRequest.mockReset().mockResolvedValue(remote);
  awaitHiggsfieldRequest.mockReset().mockResolvedValue({ outcome: 'completed', outputUrl });
  cancelHiggsfieldRequest.mockReset().mockResolvedValue(undefined);
  fetchWithTimeout.mockReset().mockImplementation(async (url) => {
    if (url !== outputUrl) throw new Error(`Unexpected download URL: ${url}`);
    return new Response(mp4);
  });
  probeVideoGeometry.mockReset().mockResolvedValue(geometry);
  autoDeleteHostedCopy.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  try {
    // Real finalization and the adapter's post-publication tail can outlive generateVideo().
    await vi.waitFor(() => expect([...terminalEvents.values()]).not.toContain(null));
    await setImmediate();
    await rm(root, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

afterAll(() => {
  videoGenEvents.off('started', onStarted);
  videoGenEvents.off('completed', onCompleted);
  videoGenEvents.off('failed', onFailed);
  if (originalPaths) Object.assign(PATHS, originalPaths);
});

it.each([
  ['missing credential', { settings: {} }, 'HIGGSFIELD_NOT_CONFIGURED', /No Higgsfield credential/],
  ['unknown model', { apiKey, modelId: 'unknown/video' }, 'VALIDATION_ERROR', /is not a Higgsfield video model/],
  ['end frame without a start frame', { apiKey, lastImagePath: 'unused.png' }, 'VALIDATION_ERROR', /end frame needs a start frame/],
])('refuses %s before starting or uploading', async (_name, params, code, message) => {
  await expect(higgsfield.generateVideo({ prompt: 'A dancer turns', ...params }))
    .rejects.toMatchObject({ status: 400, code, message: expect.stringMatching(message) });
  expect(terminalEvents.size).toBe(0);
  expect(uploadHiggsfieldFile).not.toHaveBeenCalled();
  expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
});

it('rejects an unsupported frame with a PNG filename and cleans the staged input', async () => {
  const unsupported = join(PATHS.uploads, 'unsupported.png');
  await writeFile(unsupported, await sharp(framePath).tiff().toBuffer());
  const job = await higgsfield.generateVideo({ apiKey, sourceImagePath: unsupported, uploadedTempPath: unsupported });
  expect(await waitForTerminal(job.jobId)).toMatchObject({
    type: 'failed', code: 'HIGGSFIELD_INPUT_INVALID', error: expect.stringContaining('accepts PNG, JPEG, WebP or GIF'),
  });
  const sse = { req: new EventEmitter(), writeHead: vi.fn(), write: vi.fn() };
  expect(higgsfield.attachSseClient(job.jobId, sse)).toBe(true);
  sse.req.emit('close');
  expect(sse.write).toHaveBeenCalledWith(expect.stringContaining('"code":"HIGGSFIELD_INPUT_INVALID"'));
  await expect(stat(unsupported)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(uploadHiggsfieldFile).not.toHaveBeenCalled();
  expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
});

it('commits the submitted reference-and-audio request and deletes the hosted copy after publication', async () => {
  const prompt = '  A dancer turns  ';
  const addition = { id: 'shot', label: 'Shot direction', text: 'Turn toward the camera' };
  const audioFilePath = join(PATHS.uploads, 'song.wav');
  const audio = Buffer.from('example WAV payload');
  await writeFile(audioFilePath, audio);
  const historyFile = join(PATHS.data, 'video-history.json');
  autoDeleteHostedCopy.mockImplementation(async (_provider, _kind, jobId) => ({
    history: existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : [],
    hasVideo: existsSync(join(PATHS.videos, `${jobId}.mp4`)),
  }));

  const job = await higgsfield.generateVideo({
    apiKey, prompt, promptAdditions: [addition], referenceImagePaths: [framePath],
    audioFilePath, uploadedTempPaths: [framePath, audioFilePath],
  });
  expect(job).toMatchObject({ mode: 'higgsfield', status: 'running' });
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed', filename: job.filename, path: job.path });
  expect(uploadHiggsfieldFile.mock.calls.map(([{ contentType }]) => contentType)).toEqual(['image/png', 'audio/wav']);
  expect(uploadHiggsfieldFile).toHaveBeenCalledWith(expect.objectContaining({ bytes: audio, contentType: 'audio/wav' }));
  const [{ endpoint, body }] = submitHiggsfieldRequest.mock.calls[0];
  expect(endpoint).toBe('bytedance/seedance-2.5/reference-to-video');
  expect(body).toMatchObject({ prompt, image_urls: [imageUrl], audio_urls: [audioUrl] });
  await vi.waitFor(() => expect(autoDeleteHostedCopy).toHaveBeenCalledExactlyOnceWith('higgsfield', 'video', job.jobId, { apiKey }));
  await expect(autoDeleteHostedCopy.mock.results[0].value).resolves.toEqual({
    history: [expect.objectContaining({
      id: job.jobId, ...geometry, sentRequest: { endpoint, body }, sentPrompt: prompt, promptAdditions: [addition],
    })],
    hasVideo: true,
  });
  expect(await readFile(join(PATHS.videos, job.filename))).toEqual(mp4);
  await expect(stat(framePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(audioFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('conforms a start frame and suppresses its song upload', async () => {
  const audioFilePath = join(root, 'song.wav');
  await writeFile(audioFilePath, Buffer.from('example WAV payload'));
  const job = await higgsfield.generateVideo({
    apiKey, prompt: 'A dancer turns', sourceImagePath: framePath, frameAspect: '1:1', audioFilePath,
  });
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
  expect(uploadHiggsfieldFile.mock.calls.map(([{ contentType }]) => contentType)).toEqual(['image/png']);
  const [{ bytes }] = uploadHiggsfieldFile.mock.calls[0];
  expect(await sharp(bytes).metadata()).toMatchObject({ width: 24, height: 24 });
  expect(submitHiggsfieldRequest).toHaveBeenCalledWith(expect.objectContaining({
    endpoint: 'bytedance/seedance-2.5/image-to-video', body: expect.objectContaining({ image_url: imageUrl }),
  }));
  expect(submitHiggsfieldRequest.mock.calls[0][0].body).not.toHaveProperty('audio_urls');
  expect((await loadHistory())[0]).toMatchObject({ notice: expect.stringContaining('Rendered without song audio') });
});

it('stops a canceled frame upload handoff before submitting a paid render', async () => {
  const upload = Promise.withResolvers();
  uploadHiggsfieldFile.mockReturnValueOnce(upload.promise);
  const job = await higgsfield.generateVideo({ apiKey, sourceImagePath: framePath, uploadedTempPath: framePath });
  try {
    await vi.waitFor(() => expect(uploadHiggsfieldFile).toHaveBeenCalled());
    expect(higgsfield.cancel(job.jobId)).toBe(true);
    expect(uploadHiggsfieldFile.mock.calls[0][0].signal.aborted).toBe(true);
  } finally {
    // The upload may finish as its cancellation arrives; the adapter must still gate submission.
    upload.resolve(imageUrl);
  }
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Canceled' });
  expect(submitHiggsfieldRequest).not.toHaveBeenCalled();
  await expect(stat(framePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels the remote request when polling fails after submission', async () => {
  awaitHiggsfieldRequest.mockRejectedValueOnce(new Error('Status transport failed'));
  const job = await higgsfield.generateVideo({ apiKey, prompt: 'A dancer turns' });
  expect(await waitForTerminal(job.jobId)).toMatchObject({
    type: 'failed', error: expect.stringContaining('Status transport failed'),
  });
  expect(cancelHiggsfieldRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    apiKey, requestId: remote.requestId, cancelUrl: remote.cancelUrl,
  }));
  expect(fetchWithTimeout).not.toHaveBeenCalled();
  expect(autoDeleteHostedCopy).not.toHaveBeenCalled();
  expect(await loadHistory()).toEqual([]);
});

it('discards a download canceled during publication without deleting the hosted copy', async () => {
  const measurement = Promise.withResolvers();
  probeVideoGeometry.mockReturnValueOnce(measurement.promise);
  const job = await higgsfield.generateVideo({ apiKey, prompt: 'A dancer turns' });
  const outputPath = join(PATHS.videos, job.filename);
  try {
    await vi.waitFor(() => expect(probeVideoGeometry).toHaveBeenCalledWith(outputPath));
    expect(await readFile(outputPath)).toEqual(mp4);
    expect(higgsfield.cancel(job.jobId)).toBe(true);
  } finally {
    measurement.resolve(geometry);
  }
  expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: 'Canceled' });
  await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await loadHistory()).toEqual([]);
  expect(autoDeleteHostedCopy).not.toHaveBeenCalled();
});
