/**
 * Series Autopilot — convergence-round ceilings, gate defaults and the
 * per-run/settings option resolvers (#2842 split of seriesAutopilot.js).
 */

import { readReadinessGate } from '../../../lib/editorial/index.js';
import { resolveSeriesLlmOverride } from '../../../lib/seriesLlmOverride.js';
import { READINESS_GATES } from '../editorialScore.js';

// Bounded convergence loops — re-verify/re-review at most this many rounds, then
// pause for human review with the residual findings (see module header). These
// are the floor defaults; an install can raise them persistently via
// pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds} (or a single
// run can override per-run through the autopilot start options).
export const MAX_ARC_VERIFY_ROUNDS = 3;
export const MAX_EDITORIAL_ROUNDS = 2;
// Whole-manuscript beat-continuity convergence (#1510). The corpus is the
// compact per-issue beat sheets, so this gate sits between beat generation and
// the expensive text/script stage — bounded like the others, then pauses with
// the residual findings for human review.
export const MAX_BEAT_CONTINUITY_ROUNDS = 2;

// Foundation-quality gate (CWQE Phase 11, #2176). Before drafting, judge the
// whole foundation (world / characters / arc) against a weighted rubric and
// iterate on the weakest dimension until it clears a threshold — bounded like
// the other convergence loops, then pause with the residual per-dimension
// findings for human review. Defaults ON for autopilot runs (the point of the
// phase) but overridable per-run + via the persisted setting. 0 rounds skips
// the gate entirely (accept the foundation as-is).
export const MAX_FOUNDATION_ROUNDS = 3;
export const DEFAULT_FOUNDATION_GATE_ENABLED = true;

// Bounded retry budget for a delegated child runner (#1574). A child (volume
// beats / text auto-run) can finish with its target stage(s) still empty when
// the underlying LLM call failed. Before #1574 the autopilot marked the work
// attempted and advanced regardless — so a transient failure was caught only
// later (text) or not at all until a downstream emptiness check (beats). Now a
// child whose readiness check fails is retried up to MAX_CHILD_RETRIES more
// times (skip-existing, so a retry only fills the gap) before the work is
// marked attempted, an escalation frame is emitted, and the run pauses with the
// residual. 0 = single attempt, no retry (the legacy behavior). A per-run
// `maxChildRetries` option overrides it (plumbed through runOptions).
export const MAX_CHILD_RETRIES = 1;

// The one precedence rule every gate below follows for a BOOLEAN knob: an
// explicit per-run option wins, then the persisted pipelineEditorialChecks
// setting, then the module default. Hoisted so the file states it once — it was
// open-coded in three resolvers and closed over twice more, which is how the
// next gate ends up copying whichever variant it happened to land next to.
const pickBool = (o, s, fallback) => {
  if (typeof o === 'boolean') return o;
  if (typeof s === 'boolean') return s;
  return fallback;
};

// Resolve the effective round bounds for a run: an explicit per-run option wins,
// then the persisted pipelineEditorialChecks setting, then the module default.
// Returns integers only — a non-integer at any layer falls through to the next.
// Centralized so the loops, the dry-run plan, and the resume path all agree.
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

// Foundation-gate config (#2176): whether the gate runs, and the weighted [0,10]
// threshold the foundation must clear. Mirror resolveAutopilotRounds — per-run
// option wins, then the persisted pipelineEditorialChecks setting, then the
// default. The enable flag defaults ON (the point of the phase); the threshold
// falls through to DEFAULT_FOUNDATION_THRESHOLD in the loop when unset. Stamped
// onto run options once at start so the loop, the dry-run plan, and a resume all
// read the same effective values.
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

// Resolve the effective editorial-health readiness gate for a run (#1580): an
// explicit per-run option wins, then the persisted
// pipelineEditorialChecks.readinessGate, then null — the caller resolves null to
// DEFAULT_READINESS_GATE via resolveReadinessGate. Mirrors resolveAutopilotRounds
// so the gate is overridable per-run exactly like the round bounds; stamped onto
// the run options once at start so the loop, the dry-run plan, and a later resume
// all read the same effective gate.
export function resolveAutopilotReadinessGate(options = {}, settings = null) {
  if (READINESS_GATES.includes(options?.readinessGate)) return options.readinessGate;
  return readReadinessGate(settings);
}

// Editorial-checks pause threshold (#1613): pause the run when the checks pass
// surfaces ≥ N high-severity findings. 0 = off (the default), so the gate is
// opt-in and existing installs are unchanged. Mirrors resolveAutopilotRounds —
// per-run option wins, then the persisted setting, then 0. A non-integer at any
// layer falls through to the next. Stamped onto run options once at start so the
// loop and a later resume read the same effective threshold.
export const DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD = 0;
export function resolveAutopilotCheckPauseThreshold(options = {}, settings = null) {
  if (Number.isInteger(options?.checkFindingsPauseThreshold)) return options.checkFindingsPauseThreshold;
  const pec = settings?.pipelineEditorialChecks || {};
  if (Number.isInteger(pec?.checkFindingsPauseThreshold)) return pec.checkFindingsPauseThreshold;
  return DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD;
}

// Pause escalation (#1615): post an in-app notification (notification center,
// surfaced in the header dropdown) when a run pauses, so a paused run doesn't sit
// unnoticed until the user happens to open the status page. Unlike the other
// gates this defaults ON — it's a zero-cost informational signal that directly
// addresses the "paused runs go unnoticed" problem — but stays overridable per
// run and via the persisted setting for users who don't want the noise. Boolean
// at every layer: per-run option wins, then the persisted setting, then true.
export const DEFAULT_NOTIFY_ON_PAUSE = true;
export function resolveAutopilotNotifyOnPause(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.notifyOnPause, pec?.notifyOnPause, DEFAULT_NOTIFY_ON_PAUSE);
}

// Autopilot → CD teaser deliverable (CDO Phase 3, #2185). Once a comic issue is
// text-ready + drafted, the autopilot can OPTIONALLY mint + start a Creative
// Director video project (a teaser/trailer) seeded from the issue — the reverse
// of the CD→autopilot bridge. Defaults OFF: producing video is a fresh burst of
// LLM + render spend the user must opt into, so existing runs are unchanged.
// Per-run option wins, then the persisted setting, then false. Stamped onto run
// options once at start so the resolver, the dry-run plan, and a later resume
// all read the same effective flag.
export const DEFAULT_PRODUCE_TEASER = false;
export function resolveAutopilotProduceTeaser(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.produceTeaser, pec?.produceTeaser, DEFAULT_PRODUCE_TEASER);
}

// Does THIS run want to produce a teaser deliverable? Gated on the resolved
// `produceTeaser` flag AND that visuals ran (a teaser is a visual deliverable —
// pointless on a text-only run).
export function wantsTeaser(options = {}) {
  return options.produceTeaser === true && wantsVisual(options);
}

// Unlock-everything-first (see ./unlockPass.js). When on, the run's FIRST step
// clears every lock this series owns — the arc freeze + per-field arc locks,
// each volume's lock, every issue stage lock, and the universe-side records
// this series owns — so the autopilot can actually apply the fixes the
// editorial passes surface instead of pausing on findings it isn't allowed to
// resolve.
//
// PER-RUN ONLY, deliberately — the one autopilot option with NO persisted
// default (mirrors `readinessGate`, and unlike every other gate here). The rest
// of this file's options are spend/quality knobs where a saved default is
// harmless; this one rewrites protection state the user set by hand. A saved
// default would be read by `seriesAutopilotScheduler`, so ticking the box once
// in one series' panel would silently arm lock-clearing for every future
// unattended scheduled run of EVERY series. Stamped onto run options at start
// so the resolver, the dry-run plan and a resume all read the same flag.
export function resolveAutopilotUnlockForRun(options = {}) {
  return options?.unlockForRun === true;
}

// Iterate-to-quality revision loop (CWQE Phase 7, #2171). Opt-in per run; when
// enabled the autopilot cycles the weakest issue through adversarial cuts +
// judge-gated keep/revert instead of stopping at the editorial-health gate.
// Defaults OFF — it is a fresh burst of judge + cut LLM spend the user must
// opt into. minCycles floors the plateau/hedge stops so the loop always runs at
// least once; maxCycles is the cost ceiling; plateauDelta is the mean-score
// movement below which the series counts as converged. Per-run option wins, then
// the persisted pipelineEditorialChecks.revision* setting, then the default.
export const DEFAULT_REVISION_ENABLED = false;
export const DEFAULT_REVISION_MIN_CYCLES = 1;
export const DEFAULT_REVISION_MAX_CYCLES = 2;
export const DEFAULT_REVISION_PLATEAU_DELTA = 0.3;
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

// Pipeline self-improvement — let a run diagnose the AUTOMATION, not just the
// story. When a run ends badly (paused / errored) or finishes carrying unhealthy
// telemetry (an editorial check that threw, a delegated child that had to be
// retried, a convergence loop that never converged), the orchestrator can run
// ONE meta-diagnosis pass over the run's own signal log and, when the verdict is
// that PortOS itself is at fault (a missing editorial step earlier in the
// pipeline, a prompt that keeps producing unusable output, a runner that
// swallows a failure), file a CoS task against PortOS to fix it.
//
// Defaults OFF. It is a fresh burst of LLM spend AND it files work that changes
// PortOS's own code, so it must be an explicit opt-in — a run with clean
// telemetry never spends anything here even when enabled (see
// `shouldDiagnose`). Per-run option wins, then the persisted
// pipelineEditorialChecks setting, then the default.
//
// The filed task always awaits human approval and always opens a PR — see
// selfImprove.js's header for why that isn't a knob.
export const DEFAULT_SELF_IMPROVE = false;
export function resolveAutopilotSelfImprove(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.selfImprove, pec?.selfImprove, DEFAULT_SELF_IMPROVE);
}

// Observing orchestrator — the continuous, self-dispatching sibling of the
// self-improve post-mortem (see observer.js's header for the full contract).
// When on, the run watches its own telemetry as it progresses; a step whose
// fresh signals say the automation misbehaved spends a diagnosis call, and a
// confident pipeline verdict files an AUTO-APPROVED CoS task that PRs and
// merges without a human gate. Defaults OFF and must stay an explicit opt-in:
// it is both fresh LLM spend and standing consent for unattended changes to
// PortOS's own code. Per-run option wins, then the persisted
// pipelineEditorialChecks setting, then the default — persistable like
// selfImprove (a scheduled unattended run is exactly where the user wants the
// pipeline hardening itself), unlike unlockForRun (which rewrites user-set
// protection state and stays per-run only).
export const DEFAULT_OBSERVER = false;
export function resolveAutopilotObserver(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  return pickBool(options?.observer, pec?.observer, DEFAULT_OBSERVER);
}

// Which provider/model do this run's LLM calls use? An explicit per-run
// `providerOverride`/`modelOverride` wins (the Options picker, or the scheduler
// mapping a schedule's provider/model); otherwise the run inherits the series'
// own configured `series.llm` — the provider named in the series header, which
// every other Pipeline LLM action already honors. Both absent stays undefined,
// so stageRunner resolves stage pin → active provider as before. The precedence
// (including why a foreign model id is dropped) lives in the shared
// `resolveSeriesLlmOverride`; this only renames its keys to the run-option ones.
//
// Threaded as SOFT defaults (`providerDefault`/`modelDefault`, see
// session.js#providerOverrideOpts), so a deliberate per-stage pin on the Prompts
// page still wins and an unavailable provider falls through instead of throwing.
export function resolveAutopilotLlm(options = {}, series = null) {
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: options?.providerOverride,
    overrideModel: options?.modelOverride,
  });
  // Reasoning effort (#3641) is per-run only — there is no series-level effort to
  // inherit, so a blank choice stays undefined and each stage falls through to its
  // own `effort` pin, then the provider's configured args. Threaded on the same
  // soft channel as the provider/model (session.js#providerOverrideOpts →
  // stageRunner's `effortDefault`), which clamps it per provider.
  return { providerOverride: provider, modelOverride: model, effortOverride: options?.effortOverride || undefined };
}

// Effective "produce draft visuals?" decision. The `target` option overrides
// the `includeVisual` flag: 'text' forces text-only (no canon gate, no render),
// 'visual' forces visuals, and 'auto' (the default) honors `includeVisual`
// (which itself defaults true). Without this, a `target:'text'` request on a
// comic series would still run canonVerify + queue draft renders.
export function wantsVisual(options = {}) {
  if (options.target === 'text') return false;
  if (options.target === 'visual') return true;
  return options.includeVisual !== false;
}
