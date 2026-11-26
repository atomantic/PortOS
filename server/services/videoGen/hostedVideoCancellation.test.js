import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATHS } from '../../lib/paths.js';
import { cleanupTempDataRoots, mockTestIdentity } from '../../lib/mockPathsDataRoot.js';
import { videoGenEvents } from './events.js';
import * as google from './google.js';
import * as higgsfield from './higgsfield.js';
import { loadHistory } from './history.js';

const probe = vi.hoisted(() => vi.fn());
vi.mock('../../lib/paths.js', async (load) => {
  const { lazyTempDataRoot, makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await load(), {
    dataRoot: () => lazyTempDataRoot('portos-hosted-video-adapter-cancel-'),
  });
});
vi.mock('../../lib/ffmpeg.js', () => ({
  probeVideoGeometry: probe,
  optimizeForStreaming: vi.fn(),
  generateThumbnail: vi.fn(),
  probeFrameCount: vi.fn(),
  probeVideoDuration: vi.fn(),
}));
vi.mock('../instanceIdentity.js', () => mockTestIdentity());
vi.mock('../peerSyncEventBus.js', () => ({ announceLocalVideoRows: () => {} }));
vi.mock('../higgsfieldApi.js', () => ({
  createHiggsfieldRequestEntry: () => ({ controller: new AbortController() }),
  resolveHiggsfieldApiKey: () => 'example-key',
  uploadHiggsfieldFile: vi.fn(),
  submitHiggsfieldRequest: async () => ({ requestId: 'request', statusUrl: 'status' }),
  awaitHiggsfieldRequest: async () => ({ outcome: 'completed', outputUrl: 'https://example.com/result.mp4' }),
  cancelHiggsfieldRequest: vi.fn(),
}));
vi.mock('../googleCloudApi.js', () => ({
  createGoogleOperationEntry: () => ({ controller: new AbortController() }),
  resolveGoogleConfig: () => ({ projectId: 'example-project' }),
  googleExpressModeRefusal: () => null,
  submitGoogleOperation: async () => 'operation',
  awaitGoogleOperation: async () => ({ outcome: 'completed', response: { videos: [{ bytesBase64Encoded: 'YQ==' }] } }),
  abandonGoogleOperation: vi.fn(),
  googleFilteredReason: vi.fn(),
  googleInlineImage: vi.fn(),
}));
vi.mock('../hostedRenderRemoteDelete.js', () => ({ autoDeleteHostedCopy: vi.fn() }));

beforeEach(() => {
  probe.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('a')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(cleanupTempDataRoots);

describe('hosted video cancellation before publication', () => {
  it.each([['Google', google], ['Higgsfield', higgsfield]])('keeps a %s cancellation received during geometry probing out of history', async (label, provider) => {
    const probing = Promise.withResolvers();
    const geometryReady = Promise.withResolvers();
    probe.mockImplementation((path) => {
      probing.resolve(path);
      return geometryReady.promise;
    });
    const jobId = `probe-cancel-${label}`;
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    try {
      const job = await provider.generateVideo({ jobId, settings: {}, apiKey: 'example-key', prompt: 'A dancer turns' });
      const output = join(PATHS.videos, job.filename);
      try {
        expect(await probing.promise).toBe(output);
        await expect(readFile(output, 'utf8')).resolves.toBe('a');
        expect(provider.cancel(jobId)).toBe(true);
      } finally {
        geometryReady.resolve({ durationSec: 5 });
        await vi.waitFor(() => expect(failed).toHaveBeenCalledExactlyOnceWith({ generationId: jobId, error: 'Canceled' }));
      }

      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await loadHistory()).toEqual([]);
      expect(provider.getActiveJob()).toBeNull();
      expect(provider.cancel(jobId)).toBe(false);
    } finally {
      videoGenEvents.off('failed', failed);
    }
  });
});
