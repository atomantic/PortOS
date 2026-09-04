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
  { id: 'codex', models: ['gpt-5.6-sol', 'gpt-5.6-luna'], defaultModel: 'gpt-5.6-sol' },
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
  // One `grok` binary ships as both a TUI and a CLI provider. Both list ids that
  // binary accepts, so the picker unions them; the CLI's record still owns the
  // shown DEFAULT, since the reviewer is spawned non-interactively.
  { id: 'grok-tui', type: 'tui', command: 'grok', models: ['tui-only-id'] },
  { id: 'grok-cli', type: 'cli', command: 'grok', models: ['grok-configured-default', 'grok-code-fast-1'] },
  { id: 'cursor-cli', type: 'cli', command: 'cursor-agent', models: ['auto', 'gpt-5'] },
  { id: 'mtplx', type: 'api', models: ['mtplx-qwen38-27b-optimized-speed'], defaultModel: 'mtplx-qwen38-27b-optimized-speed' },
  // The seeded OpenCode Zen wrappers, whose namespaced ids the Harnesses page
  // refreshes from `opencode models` — the reviewer's dropdown source.
  { id: 'opencode-zen-cli', type: 'cli', command: 'opencode', models: ['opencode/big-pickle'], defaultModel: 'opencode/big-pickle' },
  { id: 'opencode-zen-tui', type: 'tui', command: 'opencode', models: ['opencode/big-pickle', 'opencode/mimo-v2.5-free'] },
  // An OpenCode wrapper pointed at a local runtime: its ids resolve only under
  // the config PortOS injects, so the reviewer (a BARE `opencode`) must not
  // offer them.
  { id: 'opencode-ollama', type: 'cli', command: 'opencode', ollamaBacked: true, models: ['qwen3-coder:30b'] },
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

  // A closed `<select>` is only honest for a backend whose installed list we
  // actually probed. `mtplx` is a local backend we deliberately do NOT probe (its
  // listing runs the `mtplx` wrapper, a cold-version venv bootstrap), so it must
  // stay free-text — otherwise the user could not pin a checkpoint they pulled.
  it('keeps every unprobed reviewer free-text, local backends included', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.freeText.lmstudio).toBe(false);
    expect(result.current.freeText.ollama).toBe(false);
    for (const reviewer of ['mtplx', 'opencode', 'kimi']) {
      expect(result.current.freeText[reviewer], reviewer).toBe(true);
    }
    expect(result.current.optionsByReviewer.mtplx).toEqual(['mtplx-qwen38-27b-optimized-speed']);
  });

  it('publishes concrete provider defaults without exposing configured-default sentinels', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.defaultModels.codex).toBe('gpt-5.6-sol');
    expect(result.current.defaultModels.antigravity).toBeNull();
  });

  // The reported defect: `claude-code` (CLI) still listed the retired
  // `claude-sonnet-4-6` while `claude-code-tui` had moved to `claude-sonnet-5`,
  // and sourcing the picker from the CLI record alone showed the retired tier
  // and hid the current one. `claude` has no `models` subcommand, so nothing can
  // refresh that record in place.
  it('unions the Claude CLI and TUI catalogs so one stale record can\'t hide a live tier', async () => {
    getProviders.mockResolvedValue({ providers: [
      { id: 'claude-code', type: 'cli', command: 'claude', models: ['claude-haiku-4-5', 'claude-sonnet-4-6'], defaultModel: 'claude-haiku-4-5' },
      { id: 'claude-code-tui', type: 'tui', command: 'claude', models: ['claude-sonnet-5', 'claude-opus-5'] },
      // Bedrock ids resolve only under that record's own environment.
      { id: 'claude-code-bedrock', type: 'cli', command: 'claude', models: ['us.anthropic.claude-sonnet-5'] },
    ] });
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.claude).toEqual([
      'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5', 'qwen2.5:7b',
    ]);
    // The CLI record still owns the shown default — the reviewer is spawned
    // non-interactively.
    expect(result.current.defaultModels.claude).toBe('claude-haiku-4-5');
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
  // Both records front the same binary, so the option list unions them (CLI
  // first) rather than letting one record's staleness hide the other's ids —
  // sourcing from a single record is exactly what hid `claude-sonnet-5` behind
  // the CLI record's retired `claude-sonnet-4-6`.
  it('unions the grok CLI and TUI catalogs, CLI first, and drops the sentinel', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.grok).toEqual(['grok-code-fast-1', 'tui-only-id']);
    // Free-text: the shipped grok catalog is sentinel-only, so a typed id is
    // often the only way to pin one.
    expect(result.current.freeText.grok).toBe(true);
  });

  it('sources Cursor Agent options from its cursor-agent provider', async () => {
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.cursor).toEqual(['auto', 'gpt-5']);
    expect(result.current.freeText.cursor).toBe(true);
  });

  it('falls back to a TUI-only grok install for its catalog', async () => {
    getProviders.mockResolvedValue({ providers: [providers.find((p) => p.id === 'grok-tui')] });
    const { result } = renderHook(() => useReviewerModelOptions());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.optionsByReviewer.grok).toEqual(['tui-only-id']);
  });

  // The Model cell used to be a bare text input for opencode: the reviewer runs a
  // BARE `opencode`, and the only catalogs on hand were the `opencode-<backend>`
  // presets, whose ids resolve solely under the config a PortOS-spawned provider
  // injects. The seeded Zen wrappers are the exception — their namespaced ids are
  // what `opencode models` prints, and the Harnesses page refreshes them from
  // exactly that probe — so those, and only those, feed the dropdown.
  describe('opencode', () => {
    it('offers the Zen wrappers\' namespaced ids, unioned across CLI and TUI', async () => {
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.optionsByReviewer.opencode)
        .toEqual(['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
      // Still free-text underneath: a user's own config can declare namespaces
      // the Zen catalog never lists.
      expect(result.current.freeText.opencode).toBe(true);
    });

    it('never offers a local-runtime wrapper\'s ids', async () => {
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.optionsByReviewer.opencode).not.toContain('qwen3-coder:30b');
    });

    // The reviewer spawns a bare `opencode`, which falls back to whatever the
    // user's OWN config names — not to the PortOS record's default. Showing the
    // record's default would claim a model the run won't use.
    it('shows no default even though the Zen record carries one', async () => {
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.defaultModels.opencode).toBeNull();
    });
  });

  // The Add row hides what this machine can't run, so "every record switched
  // off" has to stay apart from "no record at all" and from "fetch failed".
  describe('providerDisabled', () => {
    it('is true only when every record fronting the reviewer is switched off', async () => {
      getProviders.mockResolvedValue({ providers: [
        { id: 'kimi-cli', type: 'cli', command: 'kimi', enabled: false, models: [] },
        { id: 'kimi-tui', type: 'tui', command: 'kimi', enabled: false, models: [] },
        { id: 'grok-cli', type: 'cli', command: 'grok', enabled: false, models: [] },
        { id: 'grok-tui', type: 'tui', command: 'grok', enabled: true, models: [] },
        // No `enabled` key at all — a record written before the flag existed
        // must not read as off.
        { id: 'codex', type: 'cli', command: 'codex', models: [] },
      ] });
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.providerDisabled.kimi).toBe(true);
      expect(result.current.providerDisabled.grok).toBe(false);
      expect(result.current.providerDisabled.codex).toBe(false);
    });

    it('reports nothing disabled when the reviewer has no records, or the fetch failed', async () => {
      getProviders.mockResolvedValue({ providers: [] });
      const { result } = renderHook(() => useReviewerModelOptions());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      for (const reviewer of MODEL_SELECTABLE_REVIEWERS) {
        expect(result.current.providerDisabled[reviewer], reviewer).toBe(false);
      }
    });
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
      expect(await levelsFor('codex', 'gpt-5.6-sol')).toContain('xhigh');
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
