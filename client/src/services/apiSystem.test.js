import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let patchSettingsSlice;
let getCharacter;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ patchSettingsSlice, getCharacter } = await import('./apiSystem.js'));
  request.mockReset();
});

const mockSettings = (settings) => {
  request.mockImplementation((path, opts) => {
    if (path === '/settings' && (!opts || opts.method !== 'PUT')) {
      return Promise.resolve(settings);
    }
    return Promise.resolve({ ok: true });
  });
};

describe('patchSettingsSlice', () => {
  it('preserves sibling subkeys when patching a deep slice', async () => {
    mockSettings({
      imageGen: {
        mode: 'codex',
        external: { sdapiUrl: 'http://x' },
        local: { pythonPath: '/old', denoise: true },
        codex: { enabled: true },
      },
    });
    await patchSettingsSlice('imageGen.local', { pythonPath: '/new' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({
      imageGen: {
        mode: 'codex',
        external: { sdapiUrl: 'http://x' },
        local: { pythonPath: '/new', denoise: true },
        codex: { enabled: true },
      },
    });
  });

  it('preserves sibling top-level subkeys when patching a one-level slice', async () => {
    mockSettings({
      pipeline: {
        imageGen: { provider: 'old' },
        videoGen: { mode: 'i2v' },
      },
      unrelated: { keep: true },
    });
    await patchSettingsSlice('pipeline', { imageGen: { provider: 'new' } });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({
      pipeline: {
        imageGen: { provider: 'new' },
        videoGen: { mode: 'i2v' },
      },
    });
    // Top-level `unrelated` is never in the PUT body — the server merges by
    // top-level key, so omitting it leaves it untouched on disk.
    expect(body.unrelated).toBeUndefined();
  });

  it('creates the slice path when it does not exist yet', async () => {
    mockSettings({});
    await patchSettingsSlice('writersRoom.imageGen', { foo: 'bar' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ writersRoom: { imageGen: { foo: 'bar' } } });
  });

  it('falls back to an empty slice when getSettings rejects', async () => {
    request.mockImplementation((path, opts) => {
      if (path === '/settings' && (!opts || opts.method !== 'PUT')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ ok: true });
    });
    await patchSettingsSlice('imageGen.local', { pythonPath: '/x' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ imageGen: { local: { pythonPath: '/x' } } });
  });

  it('passes options through to updateSettings', async () => {
    mockSettings({});
    await patchSettingsSlice('backup', { destPath: '/tmp' }, { silent: true });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    expect(putCall[1].silent).toBe(true);
  });

  it('throws on missing slicePath', async () => {
    await expect(patchSettingsSlice('', {})).rejects.toThrow(/slicePath required/);
  });

  it('throws on non-object partial', async () => {
    await expect(patchSettingsSlice('imageGen', null)).rejects.toThrow(/plain object/);
    await expect(patchSettingsSlice('imageGen', [])).rejects.toThrow(/plain object/);
    await expect(patchSettingsSlice('imageGen', 'foo')).rejects.toThrow(/plain object/);
  });

  it('throws on empty path segments', async () => {
    await expect(patchSettingsSlice('imageGen..local', { x: 1 })).rejects.toThrow(/empty segments/);
    await expect(patchSettingsSlice('imageGen.', { x: 1 })).rejects.toThrow(/empty segments/);
    await expect(patchSettingsSlice('.imageGen', { x: 1 })).rejects.toThrow(/empty segments/);
  });

  it('treats a non-object slice value as absent (does not spread strings into chars)', async () => {
    mockSettings({ imageGen: { local: 'oops-not-an-object' } });
    await patchSettingsSlice('imageGen.local', { pythonPath: '/x' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ imageGen: { local: { pythonPath: '/x' } } });
  });

  it('treats a non-object parent as absent', async () => {
    mockSettings({ imageGen: 'oops' });
    await patchSettingsSlice('imageGen.local', { pythonPath: '/x' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ imageGen: { local: { pythonPath: '/x' } } });
  });

  it('treats an array at the slice as absent', async () => {
    mockSettings({ imageGen: { local: [1, 2, 3] } });
    await patchSettingsSlice('imageGen.local', { pythonPath: '/x' });
    const putCall = request.mock.calls.find(([, opts]) => opts?.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    expect(body).toEqual({ imageGen: { local: { pythonPath: '/x' } } });
  });
});

// The character query builder encodes a non-obvious server rule: an ABSENT `metrics` is
// inferred from `skills` (back-compat — a bare `?skills=0` predates the metrics grid and has
// only ever meant "cheap sheet"). So this wrapper must put `metrics` on the wire explicitly
// whenever inference would contradict its own documented defaults.
describe('getCharacter query building (#2676)', () => {
  const pathOf = () => request.mock.calls[0][0];

  it('sends no query at all when the caller wants the whole sheet', () => {
    getCharacter();
    expect(pathOf()).toBe('/character');
  });

  it('sends both flags off for the cheap path', () => {
    getCharacter({ skills: false, metrics: false });
    expect(pathOf()).toBe('/character?skills=0&metrics=0');
  });

  it('sends metrics=1 explicitly when skills are off but metrics are wanted', () => {
    // Without the explicit `1` the server would infer metrics=false from `skills=0` and
    // silently drop the metrics this wrapper's `metrics = true` default promises.
    getCharacter({ skills: false });
    expect(pathOf()).toBe('/character?skills=0&metrics=1');
  });

  it('sends only metrics=0 when metrics alone are declined', () => {
    getCharacter({ metrics: false });
    expect(pathOf()).toBe('/character?metrics=0');
  });

  it('forwards request options without leaking the flags into them', () => {
    getCharacter({ skills: false, metrics: false, silent: true });
    expect(request.mock.calls[0][1]).toEqual({ silent: true });
  });
});
