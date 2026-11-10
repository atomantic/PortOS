import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: { markCurrentUnsettled: vi.fn() } }));
const { fetchWithTimeout } = await import('../lib/fetchWithTimeout.js');
const { maintenance } = await import('../lib/maintenanceAdmission.js');
const {
  awaitHiggsfieldRequest, createHiggsfieldRequestEntry, submitHiggsfieldRequest, uploadHiggsfieldFile,
} = await import('./higgsfieldApi.js');

const json = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload, body: { cancel: async () => {} } });

beforeEach(() => {
  fetchWithTimeout.mockReset();
  maintenance.markCurrentUnsettled.mockReset();
});

describe('submitHiggsfieldRequest', () => {
  it('sends the key and an idempotency key, and returns the queue handles', async () => {
    fetchWithTimeout.mockResolvedValueOnce(json(200, { status: 'queued', request_id: 'r1', status_url: 'https://api.higgsfield.ai/requests/r1/status' }));
    const out = await submitHiggsfieldRequest({ apiKey: 'id:secret', endpoint: 'bytedance/seedance-2.5/text-to-video', body: { prompt: 'p' } });
    const [url, init] = fetchWithTimeout.mock.calls[0];
    expect(url).toBe('https://api.higgsfield.ai/bytedance/seedance-2.5/text-to-video');
    expect(init.headers.Authorization).toBe('Key id:secret');
    expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
    expect(out).toEqual({ requestId: 'r1', statusUrl: 'https://api.higgsfield.ai/requests/r1/status', cancelUrl: 'https://api.higgsfield.ai/requests/r1/cancel' });
  });

  it('marks the run unsettled when the POST response is lost, but not on a 4xx refusal', async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(submitHiggsfieldRequest({ apiKey: 'k', endpoint: 'e', body: {} })).rejects.toThrow('socket hang up');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(1);
    fetchWithTimeout.mockResolvedValueOnce(json(422, { detail: [{ loc: ['body', 'duration'], msg: 'too long' }] }));
    await expect(submitHiggsfieldRequest({ apiKey: 'k', endpoint: 'e', body: {} })).rejects.toThrow('HTTP 422 — duration: too long');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(1);
  });
});

describe('uploadHiggsfieldFile', () => {
  it('puts the bytes to the signed URL without the API key', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(json(200, { public_url: 'https://cdn.example.com/a.png', upload_url: 'https://upload.example.com/a', upload_headers: { 'x-amz-acl': 'public-read' } }))
      .mockResolvedValueOnce(json(200, {}));
    const url = await uploadHiggsfieldFile({ apiKey: 'k', bytes: Buffer.from('x'), contentType: 'image/png' });
    expect(url).toBe('https://cdn.example.com/a.png');
    const [, put] = fetchWithTimeout.mock.calls[1];
    expect(put.method).toBe('PUT');
    expect(put.headers).toEqual({ 'Content-Type': 'image/png', 'x-amz-acl': 'public-read' });
  });
});

describe('awaitHiggsfieldRequest', () => {
  const poll = (entry, overrides = {}) => awaitHiggsfieldRequest({
    entry, apiKey: 'k', statusUrl: 'https://api.higgsfield.ai/requests/r1/status', kind: 'video',
    deadline: Date.now() + 10_000, timeoutMs: 10_000, pollIntervalMs: 1, ...overrides,
  });

  it('rides out a transient status failure and returns the output URL', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { status: 'in_progress' }))
      .mockResolvedValueOnce(json(200, { status: 'completed', video: { url: 'https://cdn.example.com/v.mp4' } }));
    const onStatus = vi.fn();
    const out = await poll(createHiggsfieldRequestEntry('k'), { onStatus });
    expect(out).toEqual({ outcome: 'completed', outputUrl: 'https://cdn.example.com/v.mp4' });
    expect(onStatus).toHaveBeenCalledWith('in_progress');
  });

  it('reports moderation and failure reasons', async () => {
    fetchWithTimeout.mockResolvedValueOnce(json(200, { status: 'nsfw' }));
    expect(await poll(createHiggsfieldRequestEntry('k'))).toEqual({ outcome: 'failed', reason: 'Higgsfield moderation rejected the output (nsfw)' });
    fetchWithTimeout.mockResolvedValueOnce(json(200, { status: 'failed', error: 'bad frame' }));
    expect((await poll(createHiggsfieldRequestEntry('k'))).reason).toBe('Higgsfield render failed: bad frame');
  });

  it('cancels a still-queued request once when the local job is aborted, and marks it unsettled', async () => {
    const entry = createHiggsfieldRequestEntry('k');
    entry.cancelUrl = 'https://api.higgsfield.ai/requests/r1/cancel';
    entry.aborted = true;
    fetchWithTimeout.mockResolvedValueOnce(json(202, {}));
    expect(await poll(entry)).toEqual({ outcome: 'canceled' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeout.mock.calls[0][0]).toBe('https://api.higgsfield.ai/requests/r1/cancel');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalled();
  });
});
