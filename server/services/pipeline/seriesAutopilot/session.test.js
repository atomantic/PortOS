/**
 * session.test.js
 *
 * session.js provider/model threading helpers. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));

const stopRun = vi.hoisted(() => vi.fn());
vi.mock('../../runner.js', async (importOriginal) => ({ ...await h.runnerFactory(importOriginal), stopRun }));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cos/cosState.js', () => h.cosStateFactory());
vi.mock('../../domainUsage.js', () => h.domainUsageFactory());
vi.mock('../arcPlanner.js', (importOriginal) => h.arcPlannerFactory(importOriginal));
vi.mock('../volumeBeatsRunner.js', () => h.volumeBeatsSpies);
vi.mock('../autoRunner.js', () => h.autoRunnerSpies);
vi.mock('../manuscriptReview.js', () => h.manuscriptReviewFactory());
vi.mock('../editorial/checkRunner.js', () => h.checkRunnerSpies);
vi.mock('../reverseOutline.js', () => h.reverseOutlineFactory());
vi.mock('../../settings.js', (importOriginal) => h.settingsFactory(importOriginal));
vi.mock('../manuscriptFix.js', () => h.manuscriptFixFactory());
vi.mock('../visualStages.js', () => h.visualSpies);
vi.mock('../../cos/cosTaskStore.js', () => h.cosTaskStoreFactory());
vi.mock('../scriptVerify.js', () => h.scriptVerifyFactory());
vi.mock('../canonReadiness.js', () => h.canonReadinessFactory());
vi.mock('../../universeCanon.js', () => h.universeCanonFactory());
vi.mock('../foundationJudge.js', (importOriginal) => h.foundationJudgeFactory(importOriginal));
vi.mock('./modelPerformance.js', () => h.modelPerformanceFactory());
vi.mock('../../notifications.js', () => h.notificationsFactory());

// Mocked bindings, so a test can drive the budget and persisted settings per call.
const { getDomainBudgetStatus } = await import('../../domainUsage.js');
const { getSettings } = await import('../../settings.js');

// Real services + the unit under test (imported AFTER the mocks above).
const autopilot = await import('../seriesAutopilot.js');

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
  stopRun.mockReset();
});

it('keeps a canceled run available to retry when stopping the provider fails', async () => {
  const record = { seriesId: 'test-series', runId: 'test-autopilot', options: {}, clients: [], cancelRequested: true };
  const { onRunCreated, onRunSettled } = autopilot.__testing.providerOverrideOpts(record);
  autopilot.runs.set(record.seriesId, record);
  stopRun.mockRejectedValueOnce(Object.assign(new Error('synthetic stop failure'), { code: 'EPERM' })).mockResolvedValue(true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    onRunCreated('test-llm');
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('llmRun=test-llm code=EPERM')));
    expect(record.activeLlmRunId).toBe('test-llm');
    expect(autopilot.cancelSeriesAutopilot(record.seriesId)).toBe(true);
    expect(stopRun.mock.calls).toEqual([['test-llm'], ['test-llm']]);
    onRunSettled('test-llm');
    expect(record.activeLlmRunId).toBeNull();
  } finally {
    log.mockRestore();
    autopilot.runs.delete(record.seriesId);
  }
});

describe('provider/model threading helpers (#1514 provider + #1558 model — both SOFT defaults)', () => {
  const record = { options: { providerOverride: 'codex', modelOverride: 'gpt-x' } };

  it('providerOverrideOpts emits providerDefault + modelDefault (NOT hard overrides) so a stage pin still wins', () => {
    const opts = autopilot.__testing.providerOverrideOpts(record);
    expect(opts.providerDefault).toBe('codex');
    expect(opts.modelDefault).toBe('gpt-x');
    // The whole point of the change: neither the run provider NOR the run model
    // may arrive as a hard override, or it would beat a deliberate per-stage pin.
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('modelOverride');
  });

  it('providerIdOpts emits providerIdDefault + modelIdDefault for the { providerId }-style services', () => {
    const opts = autopilot.__testing.providerIdOpts(record);
    expect(opts.providerIdDefault).toBe('codex');
    expect(opts.modelIdDefault).toBe('gpt-x');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('model');
  });

  it('passes an undefined default through untouched when the run pins no provider/model', () => {
    const none = { options: {} };
    expect(autopilot.__testing.providerOverrideOpts(none).providerDefault).toBeUndefined();
    expect(autopilot.__testing.providerOverrideOpts(none).modelDefault).toBeUndefined();
    expect(autopilot.__testing.providerIdOpts(none).providerIdDefault).toBeUndefined();
    expect(autopilot.__testing.providerIdOpts(none).modelIdDefault).toBeUndefined();
  });

  it('routes judges separately while keeping creation on the run default', () => {
    const split = {
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
      },
    };
    expect(autopilot.__testing.providerOverrideOpts(split)).toMatchObject({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-luna', effortDefault: 'max',
    });
    expect(autopilot.__testing.providerOverrideOpts(split, 'judge')).toMatchObject({
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
    expect(autopilot.__testing.roleLlm(split, 'judge')).toEqual({
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
    expect(autopilot.__testing.roleLlm(learned, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: 'local-14b', effortOverride: undefined,
    });
    // …but never over a hand-picked one.
    expect(autopilot.__testing.roleLlm(learned, 'judge')).toEqual({
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
    expect(autopilot.__testing.roleLlm(chosen, role)).toEqual({
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
    expect(autopilot.__testing.roleLlm(effortOnly, 'creative').effortOverride).toBe('max');
    expect(autopilot.__testing.roleLlm(effortOnly, 'judge')).toEqual({
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
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    expect(autopilot.__testing.roleLlm(routed, 'judge')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    routed.currentStep = 'generateEpisodes';
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
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
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: undefined, effortOverride: 'max',
    });
  });
});
