import { describe, it, expect } from 'vitest';
import { SERIES_AUTOPILOT_DEFAULTS } from '../../../lib/seriesAutopilotDefaults.js';
import {
  DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD, DEFAULT_NOTIFY_ON_PAUSE,
  DEFAULT_REVISION_MAX_CYCLES, DEFAULT_REVISION_MIN_CYCLES, DEFAULT_REVISION_PLATEAU_DELTA,
  MAX_ARC_VERIFY_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS, MAX_EDITORIAL_ROUNDS, MAX_FOUNDATION_ROUNDS,
  resolveAutopilotAutoSelectModels, resolveAutopilotCheckPauseThreshold, resolveAutopilotFoundationGate,
  resolveAutopilotLlm, resolveAutopilotNotifyOnPause, resolveAutopilotObserver, resolveAutopilotOverrideStagePins,
  resolveAutopilotProduceTeaser, resolveAutopilotReadinessGate, resolveAutopilotRevision, resolveAutopilotRounds,
  resolveAutopilotSelfImprove, resolveAutopilotUnlockForRun,
} from './config.js';

// The precedence itself is covered by server/lib/seriesLlmOverride.test.js —
// what's specific here is that the autopilot delegates to it and renames the
// keys to the run-option ones.
describe('resolveAutopilotLlm — run provider/model resolution', () => {
  const series = { llm: { provider: 'codex', model: 'gpt-x' } };

  it('inherits the series llm under the run-option key names', () => {
    expect(resolveAutopilotLlm({}, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x' });
  });

  it('lets a per-run override win, dropping the series model when the provider differs', () => {
    expect(resolveAutopilotLlm({ providerOverride: 'claude' }, series))
      .toEqual({ providerOverride: 'claude', modelOverride: undefined });
  });

  it('resolves to nothing with no series llm and no override (active provider downstream)', () => {
    expect(resolveAutopilotLlm({}, null))
      .toEqual({ providerOverride: undefined, modelOverride: undefined });
  });

  it('stamps a per-run reasoning effort (#3641) — per-run only, nothing to inherit', () => {
    expect(resolveAutopilotLlm({ effortOverride: 'high' }, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x', effortOverride: 'high' });
    // No series-level effort exists, so a blank pick stays unset and each stage
    // falls through to its own pin, then the provider's configured args.
    expect(resolveAutopilotLlm({ effortOverride: '' }, series).effortOverride).toBeUndefined();
  });
});

describe('resolveAutopilotProduceTeaser (config gate, #2185)', () => {
  it('defaults OFF', () => {
    expect(resolveAutopilotProduceTeaser({}, null)).toBe(false);
  });
  it('per-run option wins over the persisted setting', () => {
    expect(resolveAutopilotProduceTeaser({ produceTeaser: true }, { pipelineEditorialChecks: { produceTeaser: false } })).toBe(true);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    expect(resolveAutopilotProduceTeaser({}, { pipelineEditorialChecks: { produceTeaser: true } })).toBe(true);
  });
});

describe('resolveAutopilotUnlockForRun (config gate)', () => {
  it('defaults OFF — it mutates lock state the user set by hand', () => {
    expect(resolveAutopilotUnlockForRun({})).toBe(false);
    expect(resolveAutopilotUnlockForRun({ unlockForRun: false })).toBe(false);
  });
  it('is on only when the run explicitly asks for it', () => {
    expect(resolveAutopilotUnlockForRun({ unlockForRun: true })).toBe(true);
  });
  // The one autopilot option with NO persisted default: `seriesAutopilotScheduler`
  // resolves unattended runs from the settings slice, so a saved value would arm
  // lock-clearing on every scheduled run of every series.
  it('ignores a persisted setting entirely — per-run only', () => {
    expect(resolveAutopilotUnlockForRun({}, { pipelineEditorialChecks: { unlockForRun: true } })).toBe(false);
  });
});

describe('resolveAutopilotAutoSelectModels (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(resolveAutopilotAutoSelectModels({}, null)).toBe(false);
    expect(resolveAutopilotAutoSelectModels({}, { pipelineEditorialChecks: { autoSelectModels: true } })).toBe(true);
    expect(resolveAutopilotAutoSelectModels(
      { autoSelectModels: false },
      { pipelineEditorialChecks: { autoSelectModels: true } },
    )).toBe(false);
  });
});

// Persistable (unlike unlockForRun): it re-routes spend but mutates nothing,
// and the scheduler resolves unattended runs from this same settings slice.
describe('resolveAutopilotOverrideStagePins (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(resolveAutopilotOverrideStagePins({}, null)).toBe(false);
    expect(resolveAutopilotOverrideStagePins({}, { pipelineEditorialChecks: { overrideStagePins: true } })).toBe(true);
    expect(resolveAutopilotOverrideStagePins(
      { overrideStagePins: false },
      { pipelineEditorialChecks: { overrideStagePins: true } },
    )).toBe(false);
  });
});

describe('resolveAutopilotSelfImprove (config gate)', () => {
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

describe('autopilot option defaults and precedence', () => {
  it('resolveAutopilotRounds: per-run option wins, else setting, else default', () => {
    // per-run option wins (including an explicit 0 = skip)
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5, maxFoundationRounds: 2 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 4, maxEditorialRounds: 4, maxBeatContinuityRounds: 1, maxFoundationRounds: 1 } },
    )).toEqual({ maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5, maxFoundationRounds: 2 });
    // persisted setting fills in when no per-run override
    const fromSetting = resolveAutopilotRounds({}, { pipelineEditorialChecks: { maxArcVerifyRounds: 6, maxBeatContinuityRounds: 3 } });
    expect(fromSetting.maxArcVerifyRounds).toBe(6);
    expect(fromSetting.maxEditorialRounds).toBe(MAX_EDITORIAL_ROUNDS);
    expect(fromSetting.maxBeatContinuityRounds).toBe(3);
    // module default when neither is set
    expect(resolveAutopilotRounds({}, null)).toEqual({
      maxArcVerifyRounds: MAX_ARC_VERIFY_ROUNDS, maxEditorialRounds: MAX_EDITORIAL_ROUNDS, maxBeatContinuityRounds: MAX_BEAT_CONTINUITY_ROUNDS, maxFoundationRounds: MAX_FOUNDATION_ROUNDS,
    });
    // a non-integer at any layer falls through
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 2.5 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 'x' } },
    ).maxArcVerifyRounds).toBe(MAX_ARC_VERIFY_ROUNDS);
  });

  it('uses the shared defaults when run options and saved settings are absent', () => {
    const defaults = SERIES_AUTOPILOT_DEFAULTS;
    expect(resolveAutopilotRounds({}, {})).toEqual({
      maxArcVerifyRounds: defaults.maxArcVerifyRounds,
      maxEditorialRounds: defaults.maxEditorialRounds,
      maxBeatContinuityRounds: defaults.maxBeatContinuityRounds,
      maxFoundationRounds: defaults.maxFoundationRounds,
    });
    expect(resolveAutopilotFoundationGate({}, {})).toBe(defaults.foundationGate);
    expect(resolveAutopilotCheckPauseThreshold({}, {})).toBe(defaults.checkFindingsPauseThreshold);
    expect(resolveAutopilotNotifyOnPause({}, {})).toBe(defaults.notifyOnPause);
    expect(resolveAutopilotRevision({}, {})).toEqual({
      revisionEnabled: defaults.revisionEnabled,
      revisionMinCycles: defaults.revisionMinCycles,
      revisionMaxCycles: defaults.revisionMaxCycles,
      revisionPlateauDelta: defaults.revisionPlateauDelta,
    });
    expect(resolveAutopilotSelfImprove({}, {})).toBe(defaults.selfImprove);
    expect(resolveAutopilotObserver({}, {})).toBe(defaults.observer);
    expect(resolveAutopilotAutoSelectModels({}, {})).toBe(defaults.autoSelectModels);
    expect(resolveAutopilotOverrideStagePins({}, {})).toBe(defaults.overrideStagePins);
  });

  it('resolveAutopilotReadinessGate: per-run option wins, else setting, else null (#1580)', () => {
    // per-run override wins over a persisted setting
    expect(resolveAutopilotReadinessGate(
      { readinessGate: 'none' },
      { pipelineEditorialChecks: { readinessGate: 'noOpenHighOrMedium' } },
    )).toBe('none');
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotReadinessGate({}, { pipelineEditorialChecks: { readinessGate: 'noOpenHighOrMedium' } }))
      .toBe('noOpenHighOrMedium');
    // null when neither is set — the caller resolves null to the default gate
    expect(resolveAutopilotReadinessGate({}, null)).toBeNull();
    // an invalid per-run gate falls through to the persisted setting
    expect(resolveAutopilotReadinessGate(
      { readinessGate: 'bogus' },
      { pipelineEditorialChecks: { readinessGate: 'none' } },
    )).toBe('none');
  });

  it('resolveAutopilotCheckPauseThreshold: per-run option wins, else setting, else 0/off (#1613)', () => {
    expect(DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD).toBe(0);
    // per-run override wins (including an explicit 0 = off)
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 0 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } },
    )).toBe(0);
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 8 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } },
    )).toBe(8);
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotCheckPauseThreshold({}, { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } })).toBe(5);
    // 0/off when neither is set
    expect(resolveAutopilotCheckPauseThreshold({}, null)).toBe(0);
    // a non-integer at any layer falls through to the next
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 2.5 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 'x' } },
    )).toBe(0);
  });

  it('resolveAutopilotNotifyOnPause: per-run option wins, else setting, else true/on (#1615)', () => {
    expect(DEFAULT_NOTIFY_ON_PAUSE).toBe(true);
    // per-run override wins (including an explicit false = silence)
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: false },
      { pipelineEditorialChecks: { notifyOnPause: true } },
    )).toBe(false);
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: true },
      { pipelineEditorialChecks: { notifyOnPause: false } },
    )).toBe(true);
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotNotifyOnPause({}, { pipelineEditorialChecks: { notifyOnPause: false } })).toBe(false);
    // on by default when neither is set (the one opt-OUT autopilot gate)
    expect(resolveAutopilotNotifyOnPause({}, null)).toBe(true);
    // a non-boolean at any layer falls through to the next
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: 'yes' },
      { pipelineEditorialChecks: { notifyOnPause: 1 } },
    )).toBe(true);
  });
});
