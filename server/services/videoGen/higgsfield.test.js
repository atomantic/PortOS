import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ submit: vi.fn(async () => ({ requestId: 'request', statusUrl: 'status' })), finalize: vi.fn(async () => {}) }));
vi.mock('fs/promises', async (load) => ({ ...await load(), readFile: vi.fn(async () => Buffer.from('audio')), writeFile: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', async (load) => ({ ...await load(), ensureDir: vi.fn(async () => {}) }));
vi.mock('../higgsfieldApi.js', () => ({
  createHiggsfieldRequestEntry: () => ({ controller: new AbortController() }),
  resolveHiggsfieldApiKey: () => 'example-key',
  uploadHiggsfieldFile: async ({ contentType }) => contentType === 'audio/wav' ? 'https://example.com/song.wav' : 'https://example.com/cast.png',
  submitHiggsfieldRequest: m.submit,
  awaitHiggsfieldRequest: async () => ({ outcome: 'completed', outputUrl: 'https://example.com/result.mp4' }),
  cancelHiggsfieldRequest: vi.fn(),
}));
vi.mock('./falFrameAspect.js', () => ({ frameDataUriAtAspect: async () => ({ dataUri: 'data:image/png;base64,YQ==' }) }));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) }));
vi.mock('../../lib/ffmpeg.js', () => ({ probeVideoGeometry: async () => ({}) }));
vi.mock('./generateVideoHelpers.js', () => ({ finalizeGeneratedVideo: m.finalize, discardUnpublishedVideo: vi.fn(), emitCloudRenderStatus: vi.fn(), CLOUD_RENDER_PHASE: {} }));
vi.mock('../../lib/sseUtils.js', () => ({ attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn(), createJobFailureFinalizer: () => vi.fn() }));
vi.mock('../hostedRenderRemoteDelete.js', () => ({ autoDeleteHostedCopy: vi.fn() }));

import { generateVideo } from './higgsfield.js';

describe('Higgsfield sent request history', () => {
  it('records the actual uploaded request and carried prompt additions without a paid API call', async () => {
    const prompt = '  A dancer turns  ';
    const addition = { id: 'shot', label: 'Shot direction', text: 'Turn toward the camera' };
    await generateVideo({ apiKey: 'example-key', prompt, promptAdditions: [addition], referenceImagePaths: ['/mock/cast.png'], audioFilePath: '/mock/song.wav' });
    await vi.waitFor(() => expect(m.finalize).toHaveBeenCalled());
    const sent = m.submit.mock.calls[0][0];
    const { meta } = m.finalize.mock.calls[0][0];
    expect(sent.endpoint).toBe('bytedance/seedance-2.5/reference-to-video');
    expect(meta.sentRequest).toEqual({ endpoint: sent.endpoint, body: sent.body });
    expect(meta.sentRequest.body).toMatchObject({ prompt, image_urls: ['https://example.com/cast.png'], audio_urls: ['https://example.com/song.wav'] });
    expect(meta.sentPrompt).toBe(prompt);
    expect(meta.promptAdditions).toContainEqual(addition);
  });
});
