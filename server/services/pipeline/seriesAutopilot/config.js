/**
 * Series Autopilot — convergence-round ceilings, gate defaults and the
 * per-run/settings option resolvers (#2842 split of seriesAutopilot.js).
 */

import { READINESS_GATES, readReadinessGate } from '../../../lib/editorial/severityConfig.js';
import { resolveSeriesLlmOverride } from '../../../lib/seriesLlmOverride.js';
import { SERIES_AUTOPILOT_DEFAULTS } from '../../../lib/seriesAutopilotDefaults.js';

// Bounded convergence loops: re-verify/re-review at most this many rounds, then
// pause with the residual findings. Floor defaults; raisable via
// pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds} or per run.
export const MAX_ARC_VERIFY_ROUNDS = SERIES_AUTOPILOT_DEFAULTS.maxArcVerifyRounds;
export const MAX_EDITORIAL_ROUNDS = SERIES_AUTOPILOT_DEFAULTS.maxEditorialRounds;
// Whole-manuscript beat-continuity convergence (#1510), between beat generation
// and the text/script stage; bounded like the others.
export const MAX_BEAT_CONTINUITY_ROUNDS = SERIES_AUTOPILOT_DEFAULTS.maxBeatContinuityRounds;

// Foundation-quality gate (CWQE Phase 11, #2176): judge world/characters/arc against
// a weighted rubric before drafting, iterate on the weakest dimension up to a bound,
// then pause with the residual findings. 0 rounds skips the gate.
export const MAX_FOUNDATION_ROUNDS = SERIES_AUTOPILOT_DEFAULTS.maxFoundationRounds;
export const DEFAULT_FOUNDATION_GATE_ENABLED = SERIES_AUTOPILOT_DEFAULTS.foundationGate;

// Bounded retry budget for a delegated child runner (#1574): a child whose target
// stage(s) are still empty after an LLM failure is retried this many more times
// (skip-existing) before the work is marked attempted and the run pauses with the
// residual. 0 = single attempt. Per-run `maxChildRetries` overrides.
export const MAX_CHILD_RETRIES = 1;

// Corrective-pass budget for the arc-verify regression guard (#3781). A resolver
// round that GREW the blocking count is reverted; this is how many times the gate
// may re-run the resolver from the restored best state, with the rejected
// attempt's findings attached as a "do not author these" list, before pausing.
// Without it a resume re-runs the identical prompt and can regress identically.
// 0 = revert-and-pause on the first regression. Per-run `maxArcResolveRetries`
// overrides; deliberately no persisted setting.
export const MAX_ARC_RESOLVE_RETRIES = 1;

// Per-finding ISOLATION budget for the arc-verify gate (#3780), counted in PROVIDER
// CALLS across the gate: once corrective passes are spent, residual findings are
// tried one at a time, keeping only patches that close their target without
// growing the blocking set. Calls, not attempts, because verification costs one
// call per volume. `maxArcIsolationAttempts` overrides per run; `maxArcResolveRetries: 0`
// opts out of isolation too.
export const MAX_ARC_ISOLATION_CALLS = 8;

// Effective isolation budget in ATTEMPTS: explicit `maxArcIsolationAttempts`; else
// 0 if `maxArcResolveRetries: 0`; else the call budget divided by one attempt's
// cost (a resolve plus one verification call for the arc and per volume). Shared
// with the dry-run plan so projection and reachable spend use one formula.
export function resolveArcIsolationAttempts(options = {}, volumesChecked = 0) {
  const explicit = options?.maxArcIsolationAttempts;
  if (Number.isInteger(explicit)) return Math.max(0, explicit);
  const retries = options?.maxArcResolveRetries;
  if (Number.isInteger(retries) && retries <= 0) return 0;
  return Math.max(1, Math.floor(MAX_ARC_ISOLATION_CALLS / (2 + volumesChecked)));
}

// Worst-case actions one gate's isolation pass can bill, for the dry-run plan.
export const arcIsolationActions = (options, volumesChecked = 0) =>
  resolveArcIsolationAttempts(options, volumesChecked) * (2 + volumesChecked);

// Precedence for a BOOLEAN knob: per-run option, then persisted
// pipelineEditorialChecks setting, then module default.
const pickBool = (o, s, fallback) => {
  if (typeof o === 'boolean') return o;
  if (typeof s === 'boolean') return s;
  return fallback;
};

// Effective round bounds: per-run option, then persisted pipelineEditorialChecks,
// then module default; non-integers fall through. Shared by loops, dry-run, resume.
export function resolveAutopilotRounds(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  const pick = (optKey, setKey, fallback) => {
    if (Number.isInteger(options?.[optKey])) return options[optKey];
    if (Number.isInteger(pec?.[setKey])) return pec[setKey];
    return fallback;
  };
  return {
    maxArcVerifyRounds: pick('maxArcVerifyRounds', 'maxArcVerifyRounds', MAX_ARC_VERIFY_ROUNDS),
    maxEditorialRounds: pick('maxEditorialRounds', 'maxEditorialRounds', MAX_EDITORIAL_ROUNDS),
    maxBeatContinuityRounds: pick('maxBeatContinuityRounds', 'maxBeatContinuityRounds', MAX_BEAT_CONTINUITY_ROUNDS),
    maxFoundationRounds: pick('maxFoundationRounds', 'maxFoundationRounds', MAX_FOUNDATION_ROUNDS),
  };
}

// Foundation-gate config (#2176): whether it runs (defaults ON) and the weighted
// [0,10] threshold; an unset threshold falls through to the judge's shared default.
export function resolveAutopilotFoundationGate(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.foundationGate, pec?.foundationGate, DEFAULT_FOUNDATION_GATE_ENABLED);
}
export function resolveAutopilotFoundationThreshold(options = {}, settings = null) {
  if (Number.isFinite(options?.foundationThreshold)) return options.foundationThreshold;
  const pec = settings?.pipelineEditorialChecks || {};
  if (Number.isFinite(pec?.foundationThreshold)) return pec.foundationThreshold;
  return null;
}

// Editorial-health readiness gate (#1580): per-run option, then persisted
// pipelineEditorialChecks.readinessGate; the caller resolves null to the default.
export function resolveAutopilotReadinessGate(options = {}, settings = null) {
  if (READINESS_GATES.includes(options?.readinessGate)) return options.readinessGate;
  return readReadinessGate(settings);
}

// Editorial-checks pause threshold (#1613): pause when the checks pass surfaces
// >= N high-severity findings. 0 = off (opt-in).
export const DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD = SERIES_AUTOPILOT_DEFAULTS.checkFindingsPauseThreshold;
export function resolveAutopilotCheckPauseThreshold(options = {}, settings = null) {
  if (Number.isInteger(options?.checkFindingsPauseThreshold)) return options.checkFindingsPauseThreshold;
  const pec = settings?.pipelineEditorialChecks || {};
  if (Number.isInteger(pec?.checkFindingsPauseThreshold)) return pec.checkFindingsPauseThreshold;
  return DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD;
}

// Pause notification (#1615): defaults ON (zero-cost signal so paused runs don't
// go unnoticed); overridable per run and via the persisted setting.
export const DEFAULT_NOTIFY_ON_PAUSE = SERIES_AUTOPILOT_DEFAULTS.notifyOnPause;
export function resolveAutopilotNotifyOnPause(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.notifyOnPause, pec?.notifyOnPause, DEFAULT_NOTIFY_ON_PAUSE);
}

// Autopilot -> CD teaser deliverable (CDO Phase 3, #2185). Defaults OFF: video is
// a fresh burst of LLM + render spend.
export const DEFAULT_PRODUCE_TEASER = false;
export function resolveAutopilotProduceTeaser(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.produceTeaser, pec?.produceTeaser, DEFAULT_PRODUCE_TEASER);
}

// A teaser is a visual deliverable: needs the flag AND a visual run.
export function wantsTeaser(options = {}) {
  return options.produceTeaser === true && wantsVisual(options);
}

// Unlock-everything-first (see ./unlockPass.js): the run's first step clears every
// lock this series owns. PER-RUN ONLY, deliberately: it rewrites protection state
// the user set by hand, and a saved default would arm lock-clearing for every
// future unattended scheduled run of every series (`seriesAutopilotScheduler`).
export function resolveAutopilotUnlockForRun(options = {}) {
  return options?.unlockForRun === true;
}

// Iterate-to-quality revision loop (CWQE Phase 7, #2171). Defaults OFF (extra
// judge + cut LLM spend). minCycles floors the plateau/hedge stops, maxCycles is
// the cost ceiling, plateauDelta the mean-score movement counted as converged.
export const DEFAULT_REVISION_ENABLED = SERIES_AUTOPILOT_DEFAULTS.revisionEnabled;
export const DEFAULT_REVISION_MIN_CYCLES = SERIES_AUTOPILOT_DEFAULTS.revisionMinCycles;
export const DEFAULT_REVISION_MAX_CYCLES = SERIES_AUTOPILOT_DEFAULTS.revisionMaxCycles;
export const DEFAULT_REVISION_PLATEAU_DELTA = SERIES_AUTOPILOT_DEFAULTS.revisionPlateauDelta;
export function resolveAutopilotRevision(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  const int = (o, s, fallback) => {
    if (Number.isInteger(o)) return o;
    if (Number.isInteger(s)) return s;
    return fallback;
  };
  const num = (o, s, fallback) => {
    if (Number.isFinite(o)) return o;
    if (Number.isFinite(s)) return s;
    return fallback;
  };
  const minCycles = int(options?.revisionMinCycles, pec?.revisionMinCycles, DEFAULT_REVISION_MIN_CYCLES);
  const maxCycles = int(options?.revisionMaxCycles, pec?.revisionMaxCycles, DEFAULT_REVISION_MAX_CYCLES);
  return {
    revisionEnabled: pickBool(options?.revisionEnabled, pec?.revisionEnabled, DEFAULT_REVISION_ENABLED),
    revisionMinCycles: Math.max(1, minCycles),
    // maxCycles never below minCycles — a misconfig can't strand the loop unable to run.
    revisionMaxCycles: Math.max(Math.max(1, minCycles), maxCycles),
    revisionPlateauDelta: Math.max(0, num(options?.revisionPlateauDelta, pec?.revisionPlateauDelta, DEFAULT_REVISION_PLATEAU_DELTA)),
  };
}

// Pipeline self-improvement: one post-run meta-diagnosis that may file a CoS task
// against PortOS. Defaults OFF (LLM spend, and it files work on PortOS's own code);
// clean-telemetry runs never spend even when enabled (`shouldDiagnose`). The filed
// task always awaits approval (see selfImprove.js header).
export const DEFAULT_SELF_IMPROVE = SERIES_AUTOPILOT_DEFAULTS.selfImprove;
export function resolveAutopilotSelfImprove(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.selfImprove, pec?.selfImprove, DEFAULT_SELF_IMPROVE);
}

// Observing orchestrator (see observer.js header). Defaults OFF and must stay an
// explicit opt-in: fresh LLM spend plus standing consent for auto-approved
// changes to PortOS's own code. Persistable, unlike unlockForRun.
export const DEFAULT_OBSERVER = SERIES_AUTOPILOT_DEFAULTS.observer;
export function resolveAutopilotObserver(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.observer, pec?.observer, DEFAULT_OBSERVER);
}

// Evidence-based provider/model/effort routing; defaults OFF so existing choices
// never change just because samples accrued. Fills in only where nothing was
// chosen; session.js#roleLlm owns the precedence.
export const DEFAULT_AUTO_SELECT_MODELS = SERIES_AUTOPILOT_DEFAULTS.autoSelectModels;
export function resolveAutopilotAutoSelectModels(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.autoSelectModels, pec?.autoSelectModels, DEFAULT_AUTO_SELECT_MODELS);
}

// Force this run's route onto EVERY stage (mechanism in lib/stagePinPolicy.js +
// stageRunner#effectiveStage). Defaults OFF, persistable: it re-routes spend but
// mutates nothing. Per-run option wins, then the persisted setting.
export const DEFAULT_OVERRIDE_STAGE_PINS = SERIES_AUTOPILOT_DEFAULTS.overrideStagePins;
export function resolveAutopilotOverrideStagePins(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.overrideStagePins, pec?.overrideStagePins, DEFAULT_OVERRIDE_STAGE_PINS);
}

// Run LLM routing: per-run `providerOverride`/`modelOverride` wins, else the
// series' own `series.llm`; both absent stays undefined. Precedence lives in
// `resolveSeriesLlmOverride`. Threaded as SOFT defaults (session.js#providerOverrideOpts)
// so a per-stage pin still wins, unless `overrideStagePins` is on.
export function resolveAutopilotLlm(options = {}, series = null) {
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: options?.providerOverride,
    overrideModel: options?.modelOverride,
  });
  // Effort is per-run only (no series-level effort); blank stays undefined so each
  // stage falls through to its own pin (session.js#providerOverrideOpts).
  return { providerOverride: provider, modelOverride: model, effortOverride: options?.effortOverride || undefined };
}

// `target` overrides `includeVisual`: 'text' forces text-only, 'visual' forces
// visuals, 'auto' (default) honors `includeVisual` (default true).
export function wantsVisual(options = {}) {
  if (options.target === 'text') return false;
  if (options.target === 'visual') return true;
  return options.includeVisual !== false;
}
