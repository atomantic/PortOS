import { describe, it, expect, vi } from 'vitest';
import { stopRun } from '../../runner.js';
import { cancelSeriesAutopilot, providerIdOpts, providerOverrideOpts, roleLlm } from './session.js';
import { runs } from './state.js';

vi.mock('../../runner.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stopRun: vi.fn(),
}));

it('keeps a canceled run available to retry when stopping the provider fails', async () => {
  const record = { seriesId: 'test-series', runId: 'test-autopilot', options: {}, clients: [], cancelRequested: true };
  const { onRunCreated, onRunSettled } = providerOverrideOpts(record);
  runs.set(record.seriesId, record);
  stopRun.mockRejectedValueOnce(Object.assign(new Error('synthetic stop failure'), { code: 'EPERM' })).mockResolvedValue(true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    onRunCreated('test-llm');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('llmRun=test-llm code=EPERM')));
    expect(record.activeLlmRunId).toBe('test-llm');
    expect(cancelSeriesAutopilot(record.seriesId)).toBe(true);
    expect(stopRun.mock.calls).toEqual([['test-llm'], ['test-llm']]);
    onRunSettled('test-llm');
    expect(record.activeLlmRunId).toBeNull();
  } finally {
    log.mockRestore();
    runs.delete(record.seriesId);
  }
});

describe('provider/model threading helpers (#1514 provider + #1558 model — both SOFT defaults)', () => {
  const record = { options: { providerOverride: 'codex', modelOverride: 'gpt-x' } };

  it('providerOverrideOpts emits providerDefault + modelDefault (NOT hard overrides) so a stage pin still wins', () => {
    const opts = providerOverrideOpts(record);
    expect(opts.providerDefault).toBe('codex');
    expect(opts.modelDefault).toBe('gpt-x');
    // The whole point of the change: neither the run provider NOR the run model
    // may arrive as a hard override, or it would beat a deliberate per-stage pin.
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('modelOverride');
  });

  it('providerIdOpts emits providerIdDefault + modelIdDefault for the { providerId }-style services', () => {
    const opts = providerIdOpts(record);
    expect(opts.providerIdDefault).toBe('codex');
    expect(opts.modelIdDefault).toBe('gpt-x');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('model');
  });

  it('passes an undefined default through untouched when the run pins no provider/model', () => {
    const none = { options: {} };
    expect(providerOverrideOpts(none).providerDefault).toBeUndefined();
    expect(providerOverrideOpts(none).modelDefault).toBeUndefined();
    expect(providerIdOpts(none).providerIdDefault).toBeUndefined();
    expect(providerIdOpts(none).modelIdDefault).toBeUndefined();
  });

  it('routes judges separately while keeping creation on the run default', () => {
    const split = {
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
      },
    };
    expect(providerOverrideOpts(split)).toMatchObject({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-luna', effortDefault: 'max',
    });
    expect(providerOverrideOpts(split, 'judge')).toMatchObject({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-sol', effortDefault: 'xhigh',
    });
  });

  it('drops a creative model when the judge changes provider without choosing one', () => {
    const split = {
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'claude-code-tui', effortOverride: 'high' },
      },
    };
    expect(roleLlm(split, 'judge')).toEqual({
      providerOverride: 'claude-code-tui', modelOverride: undefined, effortOverride: 'high',
    });
  });

  // Learned routing fills in only where the run routed NOTHING. The run route
  // reaching roleLlm is already resolved (per-run picker, else the series' own
  // `series.llm`), so "the run chose none" means both are blank.
  const recommendations = {
    foundationGate: {
      creative: { providerOverride: 'ollama', modelOverride: 'local-14b' },
      judge: { providerOverride: 'codex', modelOverride: 'judge-model' },
    },
  };

  it('uses learned stage/role routing for a role the run left unrouted', () => {
    const learned = {
      currentStep: 'foundationGate',
      options: {
        autoSelectModels: true,
        modelRecommendations: recommendations,
        judgeLlm: { providerOverride: 'manual-judge', modelOverride: 'manual-model' },
      },
    };
    expect(roleLlm(learned, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: 'local-14b', effortOverride: undefined,
    });
    // …but never over a hand-picked one.
    expect(roleLlm(learned, 'judge')).toEqual({
      providerOverride: 'manual-judge', modelOverride: 'manual-model', effortOverride: undefined,
    });
  });

  // The live failure: with `autoSelectModels` on, a run that picked ONE
  // provider/model and left "use a separate model for judging" unchecked kept
  // CREATION on that route while every judge-role call — pipeline-arc-verify
  // above all — was re-pointed at the learned route. Judging inherits the run
  // route, so choosing the run route chooses the judge with it.
  it.each(['creative', 'judge'])('keeps the %s role on the run route the user chose', (role) => {
    const chosen = {
      currentStep: 'foundationGate',
      options: {
        autoSelectModels: true,
        providerOverride: 'antigravity-tui',
        modelOverride: 'gemini-3.6-flash-high',
        effortOverride: 'high',
        modelRecommendations: recommendations,
      },
    };
    expect(roleLlm(chosen, role)).toEqual({
      providerOverride: 'antigravity-tui', modelOverride: 'gemini-3.6-flash-high', effortOverride: 'high',
    });
  });

  // Any ONE dimension is a deliberate choice — an effort-only run route still
  // has to keep its (provider-default) route rather than adopt a learned one.
  it('treats an effort-only run route as chosen for both roles', () => {
    const effortOnly = {
      currentStep: 'foundationGate',
      options: { autoSelectModels: true, effortOverride: 'max', modelRecommendations: recommendations },
    };
    expect(roleLlm(effortOnly, 'creative').effortOverride).toBe('max');
    expect(roleLlm(effortOnly, 'judge')).toEqual({
      providerOverride: undefined, modelOverride: undefined, effortOverride: 'max',
    });
  });

  it('routes one stage and role to an explicit specialist without changing other steps', () => {
    const routed = {
      currentStep: 'foundationGate',
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
        stageLlm: {
          foundationGate: {
            creative: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
          },
        },
      },
    };
    expect(roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    expect(roleLlm(routed, 'judge')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    routed.currentStep = 'generateEpisodes';
    expect(roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
    });
  });

  it('does not carry a role model across a stage-level provider change', () => {
    const routed = {
      currentStep: 'foundationGate',
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        stageLlm: { foundationGate: { creative: { providerOverride: 'ollama' } } },
      },
    };
    expect(roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: undefined, effortOverride: 'max',
    });
  });
});
