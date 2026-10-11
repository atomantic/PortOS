// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request } from './apiCore.js';
import { patchSettingsSlice } from './apiSystem.js';

vi.mock('./apiCore.js', () => ({ request: vi.fn() }));
beforeEach(() => { request.mockReset(); });

describe('patchSettingsSlice', () => {
  it('sends only the partial mutation without reading or replacing settings', async () => {
    request.mockResolvedValue({ localLlm: { mtplx: { keepLoaded: true } } });
    const saved = await patchSettingsSlice('localLlm.mtplx', { keepLoaded: true }, { silent: true });
    expect(request).toHaveBeenCalledExactlyOnceWith('/settings/slice', {
      method: 'PATCH',
      body: JSON.stringify({ slicePath: 'localLlm.mtplx', partial: { keepLoaded: true } }),
      silent: true,
    });
    expect(saved.localLlm.mtplx.keepLoaded).toBe(true);
  });

  it('propagates failed server reads/writes without attempting a fallback PUT', async () => {
    request.mockRejectedValue(new Error('Settings unavailable'));
    await expect(patchSettingsSlice('imageGen.local', { pythonPath: null })).rejects.toThrow('Settings unavailable');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].method).toBe('PATCH');
  });

  it('preserves explicit empty and null clearing in the request', async () => {
    request.mockResolvedValue({});
    await patchSettingsSlice('imageGen.local', { pythonPath: null });
    expect(JSON.parse(request.mock.calls[0][1].body).partial).toEqual({ pythonPath: null });
    await patchSettingsSlice('localLlm.mtplx', { launch: {} });
    expect(JSON.parse(request.mock.calls[1][1].body).partial).toEqual({ launch: {} });
  });

  it('rejects malformed arguments before sending a mutation', async () => {
    await expect(patchSettingsSlice('', {})).rejects.toThrow(/slicePath required/);
    await expect(patchSettingsSlice('imageGen..local', {})).rejects.toThrow(/empty segments/);
    for (const partial of [null, [], 'invalid']) {
      await expect(patchSettingsSlice('imageGen.local', partial)).rejects.toThrow(/plain object/);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
