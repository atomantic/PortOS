/**
 * Series Autopilot — judging & revision steps (#2842 split of seriesAutopilot.js):
 * the quality-score rollup, the per-issue judge fan-out, the adversarial-cuts
 * pass and the bounded revision cycle.
 */

import { randomUUID } from 'crypto';
import { recordDomainUsage } from '../../domainUsage.js';
import { getSettings } from '../../settings.js';
import { listIssues, getIssue, updateStageWithLatest } from '../issues.js';
import { judgeIssue, getIssueJudge, getSeriesJudge } from '../pipelineJudge.js';
import { runEditorialChecks } from '../editorial/checkRunner.js';
import { seedReviewFromFindings, getReview } from '../manuscriptReview.js';
import { applyCuts, filterSafeCutComments } from '../applyCuts.js';
import { eligibleIssues, getComparativeRank } from '../editorial/comparativeRank.js';
import { buildRevisionBrief } from '../editorial/revisionBrief.js';
import { evaluateRevisionStop, decideKeepRevert } from '../editorial/revisionStop.js';
import { broadcast, budgetPause, providerOverrideOpts } from './session.js';

// Mean of the judged issues' composite qualityScore (null when nothing judged).
export function meanQualityScore(seriesJudge) {
  const vals = (seriesJudge?.scores || [])
    .filter((s) => s.judged && Number.isFinite(Number(s.qualityScore)))
    .map((s) => Number(s.qualityScore));
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

// Judge every drafted (eligible) issue that needs it — an unjudged or stale
// snapshot. Staleness is read from the persisted snapshots (getSeriesJudge, no
// LLM), so a fresh issue is skipped WITHOUT even a cache-reuse call and, crucially,
// the budget is gated BEFORE a fresh judge spends — never after. Each real judge
// bills one cos action. Returns a pause result when the budget is exhausted with
// judging still to do, a cancel result, or null on completion.
async function judgeAllEligible(sId, record, issues) {
  const eligible = eligibleIssues(issues);
  const { providerOverride, modelOverride } = record.options;
  const pre = await getSeriesJudge(sId, { issues });
  const scoreById = new Map((pre.scores || []).map((s) => [s.issueId, s]));
  for (const issue of eligible) {
    if (record.cancelRequested) return { canceled: true };
    const score = scoreById.get(issue.id);
    const needsJudge = !score || !score.judged || score.stale;
    if (!needsJudge) continue; // already judged against the current content — free.
    // A fresh judge WILL spend an LLM call — gate the budget first, then bill.
    const gate = await budgetPause();
    if (gate) return gate;
    const snap = await judgeIssue(issue.id, { providerId: providerOverride, model: modelOverride }).catch((err) => {
      console.log(`⚠️ revision: judge failed for issue ${issue.id.slice(0, 12)}: ${err.message}`);
      return null;
    });
    if (snap && !snap.cached && snap.status === 'complete') {
      await recordDomainUsage('cos', { actions: 1 });
    }
  }
  return null;
}

// Run the adversarial-cuts editorial check for the series, seed the findings into
// the manuscript-review comment set, and return the freshly-seeded safe-cut
// comments (OVER-EXPLAIN + REDUNDANT). Force-enables the check for this pass so a
// user who disabled it globally still gets the loop's mechanical revision. One
// billed LLM pass; returns { safeComments } or a { pause }/{ canceled } result.
async function runAdversarialCuts(sId, record) {
  const before = await budgetPause();
  if (before) return before;
  const settings = await getSettings().catch(() => null);
  // Overlay a force-enable for the cut check so a globally-disabled check still
  // runs inside the consented revision loop (never mutates persisted settings).
  const merged = {
    ...(settings || {}),
    pipelineEditorialChecks: {
      ...(settings?.pipelineEditorialChecks || {}),
      checks: {
        ...(settings?.pipelineEditorialChecks?.checks || {}),
        'prose.adversarial-cuts': {
          ...(settings?.pipelineEditorialChecks?.checks?.['prose.adversarial-cuts'] || {}),
          enabled: true,
        },
      },
    },
  };
  const signal = { get aborted() { return record.cancelRequested; } };
  const result = await runEditorialChecks(sId, {
    checkIds: ['prose.adversarial-cuts'],
    settings: merged,
    signal,
    ...providerOverrideOpts(record),
  }).catch((err) => {
    console.log(`⚠️ revision: adversarial cuts failed for ${sId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  if (record.cancelRequested) return { canceled: true };
  if (!result || result.canceled) return { safeComments: [] };
  await recordDomainUsage('cos', { actions: 1 });
  await seedReviewFromFindings(sId, result.findings || [], { runId: result.runId, mode: 'merge' }).catch((err) => {
    console.log(`⚠️ revision: seed cut findings failed for ${sId.slice(0, 12)}: ${err.message}`);
  });
  const review = await getReview(sId).catch(() => ({ comments: [] }));
  return { safeComments: filterSafeCutComments(review.comments || []) };
}

// One iterate-to-quality revision cycle (CWQE Phase 7, #2171). Composes the
// judge (#2167), adversarial cuts (#2168), and — when a fresh ranking exists —
// the comparative Elo (#2169) to revise the WEAKEST drafted issue under a
// keep/revert score gate, then evaluates the stop conditions. Every LLM call is
// budget-gated + billed exactly like the other steps; a budget-exhausted cycle
// returns a pause the coordinator handles. Never routes here in dry-run (dispatch
// only runs in execute mode).
export async function runRevisionCycle(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  const issues0 = await listIssues({ seriesId: sId });
  if (eligibleIssues(issues0).length === 0) {
    // Nothing drafted to revise — converge so the resolver moves on.
    record.runState.revisionConverged = true;
    broadcast(sId, { type: 'revision:converged', reason: 'no-content', cycle: record.runState.revisionCyclesRun || 0 });
    return {};
  }

  // 1. Judge every eligible issue (cache-aware) → baseline mean + weakest.
  const judged = await judgeAllEligible(sId, record, issues0);
  if (judged?.canceled) return { canceled: true };
  if (judged?.pause) return judged;

  const seriesJudge = await getSeriesJudge(sId, { issues: issues0 });
  const preMean = meanQualityScore(seriesJudge);

  // 2. Pick the weakest issue — Elo ranking when a FRESH one exists (#2169),
  //    else the judge's weakest-first (lowest qualityScore).
  let weakestId = null;
  const rank = await getComparativeRank(sId).catch(() => null);
  if (rank?.status === 'complete' && !rank.stale && Array.isArray(rank.weakest) && rank.weakest[0]) {
    weakestId = rank.weakest[0].issueId;
  }
  if (!weakestId) weakestId = seriesJudge.weakest?.[0]?.issueId || null;
  if (!weakestId) {
    record.runState.revisionConverged = true;
    broadcast(sId, { type: 'revision:converged', reason: 'no-weakest', cycle: record.runState.revisionCyclesRun || 0 });
    return {};
  }

  const preWeakest = seriesJudge.scores.find((s) => s.issueId === weakestId);
  const preScore = preWeakest?.qualityScore ?? null;
  const stageId = preWeakest?.stageId || 'prose';

  // 3. Adversarial cuts (series-wide seed) + collect this issue's safe cuts.
  const cuts = await runAdversarialCuts(sId, record);
  if (cuts?.canceled) return { canceled: true };
  if (cuts?.pause) return cuts;
  const issueSafeCuts = (cuts.safeComments || []).filter((c) => c.issueId === weakestId);

  // Capture the weakest issue's pre-revision stage state for the keep/revert gate
  // (existing runHistory snapshotting handles the version event; we hold the exact
  // text so a revert can restore it through the serialized write path — never a
  // force over a concurrent human edit).
  const preIssue = await getIssue(weakestId).catch(() => null);
  const preStage = preIssue?.stages?.[stageId] || {};
  const preState = { input: preStage.input || '', output: preStage.output || '', lastRunId: preStage.lastRunId || null };
  // The full judge snapshot for the brief — a persisted-snapshot read (no LLM
  // spend); judgeAllEligible above already judged this issue this cycle.
  const weakestJudge = await getIssueJudge(weakestId).catch(() => null);

  // 4. Build the revision brief (pure) and broadcast it as the revision plan.
  const brief = buildRevisionBrief({
    issue: { number: preIssue?.number, title: preIssue?.title },
    judge: weakestJudge && weakestJudge.status === 'complete' ? weakestJudge : (preWeakest || {}),
    cutComments: issueSafeCuts,
    currentChars: (preState.output || '').length || null,
  });
  broadcast(sId, { type: 'revision:brief', issueId: weakestId, cycle: (record.runState.revisionCyclesRun || 0) + 1, cuts: issueSafeCuts.length, brief: brief.slice(0, 2000) });

  // 5. Apply — mechanical safe cuts are the revision (autonovel: "the cuts ARE the
  //    plan"). applyCuts writes through the serialized stage path with a runHistory
  //    snapshot for undo. No safe cuts ⇒ nothing to apply this cycle.
  let applied = 0;
  if (issueSafeCuts.length > 0) {
    const cutResult = await applyCuts(sId, issueSafeCuts, { safeTypesOnly: true }).catch((err) => {
      console.log(`⚠️ revision: applyCuts failed for issue ${weakestId.slice(0, 12)}: ${err.message}`);
      return { applied: 0, sections: [] };
    });
    applied = cutResult.applied || 0;
  }

  // 6. Keep/revert gate — re-judge the revised issue; keep only if the composite
  //    qualityScore did not regress, else restore the pre-revision text.
  let decision = 'keep';
  let postScore = preScore;
  if (applied > 0) {
    const postIssue = await getIssue(weakestId).catch(() => null);
    const appliedOutput = postIssue?.stages?.[stageId]?.output || '';
    const before = await budgetPause();
    if (before) return before;
    const reJudge = await judgeIssue(weakestId, { stageId, force: true, providerId: record.options.providerOverride, model: record.options.modelOverride }).catch((err) => {
      console.log(`⚠️ revision: re-judge failed for issue ${weakestId.slice(0, 12)}: ${err.message}`);
      return null;
    });
    if (reJudge && reJudge.status === 'complete') await recordDomainUsage('cos', { actions: 1 });
    postScore = reJudge?.status === 'complete' ? reJudge.qualityScore : preScore;
    decision = decideKeepRevert(preScore, postScore);
    if (decision === 'revert') {
      // Restore through the serialized path, guarded so a concurrent human edit is
      // never clobbered: revert ONLY when the stage still holds the cut output we
      // produced. A `revert-` runId marks this as a fresh version event.
      await updateStageWithLatest(weakestId, stageId, (cur) => {
        if ((cur?.output || '') !== appliedOutput) return {};
        return { status: 'edited', input: preState.input, output: preState.output, lastRunId: `revert-${randomUUID()}`, errorMessage: '' };
      }).catch((err) => {
        console.log(`⚠️ revision: revert failed for issue ${weakestId.slice(0, 12)}: ${err.message}`);
      });
      // Re-judge the restored text so the persisted snapshot matches what's on
      // disk (else it lingers pinned to the rejected cut version). Budget-gated +
      // billed like every other judge; skipped (snapshot stays stale — the next
      // cycle re-judges it) when the budget is spent.
      const beforeRevertJudge = await budgetPause();
      if (!beforeRevertJudge) {
        const rj = await judgeIssue(weakestId, { stageId, force: true, providerId: record.options.providerOverride, model: record.options.modelOverride }).catch(() => null);
        if (rj && rj.status === 'complete') await recordDomainUsage('cos', { actions: 1 });
      }
    }
  }

  // 7. Record the cycle: post-cycle mean drives the plateau detector; the ledger
  //    line is the experiment log (single emoji line per the CLAUDE.md convention).
  record.runState.revisionCyclesRun = (record.runState.revisionCyclesRun || 0) + 1;
  const postSeriesJudge = await getSeriesJudge(sId, { issues: await listIssues({ seriesId: sId }) });
  const postMean = meanQualityScore(postSeriesJudge);
  if (Number.isFinite(postMean)) record.runState.revisionScoreHistory.push(postMean);
  console.log(`🔁 revision cycle ${record.runState.revisionCyclesRun} — series=${sId.slice(0, 12)} issue=${preIssue?.number ?? weakestId} pre=${preScore ?? '?'} post=${postScore ?? '?'} → ${decision} (applied ${applied} cut(s), mean ${preMean ?? '?'}→${postMean ?? '?'})`);

  // 8. Stop conditions — plateau / hedged-convergence / maxCycles. The residual
  //    finding texts come from the weakest issue's judge (verdict + revisions):
  //    the reviewer will ALWAYS find something, so the stop is about qualification,
  //    not zero defects.
  const findingTexts = [
    postSeriesJudge.scores.find((s) => s.issueId === weakestId)?.oneLineVerdict || '',
    ...((weakestJudge?.topRevisions) || []),
  ].filter(Boolean);
  const stop = evaluateRevisionStop({
    cyclesRun: record.runState.revisionCyclesRun,
    minCycles: record.options.revisionMinCycles,
    maxCycles: record.options.revisionMaxCycles,
    scoreHistory: record.runState.revisionScoreHistory,
    plateauDelta: record.options.revisionPlateauDelta,
    findingTexts,
  });
  broadcast(sId, {
    type: 'revision:cycle', cycle: record.runState.revisionCyclesRun, issueId: weakestId,
    preScore, postScore, decision, applied, preMean, postMean,
    converged: stop.stop, stopReason: stop.reason,
  });
  if (stop.stop) {
    record.runState.revisionConverged = true;
    broadcast(sId, { type: 'revision:converged', reason: stop.reason, detail: stop.detail, cycle: record.runState.revisionCyclesRun });
    console.log(`✅ revision converged (${stop.reason}) — series=${sId.slice(0, 12)}: ${stop.detail}`);
  }
  return {};
}
