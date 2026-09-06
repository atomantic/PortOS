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
vi.mock('../../lib/imageClean.js', () => ({ autoCleanGeneratedImage: vi.fn() }));
vi.mock('../imageGenEvents.js', () => ({ imageGenEvents }));

import { generateImage, getActiveJob } from './external.js';

const response = (json) => ({ ok: true, json: vi.fn().mockResolvedValue(json) });

beforeEach(() => {
  fetchWithTimeout.mockReset();
  imageGenEvents.emit.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('external image generation lifecycle', () => {
  it('clears activeJob and emits a failure when a terminal response cannot be read', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(response({ sd_model_checkpoint: 'example-model' }))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('malformed response')) });

    await expect(generateImage({ sdapiUrl: 'http://example.com', prompt: 'a test image' }))
      .rejects.toThrow('malformed response');

    expect(getActiveJob()).toBeNull();
    expect(imageGenEvents.emit).toHaveBeenCalledWith('failed', expect.objectContaining({ error: 'malformed response' }));
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
