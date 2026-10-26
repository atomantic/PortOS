import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithTimeout, imageGenEvents } = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  imageGenEvents: { emit: vi.fn() },
}));

vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  atomicWrite: vi.fn(),
  PATHS: { images: '/tmp/portos-external-image-test' },
}));
vi.mock('./frameGuard.js', () => ({ rejectDegenerateFrame: async () => null }));
vi.mock('../../lib/imageClean.js', () => ({ autoCleanGeneratedImage: vi.fn() }));
vi.mock('../imageGenEvents.js', () => ({ imageGenEvents }));

import { atomicWrite } from '../../lib/fileUtils.js';
import { naturalUniverseVisualProfile } from '../../lib/universeVisualProfile.js';
import { generateImage, getActiveJob } from './external.js';

const response = (json) => ({ ok: true, json: vi.fn().mockResolvedValue(json) });

beforeEach(() => {
  fetchWithTimeout.mockReset();
  imageGenEvents.emit.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('external image generation lifecycle', () => {
  it('keeps the prompt and private endpoint out of logs without changing the render request', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompt = 'Example private portrait for alice@example.com';
    const sdapiUrl = 'https://example.com/private-model?key=example-secret';
    fetchWithTimeout.mockImplementation(async (url) => {
      if (url.endsWith('/txt2img')) throw new Error('stop after payload');
      return response({ sd_model_checkpoint: 'example-model', progress: 0, state: {} });
    });

    try {
      await expect(generateImage({ sdapiUrl, prompt })).rejects.toThrow('stop after payload');
      const [url, init] = fetchWithTimeout.mock.calls.find(([url]) => url.endsWith('/txt2img'));
      expect(url).toBe('https://example.com/sdapi/v1/txt2img');
      expect(JSON.parse(init.body).prompt).toBe(prompt);
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/alice@example\.com|Example private portrait|example\.com|example-secret/);
    } finally {
      log.mockRestore();
    }
  });

  it('clears activeJob and emits a failure when a terminal response cannot be read', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response({ sd_model_checkpoint: 'example-model' }))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('malformed response')) });

    await expect(generateImage({ sdapiUrl: 'http://example.com', prompt: 'a test image' }))
      .rejects.toThrow('malformed response');

    expect(getActiveJob()).toBeNull();
    expect(imageGenEvents.emit).toHaveBeenCalledWith('failed', expect.objectContaining({ error: 'malformed response' }));
  });

  it('sends no negative prompt unless the caller supplies one', async () => {
    // A built-in default ("blurry, low quality, …") used to be injected here and
    // fought deliberately soft, grainy looks; empty means the model gets none.
    fetchWithTimeout.mockImplementation(async (url) => {
      if (url.endsWith('/txt2img')) throw new Error('stop after payload');
      return response({ sd_model_checkpoint: 'example-model', progress: 0, state: {} });
    });

    await expect(generateImage({ sdapiUrl: 'http://example.com', prompt: 'a test image' }))
      .rejects.toThrow('stop after payload');

    const [, init] = fetchWithTimeout.mock.calls.find(([url]) => url.endsWith('/txt2img'));
    expect(JSON.parse(init.body).negative_prompt).toBe('');
  });

  it('clears the polling interval when an unexpected progress handler error occurs', async () => {
    vi.useFakeTimers();
    const progressError = new Error('progress handler failed');
    imageGenEvents.emit.mockImplementation((event) => {
      if (event === 'progress') throw progressError;
    });
    let resolveGeneration;
    const generation = new Promise((resolve) => { resolveGeneration = resolve; });
    fetchWithTimeout
      .mockResolvedValueOnce(response({ sd_model_checkpoint: 'example-model' }))
      .mockReturnValueOnce(generation)
      .mockResolvedValueOnce(response({ progress: 0.5, state: {} }));

    const pending = generateImage({ sdapiUrl: 'http://example.test', prompt: 'a test image' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('progress handler failed'));
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    resolveGeneration(response({ images: ['aW1hZ2U='] }));
    await pending;
    vi.useRealTimers();
  });

});

it('publishes a source sidecar with exact prompt and profile facts for optional finishing', async () => {
  fetchWithTimeout.mockImplementation(async url => response(url.endsWith('/txt2img') ? { images: ['aGVsbG8='] } : { sd_model_checkpoint: 'example-model' }));
  const profile = naturalUniverseVisualProfile();
  const result = await generateImage({ sdapiUrl: 'http://example.test', prompt: 'Exact source prompt', visualProfile: profile, visualProfileRevision: 'example-revision' });
  const write = atomicWrite.mock.calls.find(([path]) => path.endsWith(result.filename.replace('.png', '.metadata.json')));
  expect(write).toBeDefined();
  expect(JSON.parse(write[1])).toMatchObject({ prompt: 'Exact source prompt', visualProfile: profile, visualProfileRevision: 'example-revision', mode: 'external' });
});
