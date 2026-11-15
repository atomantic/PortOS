/**
 * config.test.js
 *
 * config.js run-option resolvers and config gates. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));

vi.mock('../../runner.js', (importOriginal) => h.runnerFactory(importOriginal));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cosState.js', () => h.cosStateFactory());
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
vi.mock('../../cosTaskStore.js', () => h.cosTaskStoreFactory());
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
});

// The precedence itself is covered by server/lib/seriesLlmOverride.test.js —
// what's specific here is that the autopilot delegates to it and renames the
// keys to the run-option ones.
describe('resolveAutopilotLlm — run provider/model resolution', () => {
  const series = { llm: { provider: 'codex', model: 'gpt-x' } };

  it('inherits the series llm under the run-option key names', () => {
    expect(autopilot.resolveAutopilotLlm({}, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x' });
  });

  it('lets a per-run override win, dropping the series model when the provider differs', () => {
    expect(autopilot.resolveAutopilotLlm({ providerOverride: 'claude' }, series))
      .toEqual({ providerOverride: 'claude', modelOverride: undefined });
  });

  it('resolves to nothing with no series llm and no override (active provider downstream)', () => {
    expect(autopilot.resolveAutopilotLlm({}, null))
      .toEqual({ providerOverride: undefined, modelOverride: undefined });
  });

  it('stamps a per-run reasoning effort (#3641) — per-run only, nothing to inherit', () => {
    expect(autopilot.resolveAutopilotLlm({ effortOverride: 'high' }, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x', effortOverride: 'high' });
    // No series-level effort exists, so a blank pick stays unset and each stage
    // falls through to its own pin, then the provider's configured args.
    expect(autopilot.resolveAutopilotLlm({ effortOverride: '' }, series).effortOverride).toBeUndefined();
  });
});

describe('resolveAutopilotProduceTeaser (config gate, #2185)', () => {
  it('defaults OFF', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({}, null)).toBe(false);
  });
  it('per-run option wins over the persisted setting', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({ produceTeaser: true }, { pipelineEditorialChecks: { produceTeaser: false } })).toBe(true);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({}, { pipelineEditorialChecks: { produceTeaser: true } })).toBe(true);
  });
});

describe('resolveAutopilotUnlockForRun (config gate)', () => {
  it('defaults OFF — it mutates lock state the user set by hand', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({})).toBe(false);
    expect(autopilot.resolveAutopilotUnlockForRun({ unlockForRun: false })).toBe(false);
  });
  it('is on only when the run explicitly asks for it', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({ unlockForRun: true })).toBe(true);
  });
  // The one autopilot option with NO persisted default: `seriesAutopilotScheduler`
  // resolves unattended runs from the settings slice, so a saved value would arm
  // lock-clearing on every scheduled run of every series.
  it('ignores a persisted setting entirely — per-run only', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({}, { pipelineEditorialChecks: { unlockForRun: true } })).toBe(false);
  });
});

describe('resolveAutopilotAutoSelectModels (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(autopilot.resolveAutopilotAutoSelectModels({}, null)).toBe(false);
    expect(autopilot.resolveAutopilotAutoSelectModels({}, { pipelineEditorialChecks: { autoSelectModels: true } })).toBe(true);
    expect(autopilot.resolveAutopilotAutoSelectModels(
      { autoSelectModels: false },
      { pipelineEditorialChecks: { autoSelectModels: true } },
    )).toBe(false);
  });
});

// Persistable (unlike unlockForRun): it re-routes spend but mutates nothing,
// and the scheduler resolves unattended runs from this same settings slice.
describe('resolveAutopilotOverrideStagePins (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(autopilot.resolveAutopilotOverrideStagePins({}, null)).toBe(false);
    expect(autopilot.resolveAutopilotOverrideStagePins({}, { pipelineEditorialChecks: { overrideStagePins: true } })).toBe(true);
    expect(autopilot.resolveAutopilotOverrideStagePins(
      { overrideStagePins: false },
      { pipelineEditorialChecks: { overrideStagePins: true } },
    )).toBe(false);
  });
});

describe('resolveAutopilotSelfImprove (config gate)', () => {
  const { resolveAutopilotSelfImprove } = autopilot;

  it('defaults OFF', () => {
    expect(resolveAutopilotSelfImprove({}, null)).toBe(false);
  });
  it('per-run option wins over the persisted setting', () => {
    expect(resolveAutopilotSelfImprove({ selfImprove: true }, { pipelineEditorialChecks: { selfImprove: false } })).toBe(true);
    expect(resolveAutopilotSelfImprove({ selfImprove: false }, { pipelineEditorialChecks: { selfImprove: true } })).toBe(false);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    expect(resolveAutopilotSelfImprove({}, { pipelineEditorialChecks: { selfImprove: true } })).toBe(true);
  });
});

// CWQE Phase 7 (#2171) — iterate-to-quality revision loop.
describe('resolveAutopilotRevision (config gate, #2171)', () => {
  const {
    resolveAutopilotRevision,
    DEFAULT_REVISION_MIN_CYCLES,
    DEFAULT_REVISION_MAX_CYCLES,
    DEFAULT_REVISION_PLATEAU_DELTA,
  } = autopilot;

  it('defaults OFF with the module cycle defaults', () => {
    expect(resolveAutopilotRevision({}, null)).toEqual({
      revisionEnabled: false,
      revisionMinCycles: DEFAULT_REVISION_MIN_CYCLES,
      revisionMaxCycles: DEFAULT_REVISION_MAX_CYCLES,
      revisionPlateauDelta: DEFAULT_REVISION_PLATEAU_DELTA,
    });
  });
  it('per-run option wins over the persisted setting', () => {
    const r = resolveAutopilotRevision(
      { revisionEnabled: true, revisionMaxCycles: 4, revisionPlateauDelta: 0.5 },
      { pipelineEditorialChecks: { revisionEnabled: false, revisionMaxCycles: 2 } },
    );
    expect(r.revisionEnabled).toBe(true);
    expect(r.revisionMaxCycles).toBe(4);
    expect(r.revisionPlateauDelta).toBe(0.5);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    const r = resolveAutopilotRevision({}, { pipelineEditorialChecks: { revisionEnabled: true, revisionMinCycles: 2 } });
    expect(r.revisionEnabled).toBe(true);
    expect(r.revisionMinCycles).toBe(2);
  });
  it('clamps maxCycles up to at least minCycles (misconfig can never strand the loop)', () => {
    const r = resolveAutopilotRevision({ revisionMinCycles: 3, revisionMaxCycles: 1 });
    expect(r.revisionMaxCycles).toBe(3);
  });
  it('floors minCycles at 1 and plateauDelta at 0', () => {
    const r = resolveAutopilotRevision({ revisionMinCycles: 0, revisionPlateauDelta: -5 });
    expect(r.revisionMinCycles).toBe(1);
    expect(r.revisionPlateauDelta).toBe(0);
  });
});
