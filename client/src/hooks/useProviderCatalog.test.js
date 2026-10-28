import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useProviderCatalog, { __resetProviderCatalogCache, invalidateProviderCatalog } from './useProviderCatalog.js';

const api = vi.hoisted(() => ({ getProviderCatalog: vi.fn(), createProviderPreset: vi.fn() }));
vi.mock('../services/api.js', () => api);
const socket = vi.hoisted(() => {
  const listeners = new Map();
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
    },
    emit(event) { for (const listener of listeners.get(event) || []) listener(); },
    listenerCount(event) { return (listeners.get(event) || []).length; },
  };
});
vi.mock('../services/socket.js', () => ({ default: socket }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

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
const UPDATED_CATALOG = { ...CATALOG, harnesses: CATALOG.harnesses.map((h) => ({ ...h, enabled: true })) };

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

  it('compatiblePairs excludes a compatible service that has been switched off', async () => {
    api.getProviderCatalog.mockResolvedValue({
      ...CATALOG,
      services: [{ ...CATALOG.services[0], enabled: false }],
    });
    const { result } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.compatiblePairs('pi')).toEqual([]);
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

    it('returns null for a composite naming a harness this catalog does not know', async () => {
      const { result } = renderHook(() => useProviderCatalog());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.resolveRef('unknown-harness.tui@nvidia-nim-free')).toBeNull();
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

  it('exposes failure and retries explicitly without looping automatically', async () => {
    api.getProviderCatalog.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    expect(result.current.loading).toBe(false);
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.harnesses).toEqual(CATALOG.harnesses));
    expect(result.current.error).toBeNull();
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);
  });

  it('retries a failed opening when the same mounted consumer reopens', async () => {
    api.getProviderCatalog.mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ enabled }) => useProviderCatalog(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    rerender({ enabled: false });
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.harnesses).toEqual(CATALOG.harnesses));
    expect(result.current.error).toBeNull();
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

describe('invalidateProviderCatalog', () => {
  // The AI Providers page toggles a harness or writes a service and every open
  // picker's compose flow must reflect it without a reload (#7567): one
  // invalidation re-reads the catalog in every mounted hook, keeping the
  // stale rows rendered until the new ones land.
  it.each(['local mutation', 'providers:changed', 'connect'])('shares a replacement read after %s, keeping useful old rows while loading', async (event) => {
    const { result: a } = renderHook(() => useProviderCatalog());
    const { result: b } = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(a.current.loading).toBe(false));
    await waitFor(() => expect(b.current.loading).toBe(false));

    const replacement = deferred();
    api.getProviderCatalog.mockReturnValueOnce(replacement.promise);
    act(() => { event === 'local mutation' ? invalidateProviderCatalog() : socket.emit(event); });
    // In flight: the old rows are still what renders, not an empty catalog.
    expect(a.current.harnesses.find((h) => h.id === 'claude').enabled).toBe(false);
    expect(a.current.loading).toBe(true);
    expect(b.current.loading).toBe(true);
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);
    await act(async () => { replacement.resolve(UPDATED_CATALOG); });
    await waitFor(() => expect(a.current.harnesses.find((h) => h.id === 'claude').enabled).toBe(true));
    await waitFor(() => expect(b.current.harnesses.find((h) => h.id === 'claude').enabled).toBe(true));
    // One shared fetch served both hooks, as on the first read.
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);
  });

  it.each(['providers:changed', 'connect'])('invalidates between mounts on %s without fetching for a disabled consumer', async (event) => {
    const first = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    api.getProviderCatalog.mockResolvedValue(UPDATED_CATALOG);
    act(() => { socket.emit(event); });
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);

    const next = renderHook(({ enabled }) => useProviderCatalog(enabled), { initialProps: { enabled: false } });
    act(() => { socket.emit(event); });
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(1);
    expect(next.result.current.loading).toBe(false);
    next.rerender({ enabled: true });
    await waitFor(() => expect(next.result.current.harnesses).toEqual(UPDATED_CATALOG.harnesses));
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);
    next.unmount();
    // Listener lifetime belongs to the cache, not to any individual mount.
    expect(socket.listenerCount('providers:changed')).toBe(1);
    expect(socket.listenerCount('connect')).toBe(1);
  });

  it.each(['before replacement', 'after replacement', 'failure after replacement'])('ignores an obsolete initial request settling %s', async (order) => {
    const obsolete = deferred();
    const replacement = deferred();
    api.getProviderCatalog.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(replacement.promise);
    const first = renderHook(() => useProviderCatalog());
    const second = renderHook(() => useProviderCatalog());
    act(() => { socket.emit('providers:changed'); });
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);

    if (order === 'before replacement') {
      await act(async () => { obsolete.resolve(CATALOG); });
      expect(first.result.current.loading).toBe(true);
      expect(first.result.current.harnesses).toEqual([]);
      expect(second.result.current.loading).toBe(true);
    }
    await act(async () => { replacement.resolve(UPDATED_CATALOG); });
    if (order !== 'before replacement') {
      await act(async () => {
        if (order === 'failure after replacement') obsolete.reject(new Error('old request failed'));
        else obsolete.resolve(CATALOG);
      });
    }
    expect(first.result.current.harnesses).toEqual(UPDATED_CATALOG.harnesses);
    expect(second.result.current.harnesses).toEqual(UPDATED_CATALOG.harnesses);
    expect(first.result.current.loading).toBe(false);
    first.unmount();
    second.unmount();
    const later = renderHook(() => useProviderCatalog());
    await waitFor(() => expect(later.result.current.loading).toBe(false));
    expect(later.result.current.harnesses).toEqual(UPDATED_CATALOG.harnesses);
    expect(api.getProviderCatalog).toHaveBeenCalledTimes(2);
  });
});
