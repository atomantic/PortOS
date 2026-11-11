import { generateKeyPairSync } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: { markCurrentUnsettled: vi.fn() } }));
const { fetchWithTimeout } = await import('../lib/fetchWithTimeout.js');
const { maintenance } = await import('../lib/maintenanceAdmission.js');
const {
  __resetGoogleTokenCache, awaitGoogleOperation, googleExpressModeRefusal, createGoogleOperationEntry, resolveGoogleConfig,
  submitGoogleOperation, googleModelUrl, googlePost,
} = await import('./googleCloudApi.js');

const json = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  type: 'service_account', project_id: 'example-project', client_email: 'renderer@example-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

beforeEach(() => {
  fetchWithTimeout.mockReset();
  maintenance.markCurrentUnsettled.mockReset();
  __resetGoogleTokenCache();
});

describe('resolveGoogleConfig', () => {
  it('reads an API key as express mode until a project is set', () => {
    const express = resolveGoogleConfig({ videoGen: { google: { apiKey: 'AQ.example' } } });
    expect(express).toMatchObject({ credential: { kind: 'apiKey', apiKey: 'AQ.example' }, projectId: null, location: 'us-central1' });
    expect(googleModelUrl(express, 'imagen-4.0-generate-001', 'predict'))
      .toBe('https://aiplatform.googleapis.com/v1/publishers/google/models/imagen-4.0-generate-001:predict');
    const regional = resolveGoogleConfig({ videoGen: { google: { apiKey: 'AQ.example', projectId: 'example-project', location: 'europe-west4' } } });
    expect(googleModelUrl(regional, 'veo-3.1-generate-001', 'predictLongRunning'))
      .toBe('https://europe-west4-aiplatform.googleapis.com/v1/projects/example-project/locations/europe-west4/publishers/google/models/veo-3.1-generate-001:predictLongRunning');
    expect(googleModelUrl(regional, 'gemini-3-pro-image', 'generateContent', { location: 'global' }))
      .toBe('https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-3-pro-image:generateContent');
  });

  it('takes the project from a service account key and refuses JSON that is not one', () => {
    expect(resolveGoogleConfig({ videoGen: { google: { apiKey: serviceAccount } } }))
      .toMatchObject({ credential: { kind: 'serviceAccount' }, projectId: 'example-project' });
    expect(() => resolveGoogleConfig({ videoGen: { google: { apiKey: '{"type":"authorized_user"}' } } })).toThrow(/not a service account key/);
    expect(resolveGoogleConfig({ videoGen: { google: {} } })).toBeNull();
  });
});

describe('googleExpressModeRefusal', () => {
  it('refuses a model outside the express-mode list only when no project is set', () => {
    const express = resolveGoogleConfig({ videoGen: { google: { apiKey: 'AQ.example' } } });
    expect(googleExpressModeRefusal(express, { label: 'Veo 3.1' })).toMatch(/not available in Agent Platform express mode/);
    expect(googleExpressModeRefusal(express, { label: 'Nano Banana Pro', expressMode: true })).toBeNull();
    const project = resolveGoogleConfig({ videoGen: { google: { apiKey: 'AQ.example', projectId: 'example-project' } } });
    expect(googleExpressModeRefusal(project, { label: 'Veo 3.1' })).toBeNull();
  });
});

describe('googlePost', () => {
  it('signs a service account JWT once and reuses the token', async () => {
    const config = resolveGoogleConfig({ videoGen: { google: { apiKey: serviceAccount } } });
    fetchWithTimeout
      .mockResolvedValueOnce(json(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { ok: 1 }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    await googlePost(config, 'https://example.com/a', {});
    await googlePost(config, 'https://example.com/b', {});
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchWithTimeout.mock.calls[0];
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(tokenInit.body).get('assertion');
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'renderer@example-project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/cloud-platform' });
    expect(fetchWithTimeout.mock.calls[2][1].headers.Authorization).toBe('Bearer tok-1');
  });

  it('marks a billed call unsettled on a lost response or 5xx, not on a 4xx', async () => {
    const config = resolveGoogleConfig({ videoGen: { google: { apiKey: 'k' } } });
    fetchWithTimeout.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(googlePost(config, 'https://example.com', {})).rejects.toThrow('socket hang up');
    fetchWithTimeout.mockResolvedValueOnce(json(400, { error: { message: 'bad aspect ratio' } }));
    await expect(googlePost(config, 'https://example.com', {})).rejects.toThrow('HTTP 400 — bad aspect ratio');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(1);
    fetchWithTimeout.mockResolvedValueOnce(json(503, {}));
    await expect(googlePost(config, 'https://example.com', {})).rejects.toThrow('HTTP 503');
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeout.mock.calls[0][1].headers['x-goog-api-key']).toBe('k');
  });
});

describe('Veo operations', () => {
  const config = { credential: { kind: 'apiKey', apiKey: 'k' }, projectId: null, location: 'us-central1' };

  it('submits, rides out a failed status check and returns the response', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(json(200, { name: 'projects/p/operations/op1' }))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { done: false }))
      .mockResolvedValueOnce(json(200, { done: true, response: { videos: [{ bytesBase64Encoded: 'AAAA' }] } }));
    const entry = createGoogleOperationEntry();
    entry.operationName = await submitGoogleOperation(config, 'veo-3.1-generate-001', { instances: [] });
    const out = await awaitGoogleOperation({ entry, config, modelId: 'veo-3.1-generate-001', deadline: Date.now() + 10_000, timeoutMs: 10_000, pollIntervalMs: 1 });
    expect(out).toEqual({ outcome: 'completed', response: { videos: [{ bytesBase64Encoded: 'AAAA' }] } });
    expect(fetchWithTimeout.mock.calls[1][0]).toMatch(/:fetchPredictOperation$/);
    expect(JSON.parse(fetchWithTimeout.mock.calls[1][1].body)).toEqual({ operationName: 'projects/p/operations/op1' });
    expect(maintenance.markCurrentUnsettled).not.toHaveBeenCalled();
  });

  it('marks an abandoned operation unsettled because Veo has no cancel', async () => {
    const entry = createGoogleOperationEntry();
    entry.operationName = 'op';
    entry.aborted = true;
    const out = await awaitGoogleOperation({ entry, config, modelId: 'veo-3.1-generate-001', deadline: Date.now() + 10_000, timeoutMs: 10_000 });
    expect(out).toEqual({ outcome: 'canceled' });
    expect(maintenance.markCurrentUnsettled).toHaveBeenCalledTimes(1);
  });

  it('reports a failed operation with its message', async () => {
    fetchWithTimeout.mockResolvedValueOnce(json(200, { done: true, error: { message: 'quota exceeded' } }));
    const entry = createGoogleOperationEntry();
    entry.operationName = 'op';
    const out = await awaitGoogleOperation({ entry, config, modelId: 'veo-3.1-generate-001', deadline: Date.now() + 10_000, timeoutMs: 10_000 });
    expect(out).toEqual({ outcome: 'failed', reason: 'Google render failed: quota exceeded' });
  });
});
