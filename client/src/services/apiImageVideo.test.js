// @vitest-environment node
/**
 * previewLoraInstall's body-serialization boundary — a curated video LoRA
 * card without a `file` (buildCard's `file: entry.file || null`) must not
 * serialize a literal `null`: the route schema's `.optional()` accepts an
 * ABSENT key, not `null`, and JSON.stringify keeps `null` while it drops
 * `undefined`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

let request;
let previewLoraInstall;
let upscaleVideo;
let getUpscalePlan;
let upscaleAdapterDownloadUrl;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ previewLoraInstall, upscaleVideo, getUpscalePlan, upscaleAdapterDownloadUrl } = await import('./apiImageVideo.js'));
  request.mockReset();
});

describe('previewLoraInstall', () => {
  it('omits family/file from the body when the card carries them as null', async () => {
    request.mockResolvedValue({ verdict: 'ok' });
    await previewLoraInstall({ url: 'https://huggingface.co/org/repo', source: 'huggingface', family: null, file: null });

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({ url: 'https://huggingface.co/org/repo', source: 'huggingface' });
    expect(body).not.toHaveProperty('family');
    expect(body).not.toHaveProperty('file');
  });

  it('includes family/file when the caller provides them', async () => {
    request.mockResolvedValue({ verdict: 'ok' });
    await previewLoraInstall({ url: 'https://huggingface.co/org/repo', source: 'huggingface', family: 'ltx-video', file: 'weights.safetensors' });

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({
      url: 'https://huggingface.co/org/repo',
      source: 'huggingface',
      family: 'ltx-video',
      file: 'weights.safetensors',
    });
  });
});

describe('upscaleVideo', () => {
  it('sends a bare POST with no body when method is omitted (#6510 back-compat)', async () => {
    request.mockResolvedValue({ ok: true, video: {} });
    await upscaleVideo('abc', { silent: true });

    expect(request).toHaveBeenCalledWith('/video-gen/upscale/abc', { method: 'POST', silent: true });
    expect(request.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('sends { method: "lanczos" } in the body when explicitly chosen', async () => {
    request.mockResolvedValue({ ok: true, video: {} });
    await upscaleVideo('abc', { method: 'lanczos', silent: true });

    const [url, opts] = request.mock.calls[0];
    expect(url).toBe('/video-gen/upscale/abc');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ method: 'lanczos' });
    expect(opts.silent).toBe(true);
  });

  it('sends { method: "ltx" } in the body for the generative method', async () => {
    request.mockResolvedValue({ ok: true, video: {} });
    await upscaleVideo('abc', { method: 'ltx', silent: true });

    const opts = request.mock.calls[0][1];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ method: 'ltx' });
  });
});

describe('getUpscalePlan', () => {
  it('is a silent GET against the read-only plan endpoint', async () => {
    request.mockResolvedValue({ ok: true, plan: {} });
    await getUpscalePlan('abc', 'ltx');

    expect(request).toHaveBeenCalledWith('/video-gen/upscale/abc/plan?method=ltx', { silent: true });
  });
});

describe('upscaleAdapterDownloadUrl', () => {
  it('builds the shared IC-LoRA download URL for a given key', () => {
    expect(upscaleAdapterDownloadUrl('pixel-upscale')).toBe('/api/video-gen/ic-loras/pixel-upscale/download');
  });

  it('returns null with no key rather than a malformed URL', () => {
    expect(upscaleAdapterDownloadUrl(null)).toBeNull();
  });
});
