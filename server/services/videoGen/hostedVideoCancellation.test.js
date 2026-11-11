import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ probe: vi.fn(), unlink: vi.fn(), finalize: vi.fn(), canceled: vi.fn(), failure: vi.fn() }));
vi.mock('fs/promises', async (load) => ({ ...await load(), writeFile: vi.fn(async () => {}), unlink: m.unlink }));
vi.mock('../../lib/fileUtils.js', async (load) => ({ ...await load(), ensureDir: vi.fn(async () => {}) }));
vi.mock('../../lib/ffmpeg.js', () => ({ probeVideoGeometry: m.probe }));
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
  abandonGoogleOperation: vi.fn(), googleFilteredReason: vi.fn(), googleInlineImage: vi.fn(),
}));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) }));
vi.mock('./generateVideoHelpers.js', () => ({ finalizeGeneratedVideo: m.finalize, discardUnpublishedVideo: vi.fn(), emitCloudRenderStatus: vi.fn(), CLOUD_RENDER_PHASE: {} }));
vi.mock('../../lib/sseUtils.js', () => ({ attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn(), createJobFailureFinalizer: () => Object.assign(m.failure, { canceled: m.canceled }) }));
vi.mock('../hostedRenderRemoteDelete.js', () => ({ autoDeleteHostedCopy: vi.fn() }));

import * as google from './google.js';
import * as higgsfield from './higgsfield.js';

beforeEach(() => {
  vi.clearAllMocks();
  m.unlink.mockResolvedValue(undefined);
});

describe('hosted video cancellation before publication', () => {
  it.each([['Google', google], ['Higgsfield', higgsfield]])('keeps a %s cancellation received during geometry probing out of history', async (label, provider) => {
    let release;
    m.probe.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const jobId = `probe-cancel-${label}`;
    await provider.generateVideo({ jobId, settings: {}, apiKey: 'example-key', prompt: 'A dancer turns' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(provider.cancel(jobId)).toBe(true);
    release({ durationSec: 5 });
    await vi.waitFor(() => expect(m.canceled).toHaveBeenCalled());
    expect(m.unlink).toHaveBeenCalledWith(expect.stringContaining(`${jobId}.mp4`));
    expect(m.finalize).not.toHaveBeenCalled();
  });
});
