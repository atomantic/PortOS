/**
 * Series Autopilot — child-run drivers (#2842 split of seriesAutopilot.js):
 * the arc-verify, beat-continuity and foundation convergence gates plus the
 * generic `runChildToCompletion` harness the beats/text stages ride on.
 */

import { sleep } from '../../../lib/fileUtils.js';
import { recordDomainUsage } from '../../domainUsage.js';
import { getSeries } from '../series.js';
import { listIssues, getIssue, isStageReady } from '../issues.js';
import { verifyArc, resolveVerifyIssues, analyzeBeatContinuity, resolveBeatContinuity } from '../arcPlanner.js';
import { judgeFoundation, applyFoundationFix, weakestDimension, residualFindings, DEFAULT_FOUNDATION_THRESHOLD } from '../foundationJudge.js';
import * as volumeBeatsRunner from '../volumeBeatsRunner.js';
import * as autoRunner from '../autoRunner.js';
import { MAX_ARC_VERIFY_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS, MAX_FOUNDATION_ROUNDS, MAX_CHILD_RETRIES } from './config.js';
import {
  CHILD_POLL_MS, DIVERGENCE_PATIENCE, trackConvergence, convergencePauseReason,
  divergencePauseReason, foundationPauseReason, foundationDivergenceReason,
} from './convergence.js';
import { broadcast, budgetPause, providerOverrideOpts, providerIdOpts } from './session.js';
import { requiredScriptStages, textReady } from './stepResolver.js';

// ---------------------------------------------------------------------------
// Step dispatch.
// ---------------------------------------------------------------------------

async function waitForChild(isActive, record) {
  while (isActive()) {
    if (record.cancelRequested) return;
    await sleep(CHILD_POLL_MS);
  }
}

export async function runArcVerify(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxArcVerifyRounds)
    ? record.options.maxArcVerifyRounds
    : MAX_ARC_VERIFY_ROUNDS;
  // maxRounds === 0 means "skip verification entirely" — accept the arc as-is.
  if (maxRounds === 0) {
    record.runState.arcVerified = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeVerify = await budgetPause();
    if (beforeVerify) return beforeVerify;
    const { issues } = await verifyArc(seriesId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = issues.filter((i) => record.options.blockingSets.arc.has(i.severity));
    broadcast(seriesId, {
      type: 'verify:round', scope: 'arc', round, findings: issues.length, blocking: blocking.length,
    });
    if (blocking.length === 0) {
      record.runState.arcVerified = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('arc', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): if the resolve passes stop reducing blocking
    // findings, bail now rather than burning the remaining rounds + budget.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('arc', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    if (record.cancelRequested) return { canceled: true };
    // resolveVerifyIssues bills another action — recheck the budget so a single
    // step can't overspend the daily cap mid-loop.
    const beforeResolve = await budgetPause();
    if (beforeResolve) return beforeResolve;
    const resolved = await resolveVerifyIssues(seriesId, { findings: blocking, ...providerOverrideOpts(record) });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'resolve:round', scope: 'arc', round,
      episodesEdited: Array.isArray(resolved?.episodesResolved) ? resolved.episodesResolved.length : 0,
    });
  }
  return {};
}

// Whole-manuscript beat-continuity convergence loop (#1510). Mirrors
// runArcVerify one altitude down: verify the whole-book beat corpus, and on
// blocking findings resolve them by rewriting the offending issues' beats in
// place (resolveBeatContinuity → applyBeatResolutions, no beat-sheet
// regeneration), then re-verify. Bounded; pauses with the residual on
// non-convergence. Each verify + each resolve is budget-gated and bills one cos
// action, like the arc loop.
export async function runBeatContinuity(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxBeatContinuityRounds)
    ? record.options.maxBeatContinuityRounds
    : MAX_BEAT_CONTINUITY_ROUNDS;
  // maxRounds === 0 means "skip the beat-continuity gate entirely".
  if (maxRounds === 0) {
    record.runState.beatContinuityChecked = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeVerify = await budgetPause();
    if (beforeVerify) return beforeVerify;
    const { issues } = await analyzeBeatContinuity(seriesId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = issues.filter((i) => record.options.blockingSets.beatContinuity.has(i.severity));
    broadcast(seriesId, {
      type: 'verify:round', scope: 'beatContinuity', round, findings: issues.length, blocking: blocking.length,
    });
    if (blocking.length === 0) {
      record.runState.beatContinuityChecked = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('beatContinuity', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): bail when the resolve passes stop reducing blocking findings.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('beatContinuity', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    if (record.cancelRequested) return { canceled: true };
    // resolveBeatContinuity bills another action — recheck the budget so a
    // single step can't overspend the daily cap mid-loop.
    const beforeResolve = await budgetPause();
    if (beforeResolve) return beforeResolve;
    const resolved = await resolveBeatContinuity(seriesId, { findings: blocking, ...providerOverrideOpts(record) });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'resolve:round', scope: 'beatContinuity', round,
      episodesEdited: Array.isArray(resolved?.episodesResolved)
        ? resolved.episodesResolved.filter((e) => e?.corrected).length
        : 0,
    });
  }
  return {};
}

// Foundation-quality convergence loop (#2176). Mirrors runArcVerify but gates on
// a WEIGHTED SCORE (not a blocking-findings count): judge the whole foundation,
// and while it's below the threshold, target the weakest dimension, apply the
// fix through the owning service (universe refine / character expand / arc
// resolve — force:false, never a raw write), then re-judge. The re-judge is
// content-hash-cached, so an unchanged foundation short-circuits (no LLM) and
// can't loop. Bounded; pauses with the residual per-dimension findings on
// non-convergence. Each judge + each fix bills one cos action, budget-gated like
// the arc loop. The improve-loop convergence is tracked on the weighted score
// (higher = better), so divergence = the score failing to reach a NEW HIGH.
export async function runFoundationGate(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxFoundationRounds)
    ? record.options.maxFoundationRounds
    : MAX_FOUNDATION_ROUNDS;
  // 0 rounds (or disabled) means "skip the gate entirely" — accept the
  // foundation as-is. The resolver already routes past a disabled gate, but a
  // dispatch that arrives here with 0 rounds still short-circuits cleanly.
  if (maxRounds === 0 || record.options.foundationGate === false) {
    record.runState.foundationGated = true;
    return {};
  }
  const threshold = Number.isFinite(record.options.foundationThreshold)
    ? record.options.foundationThreshold
    : DEFAULT_FOUNDATION_THRESHOLD;
  const providerId = record.options.providerOverride;
  const model = record.options.modelOverride;

  // Convergence tracker keyed on the weighted score (higher is better) — invert
  // to a "distance below 10" so trackConvergence's fewer-is-better minimum logic
  // applies unchanged (a new low distance = a new high score = progress).
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeJudge = await budgetPause();
    if (beforeJudge) return beforeJudge;
    // Never force: judgeFoundation is content-hash-cached, so an unchanged
    // foundation (a clean verdict from a prior run, or a fix that changed
    // nothing) returns the cached score with no LLM call — this IS the fast-pass
    // that stops an already-clean foundation looping. A real change (any fix, or
    // a user edit) flips the pinned hash and re-judges automatically.
    const snap = await judgeFoundation(seriesId, { providerId, model });
    // A cached (content-hash unchanged) verdict did no LLM work — don't bill it.
    if (!snap.cached) await recordDomainUsage('cos', { actions: 1 });
    const score = snap.weightedScore ?? 0;
    const weak = weakestDimension(snap.dimensions);
    broadcast(seriesId, {
      type: 'foundation:round', round, weightedScore: score, threshold, weakest: weak?.dimension || null,
    });
    if (score >= threshold) {
      record.runState.foundationGated = true;
      return {};
    }
    if (round === maxRounds || !weak) {
      return {
        pause: true,
        pauseKind: 'maxRounds',
        reason: foundationPauseReason(maxRounds, score, threshold),
        residual: residualFindings(snap.dimensions),
      };
    }
    // Divergence guard (#1571): bail when fixes stop improving the score.
    convergence = trackConvergence(convergence, 10 - score);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return {
        pause: true,
        pauseKind: 'divergence',
        reason: foundationDivergenceReason(score, threshold, DIVERGENCE_PATIENCE),
        residual: residualFindings(snap.dimensions),
      };
    }
    if (record.cancelRequested) return { canceled: true };
    const beforeFix = await budgetPause();
    if (beforeFix) return beforeFix;
    const fix = await applyFoundationFix(seriesId, weak.dimension, {
      finding: snap.dimensions?.[weak.dimension] || {},
      providerOverride: providerId,
      modelOverride: model,
    });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'foundation:fix', round, dimension: weak.dimension, applied: fix?.applied === true, reason: fix?.reason || null,
    });
    // A dimension whose owning service can't apply a fix (no linked universe, a
    // fully-locked cast, nothing left to fill) would loop unproductively — treat
    // an inapplicable fix as immediate non-convergence and pause for human
    // review rather than burning the remaining rounds re-judging an unchanged
    // foundation.
    if (fix?.applied !== true) {
      return {
        pause: true,
        pauseKind: 'inapplicable',
        reason: `Foundation gate can't auto-fix the weakest dimension (${weak.dimension}): ${fix?.reason || 'no change applied'}. Strengthen it manually, or lower the threshold, and resume.`,
        residual: residualFindings(snap.dimensions),
      };
    }
  }
  return {};
}

// Resolve the effective retry budget for a delegated child runner this run: a
// per-run `maxChildRetries` option wins, else the module default. Negative
// values clamp to 0 (single attempt).
function childRetryBudget(record) {
  const v = record.options.maxChildRetries;
  return Number.isInteger(v) ? Math.max(0, v) : MAX_CHILD_RETRIES;
}

// Delegate to a child SSE runner, block until it finishes, then VERIFY the child
// actually produced its target output before advancing (#1574). Shared by the
// beats and text steps. `checkReady` returns null when the output landed, or a
// `{ reason, residual }` describing what's still missing. On a miss the child is
// retried (skip-existing, so a retry only fills the gap) up to the run's retry
// budget; each attempt is budget-gated and bills one cos action. When the budget
// is exhausted the retries stop. If the output is still missing after the last
// attempt the work is marked attempted (so the resolver can't loop back here), an
// escalation frame is emitted, and a pause result is returned for human review —
// instead of the pre-#1574 silent skip that let a failed child reach 'done'.
async function runChildToCompletion(seriesId, record, {
  attemptedSet, kind, id, start, isActive, checkReady,
}) {
  const maxAttempts = childRetryBudget(record) + 1;
  let miss = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (record.cancelRequested) return { canceled: true };
    // Each child run bills one cos action — budget-gate every attempt so a
    // retry can't overspend the daily cap (mirrors the verify loops).
    const beforeStart = await budgetPause();
    if (beforeStart) return beforeStart;
    await start();
    record.activeChild = { kind, id };
    await waitForChild(() => isActive(id), record);
    record.activeChild = null;
    await recordDomainUsage('cos', { actions: 1 });
    if (record.cancelRequested) return { canceled: true };
    miss = checkReady ? await checkReady() : null;
    if (!miss) {
      attemptedSet.add(id);
      return {};
    }
    if (attempt < maxAttempts) {
      broadcast(seriesId, {
        type: 'child:retry', kind, id, attempt, maxAttempts, reason: miss.reason,
      });
    }
  }
  // Output still missing after every attempt — escalate and pause. `pauseKind`
  // keeps this pause classifiable alongside the verify/editorial loops'
  // 'maxRounds'/'divergence' kinds (a child runner that couldn't produce output,
  // distinct from a convergence gate that ran out of rounds).
  attemptedSet.add(id);
  broadcast(seriesId, {
    type: 'child:escalate', kind, id, attempts: maxAttempts, reason: miss.reason,
  });
  return { pause: true, pauseKind: 'childFailed', reason: miss.reason, residual: miss.residual };
}

export const runBeats = (seriesId, seasonId, record) => runChildToCompletion(seriesId, record, {
  attemptedSet: record.runState.beatsAttempted,
  kind: 'beats',
  id: seasonId,
  start: () => volumeBeatsRunner.startVolumeBeatsRun(seriesId, seasonId, { mode: 'skip-existing', ...providerIdOpts(record) }),
  isActive: volumeBeatsRunner.isVolumeBeatsRunActive,
  // Beats succeeded when every issue in the volume has a ready `idea` stage —
  // the same predicate the resolver uses to decide a volume still needs beats.
  // Before #1574 a failed beats run was silently marked attempted and only
  // surfaced (if at all) when a downstream stage found `idea` empty.
  checkReady: async () => {
    const inSeason = (await listIssues({ seriesId })).filter((i) => i.seasonId === seasonId);
    const missing = inSeason.filter((i) => !isStageReady(i.stages?.idea));
    if (missing.length === 0) return null;
    return {
      reason: `beat generation for volume ${seasonId} did not produce beats for ${missing.length} issue(s)`,
      residual: missing.map((i) => ({ severity: 'high', location: `issue ${i.number ?? '?'} / idea`, problem: 'beat sheet (idea stage) is still empty after the beats run (likely an LLM failure)' })),
    };
  },
});

export const runText = (seriesId, issueId, record) => runChildToCompletion(seriesId, record, {
  attemptedSet: record.runState.textAttempted,
  kind: 'text',
  id: issueId,
  start: async () => {
    // Only adapt the target format's script(s) — a single-format series shouldn't
    // spend LLM calls populating the off-target script across every issue.
    const preIssue = await getIssue(issueId);
    const preSeries = await getSeries(preIssue.seriesId).catch(() => null);
    const scripts = requiredScriptStages(preSeries, record.options);
    // Forward the run's provider/model override so prose + scripts honor it like
    // every other step (autoRunner threads these into generateStage).
    await autoRunner.startAutoRunTextStages(issueId, { force: false, scripts, ...providerIdOpts(record) });
  },
  isActive: autoRunner.isAutoRunActive,
  // A delegated text run can end with required stages still empty (the child's
  // LLM call failed) — verify the required stages landed before advancing.
  checkReady: async () => {
    const issue = await getIssue(issueId);
    const series = await getSeries(issue.seriesId).catch(() => null);
    if (textReady(issue, series, record.options)) return null;
    const missing = requiredScriptStages(series, record.options).filter((s) => !isStageReady(issue.stages?.[s]));
    return {
      reason: `text generation for issue ${issue.number ?? issueId} did not produce required stage(s): ${missing.join(', ')}`,
      residual: missing.map((s) => ({ severity: 'high', location: `issue ${issue.number ?? '?'} / ${s}`, problem: 'stage is still empty after the text run (likely an LLM failure)' })),
    };
  },
});
