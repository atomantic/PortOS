import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({ getProviders: vi.fn() }));

import * as api from '../services/api';
import useProviderModels from './useProviderModels';

// The catalog `agy models` prints — the shipped provider list mirrors it, and
// its defaultModel is the "use the CLI's own model" sentinel.
const AGY = {
  id: 'antigravity-cli',
  name: 'Antigravity CLI',
  type: 'cli',
  command: 'agy',
  enabled: true,
  defaultModel: 'antigravity-configured-default',
  models: [
    'antigravity-configured-default',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-sonnet-4-6', 'gpt-oss-120b-medium',
  ],
};

const CODEX = {
  id: 'codex',
  name: 'Codex',
  type: 'cli',
  command: 'codex',
  enabled: true,
  defaultModel: 'gpt-5',
  models: ['gpt-5', 'gpt-5-high'],
};

// `withEffort` is what opts a picker into base models — it declares that the
// caller also renders an effort control, so the tiers aren't lost.
const mountWith = async (providers, options = { withEffort: true }) => {
  api.getProviders.mockResolvedValue({ providers });
  const hook = renderHook(() => useProviderModels(options));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
};

describe('useProviderModels — Antigravity base models', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collapses the effort-suffixed catalog into base models', async () => {
    const { result } = await mountWith([AGY]);
    expect(result.current.availableModels).toEqual([
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'gpt-oss-120b',
    ]);
  });

  it('does not re-surface the configured-default sentinel as the auto-selected pin', async () => {
    const { result } = await mountWith([AGY]);
    // The sentinel is the provider's defaultModel, so it IS the selected value —
    // but filterSelectableModels exists to keep it out of the options.
    expect(result.current.selectedModel).toBe('antigravity-configured-default');
    expect(result.current.availableModels).not.toContain('antigravity-configured-default');
  });

  it('keeps a legacy effort-suffixed pin visible instead of blanking the select', async () => {
    const { result } = await mountWith([AGY]);
    act(() => result.current.setSelectedModel('gemini-3.6-flash-high'));
    await waitFor(() => {
      expect(result.current.availableModels).toContain('gemini-3.6-flash-high');
    });
    // The base list is still there — the stale pin is appended, not substituted.
    expect(result.current.availableModels).toContain('gemini-3.6-flash');
  });

  it('leaves other providers\' model lists untouched', async () => {
    const { result } = await mountWith([CODEX]);
    // `gpt-5-high` is NOT an Antigravity id, so its `-high` is not a tier suffix.
    expect(result.current.availableModels).toEqual(['gpt-5', 'gpt-5-high']);
  });

  it('keeps the per-tier ids for a picker with no effort control (the default)', async () => {
    // Without an effort select, the suffixed ids are the ONLY way to pick a
    // tier — collapsing them there would strip the capability, not relocate it.
    const { result } = await mountWith([AGY], {});
    expect(result.current.availableModels).toEqual([
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
      'claude-sonnet-4-6', 'gpt-oss-120b-medium',
    ]);
  });
});

// A capability-scoped picker (vision) starts on the client-side id regex and
// widens once the server's authoritative list resolves, so its `modelFilter`
// identity changes AFTER the first load. Stand-in filters here: the contract
// under test is the identity change, not any particular capability rule.
describe('useProviderModels — a modelFilter whose identity changes', () => {
  const LOCAL = {
    id: 'local-backend',
    name: 'Local Backend',
    type: 'api',
    enabled: true,
    defaultModel: 'text-a',
    models: ['text-a', 'vlm-b', 'vlm-c'],
  };
  const OTHER = { ...LOCAL, id: 'other-backend', name: 'Other Backend', defaultModel: 'text-a' };

  // The blind first pass: knows no vision family this backend has installed.
  const matchesNothing = () => false;
  const matchesB = (id) => id === 'vlm-b';
  const matchesBandC = (id) => id === 'vlm-b' || id === 'vlm-c';

  const mountFiltered = async (modelFilter, providers = [LOCAL], extra = {}) => {
    api.getProviders.mockResolvedValue({ providers });
    const hook = renderHook(
      ({ filterFn }) => useProviderModels({ modelFilter: filterFn, ...extra }),
      { initialProps: { filterFn: modelFilter } },
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  };

  beforeEach(() => vi.clearAllMocks());

  it('re-picks the initial model once the filter widens', async () => {
    const { result, rerender } = await mountFiltered(matchesNothing);
    // The blind first pass finds nothing — the bug this guards is that the
    // hook used to freeze here forever.
    expect(result.current.selectedModel).toBe('');
    expect(result.current.availableModels).toEqual([]);

    rerender({ filterFn: matchesB });
    await waitFor(() => expect(result.current.selectedModel).toBe('vlm-b'));
    expect(result.current.availableModels).toEqual(['vlm-b']);
  });

  it('does not refetch the provider list for a filter identity change', async () => {
    const { rerender, result } = await mountFiltered(matchesNothing);
    expect(api.getProviders).toHaveBeenCalledTimes(1);

    rerender({ filterFn: matchesB });
    await waitFor(() => expect(result.current.selectedModel).toBe('vlm-b'));
    expect(api.getProviders).toHaveBeenCalledTimes(1);
  });

  it('leaves a deliberate user clear alone when the filter widens', async () => {
    const { result, rerender } = await mountFiltered(matchesB);
    expect(result.current.selectedModel).toBe('vlm-b');

    act(() => result.current.setSelectedModel(''));
    rerender({ filterFn: matchesBandC });
    // A clear and a "the filter matched nothing" both read as `''` — only the
    // user-pick latch tells them apart, and the user's wins.
    await waitFor(() => expect(result.current.availableModels).toEqual(['vlm-b', 'vlm-c']));
    expect(result.current.selectedModel).toBe('');
  });

  it('leaves a user-picked model alone when the filter changes', async () => {
    const { result, rerender } = await mountFiltered(matchesBandC);
    act(() => result.current.setSelectedModel('vlm-c'));

    rerender({ filterFn: matchesB });
    await waitFor(() => expect(result.current.availableModels).toEqual(['vlm-b']));
    expect(result.current.selectedModel).toBe('vlm-c');
  });

  it('re-arms the auto-pick after a provider change', async () => {
    const { result, rerender } = await mountFiltered(matchesNothing, [LOCAL, OTHER]);
    // A provider change picks through the CURRENT (still blind) filter…
    act(() => result.current.setSelectedProviderId('other-backend'));
    expect(result.current.selectedModel).toBe('');

    // …so the widened filter must still get its say on that provider.
    rerender({ filterFn: matchesB });
    await waitFor(() => expect(result.current.selectedModel).toBe('vlm-b'));
    expect(result.current.selectedProviderId).toBe('other-backend');
  });

  it('keeps the empty-model sentinel under allowDefault', async () => {
    const { result, rerender } = await mountFiltered(matchesNothing, [LOCAL], { allowDefault: true });
    expect(result.current.selectedProviderId).toBe('');
    expect(result.current.selectedModel).toBe('');

    rerender({ filterFn: matchesB });
    await waitFor(() => expect(result.current.availableModels).toEqual([]));
    // `''` is the "use the default model" choice here, never an auto-pick target.
    expect(result.current.selectedModel).toBe('');
  });
});
