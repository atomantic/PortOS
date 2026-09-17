import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useProviderCatalog, { __resetProviderCatalogCache } from './useProviderCatalog.js';

const api = vi.hoisted(() => ({ getProviderCatalog: vi.fn(), createProviderPreset: vi.fn() }));
vi.mock('../services/api.js', () => api);

const CATALOG = {
  harnesses: [
    { id: 'pi', label: 'Pi', modes: ['tui'], enabled: true, detected: true },
    { id: 'claude', label: 'Claude Code', modes: ['cli', 'tui'], enabled: false, detected: false },
  ],
  services: [
    { slug: 'nvidia-nim-free', label: 'NVIDIA NIM', plan: 'free', enabled: true, credentialVia: 'stored', readiness: 'ready', catalog: { models: ['nvidia/example'] } },
  ],
  bootstraps: [{ slug: 'chatgpt', label: 'ChatGPT wrapper' }],
  compatibility: { pi: ['nvidia-nim-free'], claude: [] },
  effortLevels: { pi: ['low', 'medium', 'high', 'xhigh', 'max'], claude: ['low', 'medium', 'high'] },
  effortLevelsByModel: { pi: {}, claude: {} },
  presets: [{ id: 'claude-code', name: 'Claude', enabled: true }],
};

beforeEach(() => {
  __resetProviderCatalogCache();
  api.getProviderCatalog.mockReset().mockResolvedValue(CATALOG);
  api.createProviderPreset.mockReset();
});

describe('useProviderCatalog', () => {
  it('starts loading and settles into the fetched catalog', async () => {
    const { result } = renderHook(() => useProviderCatalog());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.harnesses).toHaveLength(2);
    expect(result.current.presets).toEqual(CATALOG.presets);
  });

  it('does not fetch while disabled, and fetches once enabled goes true', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useProviderCatalog(enabled), { initialProps: { enabled: false } });
    expect(api.getProviderCatalog).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch across two mounted callers', async () => {
    const { result: a } = renderHook(() => useProviderCatalog());
    const { result: b } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(a.current.loading).toBe(false));
    await waitFor(() => expect(b.current.loading).toBe(false));
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
  });

  it('compatiblePairs narrows services to the harness compatibility map', async () => {
    const { result } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.compatiblePairs('pi').map((s) => s.slug)).toEqual(['nvidia-nim-free']);
    expect(result.current.compatiblePairs('claude')).toEqual([]);
  });

  it('effortLevelsFor prefers a per-model ladder over the harness default', async () => {
    api.getProviderCatalog.mockResolvedValue({
      ...CATALOG,
      effortLevelsByModel: { pi: { 'nvidia/example': ['low', 'medium'] }, claude: {} },
    });
    const { result } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.effortLevelsFor('pi', 'nvidia/example')).toEqual(['low', 'medium']);
    expect(result.current.effortLevelsFor('pi', 'some-other-model')).toEqual(CATALOG.effortLevels.pi);
  });

  describe('resolveRef', () => {
    it('resolves a preset id to its stored record', async () => {
      const { result } = renderHook(() => useProviderCatalog());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.resolveRef('claude-code')).toEqual(CATALOG.presets[0]);
    });

    it('synthesizes a display record for a composite id, naming the free plan', async () => {
      const { result } = renderHook(() => useProviderCatalog());
      await waitFor(() => expect(result.current.loading).toBe(false));
      const ref = result.current.resolveRef('pi.tui@nvidia-nim-free');
      expect(ref).toMatchObject({
        id: 'pi.tui@nvidia-nim-free',
        name: 'Pi · TUI · NVIDIA NIM (free)',
        harnessId: 'pi',
        method: 'tui',
        serviceSlug: 'nvidia-nim-free',
        bootstrapId: null,
        composite: true,
        enabled: true,
      });
      expect(ref.models).toEqual(['nvidia/example']);
    });

    it('returns null for a composite naming a service this catalog does not know', async () => {
      const { result } = renderHook(() => useProviderCatalog());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.resolveRef('pi.tui@unknown-service')).toBeNull();
    });

    it('returns null for neither grammar and for a nullish id', async () => {
      const { result } = renderHook(() => useProviderCatalog());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.resolveRef('')).toBeNull();
      expect(result.current.resolveRef('not a valid ref!!')).toBeNull();
    });
  });

  it('savePreset delegates to createProviderPreset', async () => {
    api.createProviderPreset.mockResolvedValue({ id: 'pi-tui-nvidia-nim-free' });
    const { result } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let created;
    await act(async () => {
      created = await result.current.savePreset({ compositeId: 'pi.tui@nvidia-nim-free', name: 'Pi NIM' });
    });
    expect(api.createProviderPreset).toHaveBeenCalledWith({ compositeId: 'pi.tui@nvidia-nim-free', name: 'Pi NIM' });
    expect(created).toEqual({ id: 'pi-tui-nvidia-nim-free' });
  });

  it('retries after a failed fetch on the next mount', async () => {
    api.getProviderCatalog.mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.harnesses).toEqual([]);

    api.getProviderCatalog.mockResolvedValueOnce(CATALOG);
    const second = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.harnesses).toHaveLength(2);
  });
});
