import { describe, it, expect } from 'vitest';
import { mockJsonResponse } from './testHelper.js';
import {
  applyDownloadToken,
  baseModelToRunner,
  buildAuthHeaders,
  buildSidecar,
  detectEarlyAccess,
  fetchCivitaiModel,
  normalizeCivitaiImageUrl,
  parseCivitaiUrl,
  pickPrimaryFile,
  pickPreviewImage,
  pickVersion,
  slugifyForFilename,
} from './civitai.js';

describe('parseCivitaiUrl', () => {
  it('parses canonical /models/<id> URLs', () => {
    expect(parseCivitaiUrl('https://civitai.com/models/2600698')).toEqual({ modelId: '2600698', versionId: null });
  });
  it('strips slug segments', () => {
    expect(parseCivitaiUrl('https://civitai.com/models/2600698/realstagram')).toEqual({ modelId: '2600698', versionId: null });
  });
  it('honors the civitai.red mirror', () => {
    expect(parseCivitaiUrl('https://civitai.red/models/2600698/realstagram')).toEqual({ modelId: '2600698', versionId: null });
  });
  it('extracts modelVersionId when present', () => {
    expect(parseCivitaiUrl('https://civitai.com/models/2600698?modelVersionId=999')).toEqual({ modelId: '2600698', versionId: '999' });
  });
  it('accepts bare model ids', () => {
    expect(parseCivitaiUrl('2600698')).toEqual({ modelId: '2600698', versionId: null });
    expect(parseCivitaiUrl('civitai:2600698')).toEqual({ modelId: '2600698', versionId: null });
  });
  it('rejects non-civitai hosts', () => {
    expect(() => parseCivitaiUrl('https://huggingface.co/models/2600698')).toThrow(/Not a Civitai URL/);
  });
  it('rejects garbage', () => {
    expect(() => parseCivitaiUrl('')).toThrow();
    expect(() => parseCivitaiUrl('not a url')).toThrow();
    expect(() => parseCivitaiUrl('https://civitai.com/users/123')).toThrow(/must point at \/models/);
    expect(() => parseCivitaiUrl('https://civitai.com/models/')).toThrow();
    expect(() => parseCivitaiUrl('https://civitai.com/models/abc')).toThrow();
  });
  it('rejects non-numeric modelVersionId', () => {
    expect(() => parseCivitaiUrl('https://civitai.com/models/123?modelVersionId=abc')).toThrow(/numeric/);
  });
  it('converts URL constructor TypeError into a CIVITAI_BAD_URL ServerError', () => {
    // `new URL('https://[malformed')` throws TypeError("Invalid URL").
    // The function must surface a 400 ServerError, not let the TypeError
    // bubble as a 500.
    expect(() => parseCivitaiUrl('https://[malformed')).toThrow(/Malformed URL/);
  });
});

describe('baseModelToRunner', () => {
  it('maps Flux.1 variants to mflux', () => {
    expect(baseModelToRunner('Flux.1 D')).toBe('mflux');
    expect(baseModelToRunner('Flux.1 S')).toBe('mflux');
    expect(baseModelToRunner('flux 1')).toBe('mflux');
  });
  it('maps Flux.2 variants to flux2', () => {
    expect(baseModelToRunner('Flux.2 Klein')).toBe('flux2');
    expect(baseModelToRunner('flux 2')).toBe('flux2');
  });
  it('maps Z-Image variants to z-image', () => {
    expect(baseModelToRunner('Z-Image Turbo')).toBe('z-image');
    expect(baseModelToRunner('zimage')).toBe('z-image');
  });
  it('maps ERNIE-Image variants to ernie', () => {
    expect(baseModelToRunner('Ernie-Image')).toBe('ernie');
    expect(baseModelToRunner('ERNIE-Image-Turbo')).toBe('ernie');
    expect(baseModelToRunner('ernieimage')).toBe('ernie');
  });
  it('maps HiDream variants to hidream', () => {
    expect(baseModelToRunner('HiDream')).toBe('hidream');
    expect(baseModelToRunner('hidream')).toBe('hidream');
    expect(baseModelToRunner('Hi-Dream')).toBe('hidream');
  });
  it('maps Qwen variants to qwen', () => {
    expect(baseModelToRunner('Qwen')).toBe('qwen');
    expect(baseModelToRunner('qwen-image')).toBe('qwen');
    expect(baseModelToRunner('Qwen Image')).toBe('qwen');
  });
  it('returns null for unsupported families', () => {
    expect(baseModelToRunner('SDXL 1.0')).toBe(null);
    expect(baseModelToRunner('SD 1.5')).toBe(null);
    expect(baseModelToRunner('Pony')).toBe(null);
    expect(baseModelToRunner('')).toBe(null);
    expect(baseModelToRunner(null)).toBe(null);
  });
});

describe('pickVersion', () => {
  const model = {
    id: 1,
    name: 'M',
    modelVersions: [
      { id: 100, baseModel: 'Flux.1 D' },
      { id: 99, baseModel: 'Flux.1 D' },
    ],
  };
  it('returns the first version when no id is given', () => {
    expect(pickVersion(model, null).id).toBe(100);
  });
  it('finds an explicit version id', () => {
    expect(pickVersion(model, '99').id).toBe(99);
  });
  it('throws when the requested version is missing', () => {
    expect(() => pickVersion(model, '404')).toThrow(/version 404 not found/);
  });
  it('throws when the model has no versions', () => {
    expect(() => pickVersion({ modelVersions: [] }, null)).toThrow(/no published versions/);
    expect(() => pickVersion({}, null)).toThrow(/no published versions/);
  });
});

describe('pickPrimaryFile', () => {
  it('prefers files marked primary', () => {
    const v = { files: [
      { name: 'old.safetensors', primary: false },
      { name: 'new.safetensors', primary: true },
    ] };
    expect(pickPrimaryFile(v).name).toBe('new.safetensors');
  });
  it('falls back to first .safetensors when none flagged', () => {
    const v = { files: [
      { name: 'cover.png' },
      { name: 'first.safetensors' },
      { name: 'second.safetensors' },
    ] };
    expect(pickPrimaryFile(v).name).toBe('first.safetensors');
  });
  it('throws when no .safetensors is present', () => {
    expect(() => pickPrimaryFile({ files: [{ name: 'cover.png' }] })).toThrow(/no .safetensors file/);
    expect(() => pickPrimaryFile({})).toThrow(/no .safetensors file/);
  });
});

describe('pickPreviewImage', () => {
  it('returns the lowest-NSFW image', () => {
    const v = { images: [
      { url: 'spicy.jpg', nsfwLevel: 8 },
      { url: 'mild.jpg', nsfwLevel: 1 },
      { url: 'mid.jpg', nsfwLevel: 4 },
    ] };
    expect(pickPreviewImage(v).url).toBe('mild.jpg');
  });
  it('returns null for an empty list', () => {
    expect(pickPreviewImage({ images: [] })).toBe(null);
    expect(pickPreviewImage({})).toBe(null);
  });
});

describe('buildAuthHeaders / applyDownloadToken', () => {
  it('returns empty headers for empty key', () => {
    expect(buildAuthHeaders('')).toEqual({});
    expect(buildAuthHeaders(null)).toEqual({});
  });
  it('builds a Bearer header', () => {
    expect(buildAuthHeaders('xyz')).toEqual({ Authorization: 'Bearer xyz' });
    expect(buildAuthHeaders('  k  ')).toEqual({ Authorization: 'Bearer k' });
  });
  it('appends ?token=... to download URLs', () => {
    expect(applyDownloadToken('https://civitai.com/api/download/models/1', 'k')).toBe('https://civitai.com/api/download/models/1?token=k');
    expect(applyDownloadToken('https://civitai.com/api/download/models/1?foo=bar', 'k')).toBe('https://civitai.com/api/download/models/1?foo=bar&token=k');
  });
  it('passes through when no key', () => {
    expect(applyDownloadToken('https://x', '')).toBe('https://x');
    expect(applyDownloadToken('https://x', null)).toBe('https://x');
  });
});

describe('detectEarlyAccess', () => {
  it('reports public versions as not-early', () => {
    expect(detectEarlyAccess({ availability: 'Public' })).toEqual({ early: false });
    expect(detectEarlyAccess({})).toEqual({ early: false });
    expect(detectEarlyAccess(null)).toEqual({ early: false });
  });
  it('flags EarlyAccess and surfaces endsAt directly', () => {
    const future = new Date(Date.now() + 13 * 3600_000).toISOString();
    const out = detectEarlyAccess({ availability: 'EarlyAccess', earlyAccessConfig: { endsAt: future } });
    expect(out.early).toBe(true);
    expect(out.endsAt).toBe(future);
    expect(out.hoursRemaining).toBeGreaterThanOrEqual(12);
    expect(out.hoursRemaining).toBeLessThanOrEqual(14);
  });
  it('computes endsAt from publishedAt + period when only the period is given', () => {
    const publishedAt = new Date(Date.now() - 1 * 24 * 3600_000).toISOString();
    const out = detectEarlyAccess({
      availability: 'EarlyAccess',
      publishedAt,
      earlyAccessConfig: { period: 7 },
    });
    expect(out.early).toBe(true);
    // Roughly 6 days * 24h remaining (allow ±2h drift for test execution time)
    expect(out.hoursRemaining).toBeGreaterThanOrEqual(6 * 24 - 2);
    expect(out.hoursRemaining).toBeLessThanOrEqual(6 * 24 + 2);
  });
  it('flags via earlyAccessConfig.period even when availability is missing', () => {
    expect(detectEarlyAccess({ earlyAccessConfig: { period: 3, endsAt: '2099-01-01T00:00:00Z' } })).toMatchObject({
      early: true,
      endsAt: '2099-01-01T00:00:00Z',
    });
  });
  it('handles flagged early-access with no resolvable end date', () => {
    expect(detectEarlyAccess({ availability: 'EarlyAccess' })).toEqual({
      early: true,
      endsAt: null,
      hoursRemaining: null,
    });
  });
});

describe('normalizeCivitaiImageUrl', () => {
  it('rewrites the original=true transform to a width-bounded variant', () => {
    const original = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/1f686daa-ff68-4830-ae94-c318e8f9ee30/original=true/129269017.jpeg';
    const out = normalizeCivitaiImageUrl(original);
    expect(out).toBe('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/1f686daa-ff68-4830-ae94-c318e8f9ee30/width=512/129269017.jpeg');
  });
  it('rewrites existing width= transforms to the requested size', () => {
    expect(normalizeCivitaiImageUrl('https://image.civitai.com/abc/uuid/width=200/file.jpeg', 800))
      .toBe('https://image.civitai.com/abc/uuid/width=800/file.jpeg');
  });
  it('rewrites compound transforms (fit=crop,width=N,height=N)', () => {
    expect(normalizeCivitaiImageUrl('https://image.civitai.com/h/u/fit=crop,width=300,height=300/x.jpeg'))
      .toBe('https://image.civitai.com/h/u/width=512/x.jpeg');
  });
  it('preserves a query string if present', () => {
    expect(normalizeCivitaiImageUrl('https://image.civitai.com/h/u/original=true/x.jpeg?v=2'))
      .toBe('https://image.civitai.com/h/u/width=512/x.jpeg?v=2');
  });
  it('passes through non-Civitai URLs unchanged', () => {
    const url = 'https://huggingface.co/datasets/x/resolve/main/preview.png';
    expect(normalizeCivitaiImageUrl(url)).toBe(url);
  });
  it('passes through URLs with no transform segment', () => {
    const url = 'https://image.civitai.com/foo.jpeg';
    expect(normalizeCivitaiImageUrl(url)).toBe(url);
  });
  it('handles null / non-string inputs without throwing', () => {
    expect(normalizeCivitaiImageUrl(null)).toBe(null);
    expect(normalizeCivitaiImageUrl(undefined)).toBe(undefined);
    expect(normalizeCivitaiImageUrl('')).toBe('');
  });
});

describe('slugifyForFilename', () => {
  it('strips path-unsafe chars', () => {
    expect(slugifyForFilename('Real / Stagram')).toBe('real-stagram');
    expect(slugifyForFilename('Foo!@#Bar')).toBe('foo-bar');
  });
  it('caps length at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugifyForFilename(long).length).toBeLessThanOrEqual(80);
  });
  it('falls back to "lora" for empty / pure-junk names', () => {
    expect(slugifyForFilename('')).toBe('lora');
    expect(slugifyForFilename('!!!')).toBe('lora');
    expect(slugifyForFilename(null)).toBe('lora');
  });
});

describe('fetchCivitaiModel', () => {
  it('hits the canonical metadata endpoint', async () => {
    let calledUrl = null;
    const fetchImpl = async (url, opts) => {
      calledUrl = url;
      expect(opts.headers.Accept).toBe('application/json');
      expect(opts.headers.Authorization).toBe('Bearer k');
      return mockJsonResponse({ id: 1, name: 'X' });
    };
    const out = await fetchCivitaiModel('123', { apiKey: 'k', fetchImpl });
    expect(calledUrl).toBe('https://civitai.com/api/v1/models/123');
    expect(out.name).toBe('X');
  });
  it('throws CIVITAI_NOT_FOUND on 404', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await expect(fetchCivitaiModel('123', { fetchImpl })).rejects.toThrow(/not found/);
  });
  it('throws CIVITAI_AUTH on 401/403', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    await expect(fetchCivitaiModel('123', { fetchImpl })).rejects.toThrow(/Civitai rejected/);
  });
  it('rejects non-numeric modelId without hitting the network', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return mockJsonResponse({}); };
    await expect(fetchCivitaiModel('abc', { fetchImpl })).rejects.toThrow(/Invalid Civitai model id/);
    expect(called).toBe(false);
  });
});

describe('buildSidecar', () => {
  it('compiles all the pieces into a stable shape', () => {
    const model = { id: 42, name: 'RealStagram', description: 'photoreal', type: 'LORA', tags: ['photo'], creator: { username: 'someone' }, nsfw: false };
    const version = { id: 7, baseModel: 'Flux.1 D', trainedWords: ['rstgrm'], settings: { strength: 0.85 }, images: [{ url: 'p.jpg', nsfwLevel: 1 }] };
    const file = { sizeKB: 102400, hashes: { SHA256: 'abc' }, downloadUrl: 'https://civitai.com/api/download/models/7' };
    const sc = buildSidecar({ model, version, file, filename: 'lora-realstagram-v7.safetensors' });
    expect(sc.filename).toBe('lora-realstagram-v7.safetensors');
    expect(sc.civitai.modelId).toBe(42);
    expect(sc.civitai.versionId).toBe(7);
    expect(sc.civitai.url).toBe('https://civitai.com/models/42?modelVersionId=7');
    expect(sc.runnerFamily).toBe('mflux');
    expect(sc.triggerWords).toEqual(['rstgrm']);
    expect(sc.recommendedScale).toBe(0.85);
    expect(sc.previewImageUrl).toBe('p.jpg');
    expect(sc.file.sizeKB).toBe(102400);
    expect(typeof sc.installedAt).toBe('string');
  });
  it('falls back when version has no settings/preview/trainedWords', () => {
    const sc = buildSidecar({
      model: { id: 1, name: 'Lite' },
      version: { id: 2, baseModel: 'SDXL 1.0' },
      file: {},
      filename: 'lora-lite-v2.safetensors',
    });
    expect(sc.runnerFamily).toBe(null);
    expect(sc.recommendedScale).toBe(1.0);
    expect(sc.triggerWords).toEqual([]);
    expect(sc.previewImageUrl).toBe(null);
  });
  it('truncates description to 2000 chars when the model description is long', () => {
    const longDesc = 'x'.repeat(5000);
    const sc = buildSidecar({
      model: { id: 1, name: 'Verbose', description: longDesc },
      version: { id: 2, baseModel: 'Flux.1 D' },
      file: {},
      filename: 'lora-verbose-v2.safetensors',
    });
    expect(sc.description.length).toBe(2000);
    expect(sc.description).toBe(longDesc.slice(0, 2000));
  });
  it('preserves description as-is when it is within the 2000-char limit', () => {
    const sc = buildSidecar({
      model: { id: 1, name: 'Short', description: 'A brief description.' },
      version: { id: 2, baseModel: 'Flux.1 D' },
      file: {},
      filename: 'lora-short-v2.safetensors',
    });
    expect(sc.description).toBe('A brief description.');
  });
  it('defaults description to empty string when absent or non-string', () => {
    const sc = buildSidecar({
      model: { id: 1, name: 'No Desc' },
      version: { id: 2, baseModel: 'Flux.1 D' },
      file: {},
      filename: 'lora-nodesc-v2.safetensors',
    });
    expect(sc.description).toBe('');
  });
  it('rejects NaN as a recommended scale (Number.isFinite guard)', () => {
    // `typeof NaN === 'number'` would silently pass, persisting NaN into
    // the sidecar; downstream multiplies by NaN producing black images.
    const sc = buildSidecar({
      model: { id: 1, name: 'X' },
      version: { id: 2, baseModel: 'Flux.1 D', settings: { strength: NaN } },
      file: {},
      filename: 'x.safetensors',
    });
    expect(sc.recommendedScale).toBe(1.0);
  });
});
