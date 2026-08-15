/**
 * Series Autopilot — child-run drivers (#2842 split of seriesAutopilot.js):
 * the arc-verify, beat-continuity and foundation convergence gates plus the
 * generic `runChildToCompletion` harness the beats/text stages ride on.
 */

import { sleep } from '../../../lib/fileUtils.js';
import { isRunCanceledError } from '../../../lib/aiToolkit/errorDetection.js';
import { recordDomainUsage } from '../../domainUsage.js';
import { getSeries, AUTOPILOT_DISCARDED_MAX } from '../series.js';
import { listIssues, getIssue, isStageReady } from '../issues.js';
import {
  verifyArc, verifyVolume, resolveVerifyIssues, analyzeBeatContinuity, resolveBeatContinuity,
  snapshotArcState, restoreArcState, resolvedEpisodeEdits,
} from '../arcPlanner.js';
import {
  judgeFoundation, applyFoundationFix, establishCharacterFoundation, foundationGateStatus, foundationFixTarget,
  residualFindings, snapshotFoundationState, restoreFoundationState, readFoundationCharacterBlanks,
  DEFAULT_FOUNDATION_THRESHOLD,
} from '../foundationJudge.js';
import * as volumeBeatsRunner from '../volumeBeatsRunner.js';
import * as autoRunner from '../autoRunner.js';
import {
  MAX_ARC_VERIFY_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS, MAX_FOUNDATION_ROUNDS, MAX_CHILD_RETRIES,
  MAX_ARC_RESOLVE_RETRIES, resolveArcIsolationAttempts,
} from './config.js';
import {
  CHILD_POLL_MS, DIVERGENCE_PATIENCE, trackConvergence, convergencePauseReason,
  divergencePauseReason, foundationPauseReason, foundationDivergenceReason,
  foundationRepairMissed, regressionPauseReason, sameFinding, containsFinding, isBlockingSetRegression,
  isTargetedPatchRegression,
  isIsolatedFixSafe,
} from './convergence.js';
import { createDiscardedBank } from './discardedEvidence.js';
import { createArcMutationLedger } from '../arcMutationLedger.js';
import { broadcast, budgetPause, providerOverrideOpts, providerIdOpts, roleLlm, seasonPreserveOpts } from './session.js';
import { recordModelOutcome } from './modelPerformance.js';
import { requiredScriptStages, textReady } from './stepResolver.js';

const MAX_PLANNING_GATE_HANDOFFS = 6;

// A rewound round's own findings, reported alongside the (better) set that was
// restored. The rollback guards compare blocking COUNTS and are deliberately
// blind to finding identity, so they can fire on a round that genuinely closed
// what it was handed and merely exposed latent defects — without both sets the
// user sees only a number and cannot tell those cases apart. Bounded here, not
// just in the marker sanitizer, so the live SSE frame carries the same set the
// record keeps rather than every finding a many-volume verify produced.
const discardedSet = (blocking) => blocking.slice(0, AUTOPILOT_DISCARDED_MAX);

// Everything a foundation round reads off one judge verdict. Hoisted because a
// rejected repair rewinds to its checkpoint and the round then re-reads the
// PRE-repair verdict — two spellings of this derivation is how they drift.
const readFoundationVerdict = (snap, threshold) => {
  const score = snap.weightedScore ?? 0;
  return {
    score,
    gate: foundationGateStatus(snap.dimensions, score, threshold),
    weak: foundationFixTarget(snap.dimensions, threshold),
  };
};

// Effective corrective-pass budget for the arc-verify gate this run: a per-run
// `maxArcResolveRetries` option wins, else the module default. Negative values
// clamp to 0 (revert and pause on the first regression). Mirrors
// `childRetryBudget` further down.
function arcResolveRetryBudget(record) {
  const v = record.options.maxArcResolveRetries;
  return Number.isInteger(v) ? Math.max(0, v) : MAX_ARC_RESOLVE_RETRIES;
}

// The gate's one way to bill a resolve pass: same options, same usage
// accounting, at all three call sites (the round's resolve, the corrective
// retry, and each isolated single-finding attempt). Open-coding it a third time
// is how `spineOnly` (#3789) came to need patching into every copy.
async function resolveArcFindings(seriesId, record, { findings, avoid, spineOnly, isolated = false }) {
  const resolved = await resolveVerifyIssues(seriesId, {
    findings,
    avoid,
    spineOnly,
    isolated,
    ...providerOverrideOpts(record),
    ...seasonPreserveOpts(record),
  });
  await recordDomainUsage('cos', { actions: 1 });
  return resolved;
}

// A resolver result carrying no counts (a test double, or a peer running an
// older build) reports zeros rather than a frame with holes in it.
const ZERO_MUTATIONS = Object.freeze({
  arcFieldsEdited: 0, volumesEdited: 0, characterArcsEdited: 0, episodesEdited: 0,
});

// What ONE resolver call did, as every telemetry frame reports it (#3843). Each
// attempt gets one — an applied round, a corrective retry, an isolated attempt,
// and a pass that wrote nothing — because the stall diagnosis counts resolver
// ATTEMPTS and used to be handed frames for only some of them. The per-record
// counts come from the resolver, the only layer holding both the pre- and
// post-commit state; `episodesEdited` among them is retained unchanged for
// existing consumers, but it was never a description of an arc-SPINE resolve.
const resolveOutcome = (resolved) => ({
  applied: resolved?.applied !== false,
  ...(resolved?.mutations || ZERO_MUTATIONS),
  rejectedExactEdits: resolved?.rejectedExactEdits || 0,
  noChangeReason: resolved?.noChangeReason || null,
});

// A resolver's provider run is only a TECHNICAL success until the next
// independent arc verification decides whether its candidate remains in the
// plan. Keep quality scores "higher is better" across every pipeline stage by
// representing an arc result as the negative blocker count: 3 → 2 blockers is
// a +1 quality delta, while 3 → 4 is -1. The raw before/after blocker counts
// remain available in the verify/rollback telemetry frames.
const arcResolveRunIds = (resolved) => (typeof resolved?.runId === 'string' && resolved.runId ? [resolved.runId] : []);
const arcQualityScore = (blocking) => (blocking.length === 0 ? 0 : -blocking.length);

async function recordArcResolveOutcome(candidate, record, { outcome, after, target }) {
  const runIds = Array.isArray(candidate?.runIds) ? candidate.runIds : [];
  if (runIds.length === 0) return;
  // A bounded exact patch is judged on the finding(s) it was authorized to
  // touch. An exhaustive follow-up may expose unrelated latent blockers, but
  // those are new work for the next round—not a negative quality delta owned by
  // this provider response. Legacy whole-field rewrites still own the full set.
  const ownedAfter = candidate?.exactTextMode
    ? candidate.blocking.filter((prior) => after.some((current) => sameFinding(prior, current)))
    : after;
  await Promise.all(runIds.map((runId) => recordModelOutcome(runId, {
    role: 'creative',
    stage: record.currentStep || 'verifyArc',
    outcome,
    target,
    scoreBefore: arcQualityScore(candidate.blocking),
    scoreAfter: arcQualityScore(ownedAfter),
  }).catch(() => {})));
  // The same checkpoint can remain `lastResolve` for comparison after its
  // verdict. Consume its evidence once so later seeded/re-confirmation rounds
  // cannot count one provider run twice.
  candidate.runIds = [];
}

function finishPlanningMutation(record, peerLatch) {
  record.runState[peerLatch] = false;
  record.runState.planningGateHandoffs = (record.runState.planningGateHandoffs || 0) + 1;
  return record.runState.planningGateHandoffs <= MAX_PLANNING_GATE_HANDOFFS;
}

// ---------------------------------------------------------------------------
// Step dispatch.
// ---------------------------------------------------------------------------

async function waitForChild(isActive, record) {
  while (isActive()) {
    if (record.cancelRequested) return;
    await sleep(CHILD_POLL_MS);
  }
}

/**
 * One full pass of the arc gate's verifier at the altitude the gate runs at: the
 * arc spine alone in `spineOnly` mode, else the arc plus every volume synopsis.
 * Returns `{ findings, blocking, volumesChecked }`, or `{ outcome }` carrying the
 * run-ending result (a cancel or a budget pause) it hit partway through.
 *
 * Extracted so the per-finding isolation pass re-verifies EXACTLY the way the
 * round loop does. A second hand-rolled verify would be free to drift to a
 * different altitude, and an isolated patch accepted on a verification this gate
 * never runs is a patch nothing actually judged.
 */
async function verifyArcBlocking(seriesId, record, { spineOnly }) {
  const beforeVerify = await budgetPause();
  if (beforeVerify) return { outcome: beforeVerify };
  const { issues: arcFindings } = await verifyArc(seriesId, {
    ...providerOverrideOpts(record, 'judge'),
    spineOnly,
  });
  await recordDomainUsage('cos', { actions: 1 });
  // The spine round judges an episode-empty plan and checks no volumes, so it
  // has no use for the series record — don't read it just to iterate nothing.
  const seasons = spineOnly ? [] : ((await getSeries(seriesId)).seasons || []);
  const volumeFindings = [];
  for (const season of seasons) {
    if (record.cancelRequested) return { outcome: { canceled: true } };
    const beforeVolumeVerify = await budgetPause();
    if (beforeVolumeVerify) return { outcome: beforeVolumeVerify };
    const { issues } = await verifyVolume(seriesId, season.id, {
      ...providerOverrideOpts(record, 'judge'),
      // This gate's resolver rewrites the synopsis-level arc/volumes, not
      // issue beats. Existing beat sheets get their own continuity gate later.
      synopsisOnly: true,
    });
    await recordDomainUsage('cos', { actions: 1 });
    for (const finding of issues) {
      volumeFindings.push({
        ...finding,
        volumeId: season.id,
        location: `volume ${season.number ?? '?'}${finding.location ? ` — ${finding.location}` : ''}`,
      });
    }
  }
  const findings = [...arcFindings, ...volumeFindings];
  return {
    findings,
    blocking: findings.filter((finding) => record.options.blockingSets.arc.has(finding.severity)),
    volumesChecked: seasons.length,
  };
}

/**
 * Resolve a residual one finding at a time, transactionally (#3780).
 *
 * The round loop rewrites the whole residual in one call and keeps or reverts
 * that candidate as a unit, so a rewrite that closed two findings cleanly and
 * broke a third leaves the gate holding nothing. This pass runs from the state
 * the caller has just restored (the best verified one) and, per finding:
 * snapshot → resolve THAT finding alone → re-verify the same way the gate does →
 * keep the patch only if `isIsolatedFixSafe`, else put the snapshot straight
 * back. So each accepted patch is one that demonstrably closed its own target
 * without growing or worsening the set, and a poisoned finding costs only its
 * own attempt instead of its neighbours' repairs.
 *
 * Each resolve runs in the resolver's `isolated` mode, because isolating the
 * FINDING was never enough to isolate the EDIT — see `isolatedCandidateRejection`
 * in arcPlanner/arcCore.js. A candidate it discards comes back unapplied, which
 * this loop reads as an attempt needing neither a rollback (nothing was written)
 * nor a verification round (the blocking set cannot have moved).
 *
 * `ledger` is the gate's shared mutation ledger: this pass holds its snapshot in
 * it and notes its own resolves, so a rejected attempt restores only the episode
 * synopses it actually wrote — and a RETAINED one is visible to a later rewind
 * in the round loop, which would otherwise have no record of it.
 *
 * Bounded by `attemptsLeft` and budget-gated per attempt like every other
 * resolve. Returns `{ accepted, attempts, verified }` — `verified` being the
 * full verification of the state now standing in the store, which the caller
 * hands to its next round instead of re-billing the identical call — plus
 * `outcome` when the run ended mid-pass.
 *
 * The pass banks its own rejections (#3829). `evidence` is the gate's
 * accumulator: read per target rather than once for the whole pass, so a patch
 * rejected on target 1 is evidence target 3 gets — and evidence the ordinary
 * resolve after a successful isolation gets too. Computing it once up front
 * made every attempt repeat the prompt the previous one had just failed with.
 */
async function isolateArcFindings(seriesId, record, { scope, round, spineOnly, baseline, bank, ledger, attemptsLeft }) {
  // The last verification that DESCRIBES THE STORE: it advances only on an
  // accepted patch, because a rejected one is rolled straight back to the state
  // its predecessor verified. So later targets are judged against what the
  // earlier ones left behind, and the caller can trust this as its next round's
  // verification. Null until the first patch is kept — the caller already holds
  // the baseline's verification in that case.
  let standing = null;
  let accepted = 0;
  let attempts = 0;
  // The store's state as of the last attempt that could have changed it, held
  // across attempts: a rejected candidate either never reached the store or was
  // restored to exactly this, so re-reading the series + every episode to
  // capture an identical snapshot is pure I/O. Dropped after an accepted patch,
  // which is the only thing that moves the store on.
  let snapshot = null;
  const blocking = () => standing?.blocking ?? baseline;
  for (const target of baseline) {
    if (attempts >= attemptsLeft) break;
    // An earlier accepted patch may have taken this one with it — paying a
    // resolve + a verify to re-close a finding that is already gone is pure spend.
    if (!containsFinding(blocking(), target)) continue;
    if (record.cancelRequested) return { accepted, attempts, verified: standing, outcome: { canceled: true } };
    const beforeResolve = await budgetPause();
    if (beforeResolve) return { accepted, attempts, verified: standing, outcome: beforeResolve };
    attempts += 1;
    const before = blocking().length;
    // The finding this attempt is spent on, as the telemetry names it: the
    // frame reports it verbatim (blank when the verifier gave no location), the
    // model-outcome record falls back to the gate's scope so a per-target
    // performance history is never keyed on an empty string.
    const targetLabel = typeof target.location === 'string' ? target.location : null;
    if (!snapshot) snapshot = ledger.hold(await snapshotArcState(seriesId));
    // Recomputed per target: earlier attempts in this same pass have banked
    // their rejections by now. Everything still standing is an active repair
    // target for this pass, so the whole set — not just `target` — is what the
    // avoid list is filtered against; the resolver is never told to both fix
    // and avoid the same finding.
    const avoid = bank.avoid([], blocking());
    const resolved = await resolveArcFindings(seriesId, record, {
      findings: [target], avoid, spineOnly, isolated: true,
    });
    ledger.note(resolvedEpisodeEdits(resolved));
    // The resolver applied nothing — for an isolated attempt that means the
    // candidate was too broad to BE one (see `isolatedCandidateRejection`) and
    // was discarded before it touched the store. Nothing was written, so there
    // is nothing to restore and — more to the point — nothing to verify:
    // billing a full verification round here would buy back the blocking set
    // this attempt already holds. Nothing to bank as discarded evidence either:
    // no rewrite was ever verified, so there are no authored problems to warn
    // the next attempt about.
    if (resolved?.applied === false) {
      await recordArcResolveOutcome(
        { blocking: blocking(), runIds: arcResolveRunIds(resolved) },
        record,
        { outcome: 'rejected', after: blocking(), target: targetLabel ?? scope },
      );
      broadcast(seriesId, {
        type: 'resolve:isolate', scope, round, attempt: attempts,
        target: targetLabel ?? '',
        before, after: before, kept: false,
        reason: resolved.reason || 'the resolver applied nothing',
        ...resolveOutcome(resolved),
      });
      continue;
    }
    const verified = await verifyArcBlocking(seriesId, record, { spineOnly });
    if (verified.outcome) {
      // The run is ending mid-attempt, so this patch can never be judged. Put
      // the snapshot back rather than leaving an unverified rewrite in a plan
      // the user is about to be handed.
      await restoreArcState(seriesId, snapshot, { episodeEdits: ledger.since(snapshot) });
      return { accepted, attempts, verified: standing, outcome: verified.outcome };
    }
    const kept = isIsolatedFixSafe(target, blocking(), verified.blocking);
    await recordArcResolveOutcome(
      { blocking: blocking(), runIds: arcResolveRunIds(resolved) },
      record,
      {
        outcome: kept ? 'accepted' : 'rejected',
        after: verified.blocking,
        target: targetLabel ?? scope,
      },
    );
    if (kept) {
      accepted += 1;
      standing = verified;
      // The store has moved past the held snapshot — the next attempt has to
      // capture the state this patch left behind, not the one before it.
      snapshot = null;
    } else {
      await restoreArcState(seriesId, snapshot, { episodeEdits: ledger.since(snapshot) });
      // The verified consequence of a rewrite the gate just threw away — the
      // same evidence a whole-set rollback banks, at single-finding grain.
      // Without this the pass paid a resolve + a verify to learn something no
      // later attempt (or the round that follows) ever hears about.
      bank.record(discardedSet(verified.blocking));
    }
    broadcast(seriesId, {
      type: 'resolve:isolate', scope, round, attempt: attempts,
      target: targetLabel ?? '',
      before, after: verified.blocking.length, kept,
      ...resolveOutcome(resolved),
    });
  }
  return { accepted, attempts, verified: standing };
}

/**
 * The arc-verify gate. Thin wrapper over the round loop so the accumulator has
 * exactly ONE exit to be stamped onto (#3829): every pause the loop can produce
 * — regression, maxRounds, divergence, manual, and the budget/provider ones it
 * merely forwards — owes the next run the whole gate's history, not just the set
 * the final rollback threw away. Stamping it at each `return` instead put the
 * invariant in six places and missed the forwarded ones.
 *
 * It rides its own `runDiscarded` rather than widening `discarded`, because the
 * panel labels that field "what the reverted round produced" and it stops being
 * true once it carries the run. A run that reverted two different rewrites used
 * to hand its resume only the second, so the resumed resolver could re-author
 * the first.
 */
export async function runArcVerify(seriesId, record, opts = {}) {
  // Every blocker set THIS gate has discarded, newest first (see
  // `createDiscardedBank`). A rollback's evidence used to reach only the
  // corrective retry that immediately followed it: the next ordinary resolve
  // rebuilt its avoid list from scratch, so once a retry landed on a non-worse
  // but still-blocked state the resolver was free to re-author the exact rewrite
  // the gate had just reverted — the observed 2 → 1 → 5 (revert) → 1 → 2
  // (revert, out of retries) stall. Seeded with whatever a prior pause carried,
  // so a gate resumed twice still stamps the WHOLE history rather than only what
  // this run threw away.
  const bank = createDiscardedBank(Array.isArray(record.options.priorArcAvoidFindings)
    ? record.options.priorArcAvoidFindings
    : []);
  const outcome = await runArcVerifyRounds(seriesId, record, { ...opts, bank });
  return outcome?.pause ? { ...outcome, runDiscarded: bank.all() } : outcome;
}

async function runArcVerifyRounds(seriesId, record, { spineOnly = false, bank }) {
  const maxRounds = Number.isInteger(record.options.maxArcVerifyRounds)
    ? record.options.maxArcVerifyRounds
    : MAX_ARC_VERIFY_ROUNDS;
  // maxRounds === 0 means "skip verification entirely" — accept the arc as-is.
  if (maxRounds === 0) {
    record.runState[spineOnly ? 'arcSpineVerified' : 'arcVerified'] = true;
    return {};
  }
  // One label for every frame this gate emits. The two gates now RESOLVE
  // differently, not just verify differently, so a resolve frame labelled `arc`
  // from a spine round misreports the failure to both the status line and the
  // stall-diagnosis prompt that replays these frames.
  const scope = spineOnly ? 'arcSpine' : 'arc';
  // Which episode synopses each rollback is allowed to put back: the ones the
  // resolver reported writing after that checkpoint was taken, and nothing else
  // (see `createArcMutationLedger`). Shared with the isolation pass below, whose
  // retained patches a later rewind to an older checkpoint also has to undo.
  const ledger = createArcMutationLedger();
  const takeSnapshot = async () => ledger.hold(await snapshotArcState(seriesId));
  const restoreTo = (snapshot) => restoreArcState(seriesId, snapshot, {
    episodeEdits: ledger.since(snapshot),
  });
  let convergence = { best: null, sinceBest: 0 };
  let changed = false;
  // Best verified checkpoint seen in this gate, paired with the exact arc /
  // volume / planning-synopsis state that produced it. Legacy whole-field
  // candidates are ordered by total blockers. A bounded exact patch that closes
  // its authorized targets may promote a larger newly exposed set instead—the
  // verifier's earlier smaller set was incomplete, not a better draft.
  let bestVerified = null;
  // The findings the previous round's auto-resolve was handed, plus the state of
  // the arc just before it ran — the two halves the regression guard below needs
  // to decide whether that round earned its edits.
  let lastResolve = null;
  // How many corrective passes the regression guard may still spend (#3781).
  // Reverting a bad candidate is not the same as being unable to try again: on a
  // regression the gate restores the best state and re-runs the resolver from
  // there with the rejected attempt's own findings attached as "do not author
  // these", and only pauses once that budget is gone. Without it the first bad
  // candidate ends the run, and resuming re-runs the identical prompt against
  // the identical state — so the gate could never clear itself unattended.
  let retriesLeft = arcResolveRetryBudget(record);
  // Single-finding attempts the isolation pass may still spend (#3780). Counted
  // across the whole gate, not per rollback, so a resolver that keeps trading
  // blockers can't turn every regression into another fan-out of provider calls.
  // Resolved on first use, when the round's own verification has said what a
  // verification costs on this series.
  let isolationLeft = null;
  // A verification already run against the state now in the store — the last one
  // the isolation pass billed. The next round is a re-confirmation of exactly
  // that state (nothing edits it in between), so re-running the gate's verifier
  // would buy the same answer for another 1 + volumes provider calls.
  let seededVerify = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const verified = seededVerify || await verifyArcBlocking(seriesId, record, { spineOnly });
    seededVerify = null;
    if (verified.outcome) return verified.outcome;
    const { findings, blocking } = verified;
    broadcast(seriesId, {
      type: 'verify:round', scope, round, findings: findings.length,
      blocking: blocking.length, volumesChecked: verified.volumesChecked,
    });
    if (blocking.length === 0) {
      await recordArcResolveOutcome(lastResolve, record, { outcome: 'accepted', after: blocking, target: scope });
      record.runState[spineOnly ? 'arcSpineVerified' : 'arcVerified'] = true;
      if (!spineOnly && changed && !finishPlanningMutation(record, 'foundationGated')) {
        return {
          pause: true,
          pauseKind: 'planningOscillation',
          reason: `Foundation and arc verification could not jointly converge after ${MAX_PLANNING_GATE_HANDOFFS} repair handoffs. Review the remaining synopsis-level plan before drafting beats.`,
          residual: [],
        };
      }
      return {};
    }
    // Legacy whole-field candidates keep the strict total-count ordering that
    // prevents runaway rewrites. Finding-keyed exact patches own only their
    // targets: a larger set of unrelated findings can be an exhaustive judge
    // exposing pre-existing work, so only a surviving/escalated target proves
    // that bounded patch regressed. Checked before maxRounds/divergence so a
    // demonstrated regression never becomes the live checkpoint.
    // Reverting is unconditional; PAUSING is not — see the corrective pass below.
    const regressed = lastResolve && (lastResolve.exactTextMode
      ? isTargetedPatchRegression(lastResolve.blocking, blocking)
      : isBlockingSetRegression(lastResolve.blocking, blocking));
    if (regressed) {
      await recordArcResolveOutcome(lastResolve, record, { outcome: 'rejected', after: blocking, target: scope });
      const rollbackTarget = bestVerified || lastResolve;
      const rollback = await restoreTo(rollbackTarget.snapshot);
      const discarded = discardedSet(blocking);
      bank.record(discarded);
      // Neither second chance is worth its LLM call without a round left to
      // VERIFY what it wrote: spending one on the final round would bill a
      // rewrite nothing ever checks, and would fall out of the loop past every
      // `return` below.
      const roundLeftToVerify = round < maxRounds;
      const canRetry = retriesLeft > 0 && roundLeftToVerify;
      if (isolationLeft === null) {
        isolationLeft = resolveArcIsolationAttempts(record.options, verified.volumesChecked);
      }
      // Escalation after the whole-set corrective passes are spent: split the
      // residual and try its findings one at a time (#3780). Only worth its spend
      // on a residual that can actually be taken apart — isolating a lone finding
      // re-issues the exact call the corrective pass just made.
      const canIsolate = isolationLeft > 0 && roundLeftToVerify && rollbackTarget.blocking.length > 1;
      broadcast(seriesId, {
        type: 'resolve:rollback', scope, round,
        before: lastResolve.blocking.length, after: blocking.length,
        best: rollbackTarget.blocking.length,
        reverted: rollback.restored,
        episodesReverted: rollback.episodesRestored,
        retrying: canRetry || canIsolate,
      });
      // Pause is graceful at the verifier transaction boundary: the candidate
      // has now been independently judged and the regressive edit restored, so
      // the store is safe to hand back. Do not spend a corrective or isolation
      // call after the user has asked this convergence loop to stop.
      if (record.pauseRequested) {
        return {
          pause: true,
          pauseKind: 'manual',
          reason: 'paused by user after the active arc judgment completed',
          residual: rollbackTarget.blocking,
          discarded,
        };
      }
      // Corrective pass (#3781): the revert above put the best verified state
      // back, so re-run the resolver against exactly the findings that state
      // has — this time carrying the rejected attempt's own findings as an
      // explicit "do not author these" list, which is the only new information
      // the gate has. Pausing here instead (the pre-#3781 behavior) hands the
      // user a run that a resume cannot advance: the same prompt over the same
      // state can regress the same way. Budget-gated and billed like any other
      // resolve, and bounded, so a resolver that keeps trading blockers still
      // reaches the pause below.
      if (canRetry) {
        retriesLeft -= 1;
        if (record.cancelRequested) return { canceled: true };
        const beforeRetry = await budgetPause();
        if (beforeRetry) return beforeRetry;
        const retried = await resolveArcFindings(seriesId, record, {
          findings: rollbackTarget.blocking,
          avoid: bank.avoid(discarded, rollbackTarget.blocking),
          spineOnly,
        });
        ledger.note(resolvedEpisodeEdits(retried));
        if (retried?.applied !== false) changed = true;
        // The restored state is what the retry has to beat, so the next round
        // compares against ITS count — not the rejected candidate's, which
        // would let the retry regress back to the discarded draft for free.
        lastResolve = {
          ...rollbackTarget,
          runIds: arcResolveRunIds(retried),
          exactTextMode: retried?.patchMode === 'exact-text-v1',
        };
        broadcast(seriesId, {
          type: 'resolve:round', scope, round, retry: true, ...resolveOutcome(retried),
        });
        continue;
      }
      // Per-finding isolation (#3780): the whole-set passes have now failed
      // twice on this residual, but "the set can't be rewritten safely" is not
      // "no finding in it can be fixed". Falls through to the pause below when
      // nothing was retained.
      if (canIsolate) {
        const isolated = await isolateArcFindings(seriesId, record, {
          scope, round, spineOnly,
          baseline: rollbackTarget.blocking,
          bank,
          ledger,
          attemptsLeft: isolationLeft,
        });
        isolationLeft -= isolated.attempts;
        if (isolated.outcome) return isolated.outcome;
        if (isolated.accepted > 0) {
          changed = true;
          // Every retained patch was verified on its own, and acceptance forbids
          // a bigger or more severe set — so the composite state is at least as
          // good as the checkpoint and becomes the new one. Its verification is
          // handed to the next round, which is where the gate is allowed to
          // clear: nothing advances on the per-finding checks alone.
          bestVerified = { blocking: isolated.verified.blocking, snapshot: await takeSnapshot() };
          lastResolve = bestVerified;
          seededVerify = isolated.verified;
          continue;
        }
      }
      return {
        pause: true,
        pauseKind: 'regression',
        reason: regressionPauseReason(
          'arc',
          lastResolve.blocking.length,
          blocking.length,
          rollbackTarget.blocking.length,
          blocking.length === lastResolve.blocking.length,
        ),
        residual: rollbackTarget.blocking,
        discarded,
      };
    }
    // The previous resolver candidate survived an independent verification and
    // remains the live checkpoint. It is quality-accepted even when the count
    // ties (the gate separately rejects a worse severity mix above).
    await recordArcResolveOutcome(lastResolve, record, { outcome: 'accepted', after: blocking, target: scope });
    // A judge result is the atomic boundary for an arc round. When Pause was
    // requested while that provider call was running, retain its verdict and
    // stop here instead of silently dispatching another resolver + judge pair.
    if (record.pauseRequested) {
      return {
        pause: true,
        pauseKind: 'manual',
        reason: 'paused by user after the active arc judgment completed',
        residual: blocking,
      };
    }
    // A bounded patch that closed everything it was authorized to touch is a
    // new checkpoint even when the verifier now reports MORE unrelated work.
    // Rewinding to an earlier low count would merely restore the less exhaustive
    // judge's snapshot and throw away a verified causal correction.
    const exactTargetsClosed = lastResolve?.exactTextMode === true
      && !lastResolve.blocking.some((prior) => blocking.some((current) => sameFinding(prior, current)));
    const isNewBest = exactTargetsClosed || !bestVerified || blocking.length <= bestVerified.blocking.length;
    // Shared exit for the two bounded stops below: rewind only when the current
    // round is genuinely worse than the accepted checkpoint. Exact target
    // closure above promotes its current state, so a newly exhaustive finding
    // set cannot make the cap/divergence exit undo that verified repair.
    const rewind = async () => {
      if (isNewBest || !bestVerified) return { residual: blocking, discarded: [] };
      await restoreTo(bestVerified.snapshot);
      const discarded = discardedSet(blocking);
      bank.record(discarded);
      return { residual: bestVerified.blocking, discarded };
    };
    if (round === maxRounds) {
      const { residual, discarded } = await rewind();
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('arc', maxRounds, residual.length), residual, discarded };
    }
    // Divergence guard (#1571): if the resolve passes stop reducing blocking
    // findings, bail now rather than burning the remaining rounds + budget.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      const { residual, discarded } = await rewind();
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('arc', residual.length, DIVERGENCE_PATIENCE), residual, discarded };
    }
    if (record.cancelRequested) return { canceled: true };
    // resolveVerifyIssues bills another action — recheck the budget so a single
    // step can't overspend the daily cap mid-loop.
    const beforeResolve = await budgetPause();
    if (beforeResolve) return beforeResolve;
    // Snapshot before the rewrite lands (two record reads, no LLM spend) so the
    // regression guard at the top of the next round can undo it. A lower or
    // equal blocker count promotes the latest verified draft to the checkpoint;
    // equal counts can reflect different, narrower findings after real repairs.
    const snapshot = await takeSnapshot();
    if (isNewBest) bestVerified = { blocking, snapshot };
    // Resolve at the altitude this gate verified at: the spine round judged an
    // episode-empty plan, so its resolver may only patch the arc + volumes
    // (#3789). The later full arc gate keeps episode corrections, which is the
    // only place they can actually close a finding.
    const resolved = await resolveArcFindings(seriesId, record, {
      findings: blocking,
      avoid: bank.avoid([], blocking),
      spineOnly,
    });
    ledger.note(resolvedEpisodeEdits(resolved));
    if (resolved?.applied === false) {
      await recordArcResolveOutcome(
        { blocking, runIds: arcResolveRunIds(resolved) },
        record,
        { outcome: 'rejected', after: blocking, target: scope },
      );
      seededVerify = verified;
      broadcast(seriesId, {
        type: 'resolve:no-change', scope, round, ...resolveOutcome(resolved),
      });
      continue;
    }
    changed = true;
    lastResolve = {
      blocking,
      snapshot,
      runIds: arcResolveRunIds(resolved),
      exactTextMode: resolved?.patchMode === 'exact-text-v1',
    };
    broadcast(seriesId, {
      type: 'resolve:round', scope, round, ...resolveOutcome(resolved),
    });
  }
  return {};
}

// Whole-manuscript beat-continuity convergence loop (#1510). Mirrors
// runArcVerify's SHAPE one altitude down, not its guards: it has no checkpoint,
// no rollback of a regressive round (#3781) and no per-finding isolation
// (#3780), because none of those are reachable without a beat snapshot/restore
// pair — the arc gate's rest on `snapshotArcState`/`restoreArcState`, and beats
// have no equivalent. That, not oversight, is the asymmetry: verify the
// whole-book beat corpus, and on
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
    const { issues } = await analyzeBeatContinuity(seriesId, providerOverrideOpts(record, 'judge'));
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
    // No per-record counts here, and none missing: this resolver rewrites
    // episode beats and nothing else, so `episodesEdited` IS the whole account
    // of what it wrote — unlike the arc gate, whose resolver spans the arc,
    // volumes, character arcs and episodes (#3843).
    broadcast(seriesId, {
      type: 'resolve:round', scope: 'beatContinuity', round,
      episodesEdited: Array.isArray(resolved?.episodesResolved)
        ? resolved.episodesResolved.filter((e) => e?.corrected).length
        : 0,
    });
  }
  return {};
}

// Character-first preflight. This runs only when a macro arc still needs to be
// generated; the later whole-foundation gate remains the post-arc reconciliation
// pass after the full synopsis plan exists.
export async function runCharacterFoundation(seriesId, record) {
  // Latch before the call so a no-op/skip cannot route back into the same stage
  // forever. A failed call pauses the run; resume starts a fresh record/latch.
  record.runState.characterFoundationEstablished = true;
  const before = await budgetPause();
  if (before) return before;
  let result;
  try {
    result = await establishCharacterFoundation(seriesId, providerOverrideOpts(record));
  } catch (err) {
    const detail = (err?.message || String(err)).slice(0, 300);
    console.error(`❌ pre-arc character foundation failed — series=${seriesId.slice(0, 12)}: ${detail}`);
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'foundation:fix', phase: 'pre-arc', dimension: 'character', applied: false, reason: detail,
    });
    // A Stop (this run's Cancel, a /runs Stop, a host shutdown) killed the call
    // mid-flight. The spend above is real, but the run ended by request — hand
    // the loop a cancellation so it reaches the `canceled` terminal instead of
    // pausing with a "fix the provider" banner nobody asked for.
    if (isRunCanceledError(err)) return { canceled: true };
    return {
      pause: true,
      pauseKind: 'providerFailed',
      reason: `The pre-arc character foundation could not complete: ${detail}. Resume after fixing the provider; no plot arc was generated from an unfinished cast.`,
      residual: [],
    };
  }
  if (result?.ran) await recordDomainUsage('cos', { actions: 1 });
  broadcast(seriesId, {
    type: 'foundation:fix', phase: 'pre-arc', dimension: 'character',
    applied: result?.applied === true, reason: result?.reason || null,
    charactersAdded: result?.charactersAdded || 0,
  });
  if (result?.ran && result?.applied !== true) {
    return {
      pause: true,
      pauseKind: 'inapplicable',
      reason: `The pre-arc character pass returned no usable foundation: ${result?.reason || 'no character changes were applied'}. The run stopped before spending on a plot arc.`,
      residual: [],
    };
  }
  return {};
}

// Foundation-quality convergence loop (#2176). Mirrors runArcVerify but gates on
// a WEIGHTED SCORE (not a blocking-findings count): judge the whole foundation,
// and while it's below the threshold, target the largest weighted deficit, apply the
// fix through the owning service (universe refine / character expand / arc
// resolve — force:false, never a raw write), then re-judge. The re-judge is
// content-hash-cached, so an unchanged foundation short-circuits (no LLM) and
// can't loop. Bounded; pauses with the residual per-dimension findings on
// non-convergence. Each judge + each fix bills one cos action, budget-gated like
// the arc loop. Convergence is tracked PER TARGET DIMENSION: foundation work can
// legitimately expose a different weak layer (a new antagonist can reveal a
// structure gap; a repaired structure can expose missing craft). Comparing all
// of those owned repairs to one global weighted-score high-water mark made a
// newly surfaced dimension look like divergence before its editor ran once.
//
// A repair whose independent re-judge does NOT show its target improving is
// rewound to the checkpoint taken before it — and then RETRIED, not treated as
// terminal: one rejected generative proposal says nothing about whether the
// dimension is repairable, and stopping on it stranded runs after a single fix
// out of a configured 12 rounds. Each retry starts from the verified checkpoint,
// counts against maxFoundationRounds and the per-dimension stall patience, and
// carries a note describing what was reverted so it can change strategy.
export async function runFoundationGate(seriesId, record) {
  // Same one-exit stamping as `runArcVerify` (#3829), for the same reason: every
  // pause the loop can produce owes the next run the whole gate's evidence, and
  // spelling that at each `return` is how the forwarded ones get missed. Keyed
  // by dimension — a rejected character repair says nothing about a structure
  // attempt — and seeded with what a prior pause carried.
  const bank = createDiscardedBank(record.options.priorFoundationAvoidFindings);
  const outcome = await runFoundationRounds(seriesId, record, { bank });
  return outcome?.pause ? { ...outcome, foundationDiscarded: bank.byKey() } : outcome;
}

async function runFoundationRounds(seriesId, record, { bank }) {
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
  const judgeLlm = roleLlm(record, 'judge');
  const creativeLlm = roleLlm(record, 'creative');

  // Each owning editor gets its own convergence history. Invert the target's
  // raw score to a distance below 10 so trackConvergence's fewer-is-better
  // minimum logic applies unchanged. A target seen for the first time always
  // receives at least one repair attempt; repeated no-improvement in that same
  // dimension still trips the bounded divergence guard.
  const convergenceByDimension = new Map();
  // A repair remains provisional until the next independent judge proves that
  // it helped the dimension it was asked to fix. This is narrower than a global
  // score high-water mark: a genuinely improved target may expose another weak
  // layer, but an unchanged target cannot keep edits by moving the problem.
  let pendingRepair = null;
  // What the last REJECTED (and reverted) attempt for a dimension looked like:
  // the strategy note describing what was just reverted, the set that attempt
  // discarded (what the pause renders), plus the rewind notice to report if that
  // dimension ends up exhausting its patience. Deliberately last-only — the note
  // and the rewind notice describe ONE reverted attempt and go stale the moment
  // the dimension keeps a repair. The accumulating evidence a retry must avoid
  // authoring lives in `bank` instead, which is not cleared by an accepted
  // repair: a candidate this gate already rejected is still a candidate it
  // rejected, and the arc gate keeps its history for the same reason (#3835).
  const rejectionByDimension = new Map();
  // A terminal pause for `dimension`, folding in its last rewind when it had
  // one: the state being handed back is that checkpoint, and saying so is the
  // difference between a trustworthy pause and an unexplained rewind.
  // `rejectedKind` overrides the stop kind when the stop cause IS the rewinding.
  const foundationPause = (dimension, pauseKind, reason, judged, rejectedKind) => {
    const rejected = rejectionByDimension.get(dimension);
    return {
      pause: true,
      pauseKind: rejected && rejectedKind ? rejectedKind : pauseKind,
      reason: rejected ? `${reason} ${rejected.rewind}` : reason,
      residual: residualFindings(judged.dimensions),
      ...(rejected ? { discarded: rejected.discarded } : {}),
    };
  };
  let changed = false;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeJudge = await budgetPause();
    if (beforeJudge) return beforeJudge;
    // Never force: judgeFoundation is content-hash-cached, so an unchanged
    // foundation (a clean verdict from a prior run, or a fix that changed
    // nothing) returns the cached score with no LLM call — this IS the fast-pass
    // that stops an already-clean foundation looping. A real change (any fix, or
    // a user edit) flips the pinned hash and re-judges automatically.
    let judgeRunId = null;
    const judgeHooks = providerOverrideOpts(record, 'judge');
    // `let` because a rejected repair rewinds the foundation to its checkpoint:
    // the restored content is exactly what the PRE-repair judge scored, so the
    // rest of the round re-reads that verdict rather than re-judging (see the
    // rollback branch below). Looping back to this call instead would also
    // re-derive it — the hash cache absorbs the LLM cost — but it would spend a
    // whole round of the run's repair budget re-learning what the gate is
    // already holding, which is the budget the retry exists to use.
    let snap = await judgeFoundation(seriesId, {
      providerDefault: judgeLlm.providerOverride,
      modelDefault: judgeLlm.modelOverride,
      effortDefault: judgeLlm.effortOverride,
      onRunCreated: (runId) => {
        judgeRunId = runId;
        judgeHooks.onRunCreated(runId);
      },
      onRunSettled: judgeHooks.onRunSettled,
    });
    // A cached (content-hash unchanged) verdict did no LLM work — don't bill it.
    if (!snap.cached) await recordDomainUsage('cos', { actions: 1 });
    let { score, gate, weak } = readFoundationVerdict(snap, threshold);
    if (!snap.cached && judgeRunId) {
      await recordModelOutcome(judgeRunId, {
        role: 'judge', stage: 'foundationGate', outcome: 'valid',
        target: weak?.dimension || 'foundation', scoreAfter: score,
      }).catch(() => {});
    }
    broadcast(seriesId, {
      type: 'foundation:round', round, weightedScore: score, threshold,
      dimensionFloor: gate.dimensionFloor, failingDimensions: gate.failingDimensions,
      weakest: weak?.dimension || null,
    });
    if (pendingRepair) {
      const dimension = pendingRepair.dimension;
      const beforeDimension = pendingRepair.judge.dimensions?.[dimension] || {};
      const afterDimension = snap.dimensions?.[dimension] || {};
      const beforeTargetScore = Number(beforeDimension.score) || 0;
      const afterTargetScore = Number(afterDimension.score) || 0;
      const beforeWeighted = Number(pendingRepair.judge.weightedScore) || 0;
      const targetImproved = afterTargetScore > beforeTargetScore;
      const targetTied = afterTargetScore === beforeTargetScore;
      const gapChanged = !sameFinding(
        { location: dimension, problem: beforeDimension.gap || '' },
        { location: dimension, problem: afterDimension.gap || '' },
      );
      // A character repair's work is objectively measurable without asking an
      // LLM: count the blank framework/visual fields across the repairable cast
      // before and after. A judge that renders or reads the cast wrongly can
      // report a tied score over a foundation it can no longer see — that cost
      // a complete five-sheet character design pass on 2026-08-11, discarded
      // because the judge prompt showed each authored field as the bare word
      // `ready`. Filled fields are a fact on disk, so they outrank a tie.
      const blanksAfter = pendingRepair.characterBlanksBefore === null
        ? null
        : await readFoundationCharacterBlanks(seriesId).catch(() => null);
      const objectivelyFilled = blanksAfter !== null && blanksAfter < pendingRepair.characterBlanksBefore;
      // A tie can represent a deeper newly exposed layer, but only when the
      // aggregate did not regress. A strictly improved target is accepted even
      // if it makes another latent dimension judgeable.
      const earned = targetImproved
        || (targetTied && objectivelyFilled)
        || (targetTied && gapChanged && score >= beforeWeighted);
      await Promise.all((pendingRepair.runIds || []).map((runId) => recordModelOutcome(runId, {
        role: 'creative', stage: 'foundationGate', outcome: earned ? 'accepted' : 'rejected', target: dimension,
        scoreBefore: beforeTargetScore, scoreAfter: afterTargetScore,
        weightedBefore: beforeWeighted, weightedAfter: score,
      }).catch(() => {})));
      const rejectedJudge = pendingRepair.judge;
      const rejectedSnapshot = pendingRepair.snapshot;
      pendingRepair = null;
      if (!earned) {
        const copy = foundationRepairMissed({
          dimension,
          targetBefore: beforeTargetScore, targetAfter: afterTargetScore,
          weightedBefore: beforeWeighted, weightedAfter: score,
        });
        // Hand back the verdict that scored this checkpoint: the rewind puts its
        // content back, and re-pinning its judgment keeps a resume (or the next
        // read) from re-buying a score the gate is holding.
        const rollback = await restoreFoundationState(seriesId, rejectedSnapshot, { judge: rejectedJudge });
        const discarded = discardedSet(residualFindings(snap.dimensions));
        // Bank it the moment it is thrown away, not when the next repair reads
        // it — an unverified restore returns below without ever reaching a
        // retry, and its evidence still belongs to the resume.
        bank.record(discarded, dimension);
        broadcast(seriesId, {
          type: 'foundation:rollback', round, dimension,
          targetBefore: beforeTargetScore, targetAfter: afterTargetScore,
          weightedBefore: beforeWeighted, weightedAfter: score,
          // A verified rewind is also a retryable one; an unverified one stops
          // the gate below, so this single flag says both.
          reverted: rollback.restored,
        });
        // An unverified restore is the one unrecoverable case: the foundation is
        // no longer known to match ANY judged state, so another repair would be
        // built on corruption. Everything else keeps going.
        if (!rollback.restored) {
          return {
            pause: true,
            pauseKind: 'regression',
            reason: copy.unverified(rollback.reason),
            residual: residualFindings(rejectedJudge.dimensions),
            discarded,
          };
        }
        // The checkpoint is verified back in place, so the foundation is once
        // again exactly what `rejectedJudge` scored: adopt that verdict for the
        // rest of this round (no second judge call, nothing billed) and let the
        // stall guard below count the rejection before another attempt runs.
        rejectionByDimension.set(dimension, {
          discarded,
          rewind: copy.rewind,
          note: copy.retryNote(afterDimension.gap),
        });
        snap = rejectedJudge;
        ({ score, gate, weak } = readFoundationVerdict(snap, threshold));
        console.log(`↩️ foundation ${dimension} repair reverted — series=${seriesId.slice(0, 12)} round=${round}: ${copy.missed}`);
      } else {
        // A kept repair clears the dimension's last-rejection NOTE: the next
        // attempt is working from different content, so a stale "this failed,
        // try another angle" strategy line would misdirect it. The banked
        // evidence survives — those candidates were still rejected.
        rejectionByDimension.delete(dimension);
      }
    }
    if (gate.passes) {
      record.runState.foundationGated = true;
      if (changed && !finishPlanningMutation(record, 'arcVerified')) {
        return {
          pause: true,
          pauseKind: 'planningOscillation',
          reason: `Foundation and arc verification could not jointly converge after ${MAX_PLANNING_GATE_HANDOFFS} repair handoffs. Review the remaining synopsis-level plan before drafting beats.`,
          residual: residualFindings(snap.dimensions),
        };
      }
      return {};
    }
    // A graceful pause requested while the judge was working lands only after
    // any pending repair has been accepted or rolled back above. That preserves
    // the foundation transaction boundary while preventing another repair call.
    if (record.pauseRequested) {
      return {
        pause: true,
        pauseKind: 'manual',
        reason: 'paused by user after the active foundation judgment completed',
        residual: residualFindings(snap.dimensions),
      };
    }
    if (round === maxRounds || !weak) {
      const floorReason = gate.failingDimensions.length > 0
        ? `Foundation quality left ${gate.failingDimensions.join(', ')} below the ${gate.dimensionFloor} dimension floor after ${maxRounds} round(s). Strengthen those foundations and resume.`
        : foundationPauseReason(maxRounds, score, threshold);
      // The round bound is the stop cause even when the last attempt rewound —
      // that attempt still says what state the user is holding, so it rides the
      // reason rather than relabeling why the loop ended.
      return foundationPause(weak?.dimension, 'maxRounds', floorReason, snap);
    }
    // Divergence guard (#1571): bail only when repeated repairs fail to improve
    // THEIR OWN target. A global weighted high-water mark is not comparable
    // across different targets: improving character can make a previously
    // latent structure or craft gap judgeable and lower the aggregate score.
    const priorConvergence = convergenceByDimension.get(weak.dimension)
      || { best: null, sinceBest: 0, finding: null };
    const currentFinding = {
      location: weak.dimension,
      problem: snap.dimensions?.[weak.dimension]?.gap || '',
    };
    let targetConvergence = trackConvergence(priorConvergence, 10 - weak.score);
    // A harsh critic can hold a dimension at the same score after the repair
    // closed its broad gap, then expose a genuinely different layer beneath it.
    // That is progress even though the coarse 0–10 number tied. Give the new
    // gap its own patience window; fuzzy-match paraphrases of the SAME gap so a
    // judge cannot evade the bounded stall guard merely by rewording itself.
    const changedGap = priorConvergence.finding?.problem
      && currentFinding.problem
      && !sameFinding(priorConvergence.finding, currentFinding);
    if (targetConvergence.sinceBest > 0 && changedGap) {
      targetConvergence = { best: targetConvergence.best, sinceBest: 0 };
    }
    targetConvergence.finding = currentFinding;
    convergenceByDimension.set(weak.dimension, targetConvergence);
    if (targetConvergence.sinceBest >= DIVERGENCE_PATIENCE) {
      const floorReason = gate.failingDimensions.length > 0
        ? `Foundation quality stopped improving with ${gate.failingDimensions.join(', ')} below the ${gate.dimensionFloor} dimension floor. Review those foundations and resume.`
        : foundationDivergenceReason(score, threshold, DIVERGENCE_PATIENCE);
      // A stall whose attempts were all REVERTED is reported as a regression:
      // the pre-#3818 gate raised that kind on the very first rewind, and the
      // state the user is handed — the pre-repair checkpoint — is the same one.
      return foundationPause(weak.dimension, 'divergence', floorReason, snap, 'regression');
    }
    if (record.cancelRequested) return { canceled: true };
    const beforeFix = await budgetPause();
    if (beforeFix) return beforeFix;
    // Deliberate catch (the one in this module): the repair is an LLM call, and
    // an LLM call fails for reasons that have nothing to do with the foundation
    // — a provider timeout, a dead CLI binary, a rate limit. Uncaught, it left
    // the orchestrator's catch to mark the WHOLE run `error` and stop, throwing
    // away every step the run had already completed, even though the failure is
    // transient and the next attempt would very likely succeed. Every other
    // dead end in this gate (locked arc, fully-locked cast, non-convergence)
    // pauses instead — a resumable state that keeps the run's position and
    // names what went wrong. A provider failure is the MOST transient of them,
    // so it gets the same treatment rather than the harshest one. The
    // promptRunner has already walked its full fallback cascade by the time
    // this throws, so there is no retry left to attempt here.
    const repairSnapshot = await snapshotFoundationState(seriesId);
    // Measured off the checkpoint's own cast so the before/after pair differs
    // only in character content — null for every other dimension, which is what
    // switches the objective check off.
    const characterBlanksBefore = weak.dimension === 'character'
      ? await readFoundationCharacterBlanks(seriesId, repairSnapshot?.universe?.characters).catch(() => null)
      : null;
    let fix;
    const repairRunIds = [];
    const creativeHooks = providerOverrideOpts(record);
    const repairJudgeHooks = providerOverrideOpts(record, 'judge');
    // A retry after a reverted attempt gets the ORIGINAL judge gap/fix (the
    // foundation is back at that checkpoint) plus what the rejected re-judge
    // said, so it can change strategy instead of re-proposing the same edits.
    const priorRejection = rejectionByDimension.get(weak.dimension);
    const repairFinding = {
      ...(snap.dimensions?.[weak.dimension] || {}),
      ...(priorRejection ? { retryReason: priorRejection.note } : {}),
    };
    // EVERY candidate this dimension has discarded, not just the last one — a
    // dimension that rejected two different repairs used to hand the third
    // evidence of only the second, leaving the repairer free to re-author the
    // first.
    //
    // A rejected attempt banks the whole judged consequence it produced, not
    // just its own dimension's gap — damage it did elsewhere is frequently WHY
    // it was rejected. So the filter is the whole restored state's residual, not
    // just the target's: every gap standing in the checkpoint is something the
    // gate still intends to close, and telling an editor both "this is the
    // state's problem" and "never author this" is contradictory. What survives
    // is what the rejected candidates INTRODUCED.
    const avoidFindings = bank.avoid([], residualFindings(snap.dimensions), weak.dimension);
    try {
      fix = await applyFoundationFix(seriesId, weak.dimension, {
        finding: repairFinding,
        avoidFindings,
        providerOverride: creativeLlm.providerOverride,
        modelOverride: creativeLlm.modelOverride,
        judgeProviderDefault: judgeLlm.providerOverride,
        judgeModelDefault: judgeLlm.modelOverride,
        judgeEffortDefault: judgeLlm.effortOverride,
        judgeOnRunCreated: repairJudgeHooks.onRunCreated,
        judgeOnRunSettled: repairJudgeHooks.onRunSettled,
        ...seasonPreserveOpts(record),
        effortOverride: creativeLlm.effortOverride,
        onRunCreated: (runId) => {
          repairRunIds.push(runId);
          creativeHooks.onRunCreated(runId);
        },
        onRunSettled: creativeHooks.onRunSettled,
      });
    } catch (err) {
      const detail = (err?.message || String(err)).slice(0, 300);
      console.error(`❌ foundation repair failed (${weak.dimension}) — series=${seriesId.slice(0, 12)}: ${detail}`);
      await recordDomainUsage('cos', { actions: 1 });
      broadcast(seriesId, {
        type: 'foundation:fix', round, dimension: weak.dimension, applied: false, reason: detail,
      });
      // Same rule as the pre-arc pass: an intentional stop is not a provider
      // failure, so end the run as canceled rather than pausing on a defect the
      // user never hit.
      if (isRunCanceledError(err)) return { canceled: true };
      return {
        pause: true,
        pauseKind: 'providerFailed',
        reason: `The foundation repair for ${weak.dimension} could not complete: ${detail}. The run kept everything it had finished — resume to retry, or switch the repair provider/model first.`,
        residual: residualFindings(snap.dimensions),
      };
    }
    await recordDomainUsage('cos', { actions: Math.max(1, fix?.actions || 1) });
    const explicitlyRejectedRunIds = new Set(Array.isArray(fix?.rejectedRunIds) ? fix.rejectedRunIds : []);
    await Promise.all([...explicitlyRejectedRunIds].map((runId) => recordModelOutcome(runId, {
      role: 'creative', stage: 'foundationGate', outcome: 'rejected', target: weak.dimension,
    }).catch(() => {})));
    const retainedRepairRunIds = (Array.isArray(fix?.acceptedRunIds) ? fix.acceptedRunIds : repairRunIds)
      .filter((runId) => !explicitlyRejectedRunIds.has(runId));
    broadcast(seriesId, {
      type: 'foundation:fix', round, dimension: weak.dimension, applied: fix?.applied === true, reason: fix?.reason || null,
    });
    // A dimension whose owning service can't apply a fix (no linked universe, a
    // fully-locked cast, nothing left to fill) would loop unproductively — treat
    // an inapplicable fix as immediate non-convergence and pause for human
    // review rather than burning the remaining rounds re-judging an unchanged
    // foundation.
    if (fix?.applied !== true) {
      await Promise.all(retainedRepairRunIds.map((runId) => recordModelOutcome(runId, {
        role: 'creative', stage: 'foundationGate', outcome: fix?.reverted === true ? 'rejected' : 'invalid', target: weak.dimension,
      }).catch(() => {})));
      return {
        pause: true,
        pauseKind: 'inapplicable',
        reason: `Foundation gate can't auto-fix the weakest dimension (${weak.dimension}): ${fix?.reason || 'no change applied'}. Strengthen it manually, or lower the threshold, and resume.`,
        residual: residualFindings(snap.dimensions),
        // A structure repair that verified badly and reverted reports the arc
        // blockers it was judged on — they are not in `residual`, which carries
        // the dimension gaps, so this is the only place they reach the user.
        discarded: Array.isArray(fix?.discarded) ? discardedSet(fix.discarded) : [],
      };
    }
    pendingRepair = {
      dimension: weak.dimension,
      judge: snap,
      snapshot: repairSnapshot,
      runIds: retainedRepairRunIds,
      characterBlanksBefore,
    };
    changed = true;
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
