import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useReviewerModelOptions from './useReviewerModelOptions';
import { getLocalLlmStatus, getProviders } from '../services/api';
import { MODEL_SELECTABLE_REVIEWERS } from '../lib/reviewerPins';

vi.mock('../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getProviders: vi.fn(),
}));

const providers = [
  { id: 'codex', models: ['gpt-5.6-sol', 'gpt-5.6-luna'] },
  { id: 'claude-code', models: ['claude-opus-5'] },
  // agy enumerates each effort tier as its own id; the reviewer row has a
  // separate Effort cell, so the picker must collapse them to base ids.
  {
    id: 'antigravity-cli',
    defaultModel: 'antigravity-configured-default',
    models: [
      'antigravity-configured-default',
      'gemini-3.6-flash-low',
      'gemini-3.6-flash-high',
      'gemini-3.1-pro-high',
    ],
  },
  // One `grok` binary ships as both a TUI and a CLI provider; the reviewer is
  // spawned non-interactively, so the CLI's catalog is the one it should offer.
  { id: 'grok-tui', type: 'tui', command: 'grok', models: ['stale-tui-id'] },
  { id: 'grok-cli', type: 'cli', command: 'grok', models: ['grok-configured-default', 'grok-code-fast-1'] },
];

describe('useReviewerModelOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocalLlmStatus.mockResolvedValue({ ollama: { available: true, models: [{ id: 'qwen2.5:7b' }] } });
    getProviders.mockResolvedValue({ providers });
  });

  it('offers options for every model-selectable reviewer', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    for (const reviewer of MODEL_SELECTABLE_REVIEWERS) {
      expect(Array.isArray(result.current.optionsByReviewer[reviewer])).toBe(true);
    }
  });

  // #3728: `agy --model <id>` is real, so the antigravity row gets a Model cell.
  // Its ids arrive effort-suffixed and would otherwise duplicate the Effort cell
  // (and hand agy a `--model X-high --effort high` pair it rejects).
  it('collapses the antigravity catalog to base ids and drops the sentinel', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.antigravity).toEqual(['gemini-3.6-flash', 'gemini-3.1-pro']);
    // Free-text: the stored catalog lags new tiers, and a typed suffixed id is
    // still valid (the server splits it back apart).
    expect(result.current.freeText.antigravity).toBe(true);
  });

  // #3729: `grok --model <id>` is real, so the grok row gets a Model cell too.
  it('sources grok options from the CLI provider, not the TUI, and drops the sentinel', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.grok).toEqual(['grok-code-fast-1']);
    // Free-text: the shipped grok catalog is sentinel-only, so a typed id is
    // often the only way to pin one.
    expect(result.current.freeText.grok).toBe(true);
  });

  it('falls back to a TUI-only grok install for its catalog', async () => {
    getProviders.mockResolvedValue({ providers: [providers.find((p) => p.id === 'grok-tui')] });
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.grok).toEqual(['stale-tui-id']);
  });

  // #3733: `agy` validates the model/effort PAIR, so the Effort cell's ladder has
  // to come from the pinned model's own tiers, not the static low|medium|high.
  describe('modelEffortLevels', () => {
    const levelsFor = async (reviewer, model) => {
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      return result.current.modelEffortLevels(reviewer, model);
    };

    it('narrows the antigravity ladder to the pinned model\'s catalog tiers', async () => {
      expect(await levelsFor('antigravity', 'gemini-3.1-pro')).toEqual(['high']);
      expect(await levelsFor('antigravity', 'gemini-3.6-flash')).toEqual(['low', 'high']);
    });

    it('narrows through a legacy effort-suffixed pin', async () => {
      expect(await levelsFor('antigravity', 'gemini-3.1-pro-high')).toEqual(['high']);
    });

    it('resolves the gemini alias to the antigravity narrowing', async () => {
      expect(await levelsFor('gemini', 'gemini-3.1-pro')).toEqual(['high']);
    });

    it('reports no tiers for a model the catalog lists without any', async () => {
      expect(await levelsFor('antigravity', 'claude-sonnet-4-6')).toEqual([]);
    });

    it('falls back to the full ladder for an unset model or the configured default', async () => {
      expect(await levelsFor('antigravity', '')).toEqual(['low', 'medium', 'high']);
      expect(await levelsFor('antigravity', 'antigravity-configured-default')).toEqual(['low', 'medium', 'high']);
    });

    it('falls back to the full ladder when the catalog never loaded', async () => {
      getProviders.mockRejectedValue(new Error('offline'));
      expect(await levelsFor('antigravity', 'gemini-3.1-pro')).toEqual(['low', 'medium', 'high']);
    });

    it('leaves every other reviewer on its static ladder', async () => {
      expect(await levelsFor('codex', 'gpt-5.6-sol')).toContain('ultra');
      expect(await levelsFor('claude', 'gemini-3.1-pro')).toContain('max');
      expect(await levelsFor('copilot', null)).toBeNull();
      expect(await levelsFor('@octocat', null)).toBeNull();
    });
  });

  it('degrades to empty option lists when the provider fetch fails', async () => {
    getProviders.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.antigravity).toEqual([]);
    expect(result.current.optionsByReviewer.codex).toEqual([]);
  });
});
