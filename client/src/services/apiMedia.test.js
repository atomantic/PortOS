import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cleanImage / fetchCleanResult call global fetch() directly (Blob body + custom
// header, which the JSON-oriented request() helper can't surface). saveCleanResult
// goes through request(). Mock both layers.
const request = vi.fn();
vi.mock('./apiCore.js', () => {
  // Mirrors the real apiCore.throwApiError, including the maybeRedirectToLogin
  // call — routing through the SAME mock the test file asserts against, so a
  // regression in the consumer-side auth-redirect contract actually fails
  // these tests instead of a mock that silently drops the side effect.
  const maybeRedirectToLogin = vi.fn();
  const throwApiError = vi.fn(async (response) => {
    // Mirrors apiCore's own null-safety: a valid JSON body that isn't an
    // object (e.g. a bare `null`) has no `.error`/`.code`/`.context` to read,
    // so it falls back to the same HTTP-status shape as non-JSON bodies.
    const parsedError = await response.json().catch(() => null);
    const error =
      parsedError && typeof parsedError === 'object' ? parsedError : { error: `HTTP ${response.status}` };
    maybeRedirectToLogin(response, error);
    const err = new Error(error.error || `HTTP ${response.status}`);
    err.code = error?.code;
    err.status = response.status;
    if (error?.context) err.context = error.context;
    throw err;
  });
  return {
    request: (...a) => request(...a),
    API_BASE: '/api',
    maybeRedirectToLogin,
    throwApiError,
  };
});

let cleanImage;
let fetchCleanResult;
let saveCleanResult;
let maybeRedirectToLogin;

beforeEach(async () => {
  vi.resetModules();
  request.mockReset();
  ({ cleanImage, fetchCleanResult, saveCleanResult } = await import('./apiMedia.js'));
  ({ maybeRedirectToLogin } = await import('./apiCore.js'));
  maybeRedirectToLogin.mockClear();
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Minimal fetch Response stub. `blob()` returns a Blob-like with a `.type`.
const makeResponse = ({ status = 200, ok = status < 400, headers = {}, json = null, blobType = 'image/png' } = {}) => ({
  status,
  ok,
  headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
  json: async () => json,
  blob: async () => ({ type: blobType, size: 123 }),
});

const fakeFile = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, type: 'image/png', name: 'x.png' };

describe('cleanImage', () => {
  it('threads GPU-only strength + maxMp into the query string', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 200, headers: { 'X-Clean-Report': '{"format":"png"}' } }));
    await cleanImage(fakeFile, { metadata: true, diffusion: 'gpu', strength: 0.35, maxMp: 1.5 });
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('diffusion=gpu');
    expect(url).toContain('strength=0.35');
    expect(url).toContain('maxMp=1.5');
  });

  it('returns { gpu:true, job } on a 202 enqueue response', async () => {
    const job = { mode: 'gpu', jobId: 'j1', modelId: 'flux2-klein-4b', strength: 0.25 };
    global.fetch.mockResolvedValue(makeResponse({ status: 202, json: job }));
    const out = await cleanImage(fakeFile, { diffusion: 'gpu' });
    expect(out.gpu).toBe(true);
    expect(out.job.jobId).toBe('j1');
  });

  it('returns the blob + parsed report on a 200 sync response', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 200, headers: { 'X-Clean-Report': '{"format":"png","c2paStripped":true}' } }));
    const out = await cleanImage(fakeFile, { metadata: true });
    expect(out.gpu).toBeUndefined();
    expect(out.report.c2paStripped).toBe(true);
    expect(out.mimeType).toBe('image/png');
  });

  it('throws with the server code on an error response', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 400, ok: false, json: { error: 'No FLUX', code: 'REGEN_BACKEND_UNAVAILABLE' } }));
    await expect(cleanImage(fakeFile, { diffusion: 'gpu' })).rejects.toMatchObject({ code: 'REGEN_BACKEND_UNAVAILABLE' });
  });

  it('forwards structured error.context through the direct-fetch wrapper', async () => {
    const context = { jobId: 'j1', retryable: false };
    global.fetch.mockResolvedValue(
      makeResponse({ status: 409, ok: false, json: { error: 'busy', code: 'ERR_BUSY', context } }),
    );
    await expect(cleanImage(fakeFile, { diffusion: 'gpu' })).rejects.toMatchObject({ context });
  });

  it('honors session expiry the same way request() does (401 AUTH_REQUIRED)', async () => {
    const response = makeResponse({ status: 401, ok: false, json: { error: 'auth required', code: 'AUTH_REQUIRED' } });
    global.fetch.mockResolvedValue(response);
    await expect(cleanImage(fakeFile, { diffusion: 'gpu' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(maybeRedirectToLogin).toHaveBeenCalledWith(response, expect.objectContaining({ code: 'AUTH_REQUIRED' }));
  });
});

describe('fetchCleanResult', () => {
  it('returns { pending:true } while the job is still rendering (409 RESULT_NOT_READY)', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 409, ok: false, json: { code: 'RESULT_NOT_READY' } }));
    const out = await fetchCleanResult('j1');
    expect(out.pending).toBe(true);
  });

  it('returns the finished blob + report on 200', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 200, headers: { 'X-Clean-Report': '{"mode":"gpu","width":8}' } }));
    const out = await fetchCleanResult('j1');
    expect(out.report.mode).toBe('gpu');
    expect(out.mimeType).toBe('image/png');
  });

  it('throws on a hard failure (JOB_FAILED)', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 409, ok: false, json: { error: 'runner OOM', code: 'JOB_FAILED' } }));
    await expect(fetchCleanResult('j1')).rejects.toMatchObject({ code: 'JOB_FAILED' });
  });

  it('throws on a 404 (result gone / unknown id)', async () => {
    global.fetch.mockResolvedValue(makeResponse({ status: 404, ok: false, json: { error: 'not found', code: 'NOT_FOUND' } }));
    await expect(fetchCleanResult('j1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('saveCleanResult', () => {
  it('POSTs to the save endpoint (silent) and returns the gallery record', async () => {
    request.mockResolvedValue({ filename: 'upload-abc.png', path: '/data/images/upload-abc.png' });
    const out = await saveCleanResult('j1');
    expect(request).toHaveBeenCalledWith('/image-clean/result/j1/save', expect.objectContaining({ method: 'POST' }));
    expect(out.filename).toBe('upload-abc.png');
  });
});
// @vitest-environment node
