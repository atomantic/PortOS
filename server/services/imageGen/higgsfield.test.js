import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  snapshot: vi.fn(), upload: vi.fn(), submit: vi.fn(), failure: vi.fn(), canceled: vi.fn(),
}));
vi.mock('../../lib/fileUtils.js', async (load) => ({ ...await load(), ensureDir: vi.fn(async () => {}) }));
vi.mock('./inputImages.js', () => ({ resolveInputImages: () => ({ initPath: null, referencePaths: ['/mock/ref.png'], paths: ['/mock/ref.png'] }) }));
vi.mock('./reviewedReference.js', () => ({ assertSnapshotForAdapter: m.snapshot }));
vi.mock('../higgsfieldApi.js', () => ({
  createHiggsfieldRequestEntry: () => ({ controller: new AbortController() }),
  resolveHiggsfieldApiKey: () => 'example-key',
  uploadHiggsfieldImage: m.upload,
  submitHiggsfieldRequest: m.submit,
  awaitHiggsfieldRequest: async () => ({ outcome: 'failed', reason: 'synthetic terminal result' }),
  cancelHiggsfieldRequest: vi.fn(),
}));
vi.mock('../../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(), attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn(), dispatchTerminalEvent: vi.fn(),
  createJobFailureFinalizer: () => Object.assign(m.failure, { canceled: m.canceled }),
}));

import { cancel, generateImage } from './higgsfield.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  m.snapshot.mockResolvedValue(null);
  m.upload.mockResolvedValue('https://example.com/ref.png');
  m.submit.mockResolvedValue({ requestId: 'synthetic', statusUrl: 'status' });
});

describe('Higgsfield image submission boundaries', () => {
  const params = (jobId) => ({ jobId, apiKey: 'example-key', model: 'alibaba/qwen-image-3/text-to-image', prompt: 'A dancer turns', referenceImagePaths: ['/mock/ref.png'] });

  it('honors a cancellation during preparation before uploading any private reference', async () => {
    let release;
    m.snapshot.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = generateImage(params('pending-cancel'));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(cancel('pending-cancel')).toBe('pending');
    release(null);
    await pending;
    await vi.waitFor(() => expect(m.canceled).toHaveBeenCalled());
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it('refuses a paid submission when reference uploads consumed the render deadline', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    m.upload.mockImplementation(async () => {
      now.mockReturnValue(1000 + 24 * 60 * 60 * 1000);
      return 'https://example.com/ref.png';
    });
    await generateImage(params('expired-upload'));
    await vi.waitFor(() => expect(m.failure).toHaveBeenCalled());
    expect(m.failure.mock.calls[0][3]).toMatch(/deadline elapsed before submission/);
    expect(m.submit).not.toHaveBeenCalled();
  });
});
