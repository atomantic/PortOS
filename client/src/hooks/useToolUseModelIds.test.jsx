import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getToolUseModels = vi.fn();
vi.mock('../services/apiLocalLlm', () => ({ getToolUseModels: (...a) => getToolUseModels(...a) }));

import useToolUseModelIds, { __resetToolUseModelIdsCache } from './useToolUseModelIds.js';

describe('useToolUseModelIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetToolUseModelIdsCache();
  });

  it('keys the server-reported ids by the provider that serves them', async () => {
    getToolUseModels.mockResolvedValue({
      models: [
        { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
        { providerId: 'ollama', backend: 'ollama', id: 'qwen3.6:35b', name: 'qwen3.6:35b', toolUse: true },
        { providerId: 'lmstudio', backend: 'lmstudio', id: 'mistral-7b', name: 'mistral-7b', toolUse: true },
      ],
    });
    const { result } = renderHook(() => useToolUseModelIds());
    // Not fetched yet — `null`, and `loaded` false so a caller knows the
    // difference between "still scanning" and "scanned, none capable".
    expect(result.current).toEqual({ idsByProvider: null, loaded: false });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.idsByProvider.ollama).toEqual(new Set(['phi4-mini:latest', 'qwen3.6:35b']));
    expect(result.current.idsByProvider.lmstudio).toEqual(new Set(['mistral-7b']));
  });

  it('distinguishes fetched-and-empty from never-fetched', async () => {
    // A backend with zero tool-capable models must come back as a present-but-
    // EMPTY set (a real answer the caller can union against), not an absent key
    // and not `null` — the sentinel rule that keeps "none installed" from
    // reading the same as "we never asked".
    getToolUseModels.mockResolvedValue({ models: [] });
    const { result } = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.idsByProvider).toEqual({ ollama: new Set(), lmstudio: new Set() });
  });

  it('reports a failed fetch as null-but-loaded so callers degrade to the id regex', async () => {
    getToolUseModels.mockRejectedValue(new Error('ollama down'));
    const { result } = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    // `null`, NOT an empty map: a failed scan must never read as "nothing here
    // is tool-capable" — that would assert the warning this hook exists to lift.
    expect(result.current.idsByProvider).toBeNull();
  });

  it('does not fetch while disabled, and fetches once enabled', async () => {
    getToolUseModels.mockResolvedValue({ models: [] });
    const { result, rerender } = renderHook(({ enabled }) => useToolUseModelIds(enabled), {
      initialProps: { enabled: false },
    });
    expect(getToolUseModels).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(getToolUseModels).toHaveBeenCalledTimes(1);
  });

  it('shares ONE request across concurrently mounted callers', async () => {
    // Agent pickers render one per schedule card, and the endpoint asks Ollama
    // for every installed model's capabilities — N selectors must not mean N
    // capability scans.
    getToolUseModels.mockResolvedValue({
      models: [{ providerId: 'ollama', id: 'phi4-mini:latest', toolUse: true }],
    });
    const a = renderHook(() => useToolUseModelIds());
    const b = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    await waitFor(() => expect(b.result.current.loaded).toBe(true));
    expect(getToolUseModels).toHaveBeenCalledTimes(1);
    expect(b.result.current.idsByProvider.ollama).toEqual(new Set(['phi4-mini:latest']));
  });

  it('retries on a later mount after a failure instead of poisoning the session', async () => {
    getToolUseModels.mockRejectedValueOnce(new Error('ollama down'));
    const first = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    expect(first.result.current.idsByProvider).toBeNull();

    getToolUseModels.mockResolvedValue({
      models: [{ providerId: 'ollama', id: 'phi4-mini:latest', toolUse: true }],
    });
    const second = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(second.result.current.idsByProvider).not.toBeNull());
    expect(second.result.current.idsByProvider.ollama).toEqual(new Set(['phi4-mini:latest']));
    expect(getToolUseModels).toHaveBeenCalledTimes(2);
  });

  it('ignores rows the server did not attribute to a provider', async () => {
    // A bare id is not a capability — an unattributed row can't be allowed to
    // vouch for whichever provider happens to list that id.
    getToolUseModels.mockResolvedValue({
      models: [
        { id: 'orphan-model', toolUse: true },
        { providerId: 'ollama', id: 'phi4-mini:latest', toolUse: true },
      ],
    });
    const { result } = renderHook(() => useToolUseModelIds());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.idsByProvider).toEqual({
      ollama: new Set(['phi4-mini:latest']),
      lmstudio: new Set(),
    });
  });
});
