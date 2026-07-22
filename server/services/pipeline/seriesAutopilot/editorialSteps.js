/**
 * Series Autopilot — editorial pipeline steps (#2842 split of seriesAutopilot.js):
 * script verification, the LLM review loop, the reverse-outline refresh, the
 * declarative editorial-check pass and the readiness/health gate.
 */

import { recordDomainUsage } from '../../domainUsage.js';
import { getSettings } from '../../settings.js';
import { getIssue } from '../issues.js';
import { analyzeManuscriptCompleteness } from '../arcPlanner.js';
import { verifyComicScript } from '../scriptVerify.js';
import { seedReviewFromFindings, getReview } from '../manuscriptReview.js';
import { generateManuscriptFix, acceptManuscriptFix } from '../manuscriptFix.js';
import { runEditorialChecks, buildEditorialCheckPlan, enabledChecksConsumeReverseOutline, buildReverseOutlineGateContext, summarizeCheckErrors } from '../editorial/checkRunner.js';
import { generateReverseOutline, getReverseOutline } from '../reverseOutline.js';
import { computeHealth, openBlockers, summarizeEditorialBlockers, formatBlockerSummary } from '../editorialScore.js';
import { MAX_EDITORIAL_ROUNDS } from './config.js';
import { DIVERGENCE_PATIENCE, trackConvergence, convergencePauseReason, divergencePauseReason } from './convergence.js';
import { broadcast, budgetPause, fileGap, providerOverrideOpts, providerIdOpts } from './session.js';
import { scriptStructurallyReady } from './stepResolver.js';

export async function runScriptVerify(sId, issueId, record) {
  record.runState.scriptChecked.add(issueId);
  const issue = await getIssue(issueId);

  // Gate 1 — STRUCTURAL (pure, cheap): does the script parse into pages/panels?
  // This is the only structural validation before completion in text-only /
  // visual-disabled comic runs, so a failure must BLOCK (pause), not just mark
  // the issue checked — otherwise the run could report done with a script that
  // can't become pages.
  if (!scriptStructurallyReady(issue)) {
    await fileGap(record, sId, {
      gapKind: 'script-unparseable',
      issueId,
      summary: 'The comic script for this issue does not parse into pages/panels, so comic pages can\'t be extracted. It likely needs a manual fix or regeneration of the comicScript stage.',
      context: `issueId=${issueId}`,
    });
    return {
      pause: true,
      gapFiled: true,
      reason: `comic script for issue ${issue.number ?? issueId} does not parse into pages/panels`,
      residual: [{ severity: 'high', location: `issue ${issue.number ?? '?'} / comicScript`, problem: 'script did not parse into pages/panels — cannot extract comic pages' }],
    };
  }

  // Gate 2 — CRAFT (LLM): does the script function as a comic script? This is
  // ADVISORY — unlike arc continuity, script craft is subjective and the
  // gating quality pass is the series-level editorial review, so blocking
  // findings are surfaced + filed (not auto-rewritten, not a hard pause) and
  // the autopilot keeps moving toward a draft. Wrapped so an LLM failure
  // downgrades to a skip instead of aborting the whole run.
  let issues = [];
  try {
    const result = await verifyComicScript(issueId, providerIdOpts(record));
    issues = result.issues || [];
    await recordDomainUsage('cos', { actions: 1 });
  } catch (err) {
    broadcast(sId, { type: 'step:skip', kind: 'scriptVerify', issueId, reason: `craft verify unavailable: ${(err?.message || err).toString().slice(0, 200)}` });
    return {};
  }
  const blocking = issues.filter((i) => i.severity === 'high');
  broadcast(sId, { type: 'verify:round', scope: 'script', issueId, round: 1, findings: issues.length, blocking: blocking.length });
  if (blocking.length) {
    await fileGap(record, sId, {
      gapKind: 'script-craft',
      issueId,
      summary: `Comic script craft review found ${blocking.length} blocking issue(s): ${blocking.map((b) => b.problem).join(' | ').slice(0, 600)}`,
      context: JSON.stringify(blocking).slice(0, 1000),
    });
    // #1572 — fileGap is advisory and only persists a gap task when fileGaps is
    // on (mirror its predicate). Tally what was actually FILED so the terminal
    // "complete" frame can qualify itself instead of silently reporting clean.
    if (record.options.fileGaps && record.mode === 'execute') {
      record.runState.scriptCraftGapIssues.add(issueId);
      record.runState.scriptCraftBlocking += blocking.length;
    }
  }
  return {};
}

export async function runEditorial(sId, record) {
  const maxRounds = Number.isInteger(record.options.maxEditorialRounds)
    ? record.options.maxEditorialRounds
    : MAX_EDITORIAL_ROUNDS;
  // maxRounds === 0 means "skip the editorial gate entirely" — which includes
  // the registry-driven editorial checks (the default info-dumping check is
  // LLM-backed, so a skip run must not spend budget on it). Mark both reviewed
  // so the resolver advances past editorialChecks too; the user can still run
  // checks on demand via the route.
  if (maxRounds === 0) {
    record.runState.editorialReviewed = true;
    // The reverse-outline refresh (#1349) only feeds the registry checks, so a run
    // that skips the whole editorial gate must skip it too — mark it refreshed so
    // the resolver advances past STEP 5.1 without spending budget.
    record.runState.reverseOutlineRefreshed = true;
    record.runState.editorialChecksReviewed = true;
    // Skipping the editorial gate also skips its health convergence check (#1316)
    // — the resolver must advance past editorialHealthGate too.
    record.runState.editorialHealthReady = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeAnalyze = await budgetPause();
    if (beforeAnalyze) return beforeAnalyze;
    const { issues, runId } = await analyzeManuscriptCompleteness(sId, {
      withEdits: true,
      ...providerOverrideOpts(record),
    });
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = (issues || []).filter((i) => record.options.blockingSets.editorial.has(i.severity));
    broadcast(sId, {
      type: 'verify:round', scope: 'editorial', round, findings: (issues || []).length, blocking: blocking.length,
    });
    // Seed the manuscript-review comment set so the findings are visible in the
    // manuscript editor regardless of auto-fix outcome.
    await seedReviewFromFindings(sId, issues || [], { runId, mode: 'fresh' }).catch((err) => {
      console.log(`⚠️ autopilot: seed editorial review failed for ${sId.slice(0, 12)}: ${err.message}`);
    });
    if (blocking.length === 0) {
      record.runState.editorialReviewed = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('editorial', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): bail when the auto-fix passes stop reducing blocking findings.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('editorial', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    // Bounded auto-fix: apply a fix for each open high-severity comment, then
    // the loop re-analyzes. Each fix is wrapped so one bad anchor doesn't abort
    // the pass (boundary use of try/catch — these call into LLM/file paths).
    const review = await getReview(sId).catch(() => ({ comments: [] }));
    const open = (review.comments || []).filter((c) => c.status === 'open' && record.options.blockingSets.editorial.has(c.severity));
    for (const comment of open) {
      if (record.cancelRequested) return { canceled: true };
      // Each generated fix is its own LLM call — gate AND bill per comment so a
      // multi-comment pass can't overspend or under-count the daily budget.
      const beforeFix = await budgetPause();
      if (beforeFix) return beforeFix;
      try {
        // Thread the run's provider/model override into fix GENERATION (an LLM
        // call) so it honors the same provider as the review — without this the
        // fix silently runs on the active/default provider (and its runtime
        // fallback), which diverges from the run's chosen model and, when the
        // default is rate-limited, degrades fixes onto a weak fallback. Accept
        // is a deterministic edit application (no LLM), so it needs no override.
        if (!comment.fix) await generateManuscriptFix(sId, { commentId: comment.id, ...providerOverrideOpts(record) });
        await acceptManuscriptFix(sId, { commentId: comment.id });
        await recordDomainUsage('cos', { actions: 1 });
      } catch (err) {
        console.log(`⚠️ autopilot: editorial fix ${comment.id} failed: ${(err?.message || err)}`);
      }
    }
  }
  return {};
}

// STEP 5.1 — refresh the reverse-outline scene segmentation (#1349) before the
// registry-driven editorial checks (5.2), so the scene-consuming checks read the
// current draft's scenes rather than a segmentation staled by this run's editorial
// edits. Two cheap pre-gates keep this from spending budget needlessly:
//   1. skip entirely when no enabled editorial check declares a reverse-outline
//      source (mirrors the runner's own needsReverseOutline gate), and
//   2. skip when the stored outline is already fresh — using getReverseOutline's
//      canonical `stale` flag, NOT a stale-check reimplemented here.
// Only when a regenerate will actually occur do we gate the daily budget and bill a
// cos action — the same shape as runEditorialChecksPass, which gates+bills only when
// an enabled LLM check will actually run. `force:false`
// is a belt-and-suspenders second guard against the stored outline going fresh
// between the pre-check and the call. Failures are advisory (logged), never block.

// #1575 — the per-run editorial-check subset (null = all enabled). Absent/empty
// is normalized to null so EVERY consumer (this reverse-outline gate, the budget
// plan, the checks run) resolves the identical set — otherwise a subset of checks
// that skip the outline could still trigger/bill the refresh keyed off the global
// enabled set, or the gate could bill against checks the run skips.
export const editorialSubsetIds = (options) =>
  Array.isArray(options?.editorialCheckIds) && options.editorialCheckIds.length
    ? options.editorialCheckIds
    : null;

export async function runReverseOutlineRefresh(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  const settings = await getSettings();
  const checkIds = editorialSubsetIds(record.options);
  // Gate 1 — sources-only pre-filter: does any enabled check (narrowed to this
  // run's subset) even DECLARE the outline as a source? If not, nothing to do —
  // and a subset that skips outline-consuming checks must not pay for a refresh
  // those checks would have triggered.
  if (!enabledChecksConsumeReverseOutline(settings, checkIds)) {
    record.runState.reverseOutlineRefreshed = true;
    return {};
  }
  // Gate 2 — is the stored outline stale (or never generated against a draftable
  // manuscript)? `no-content` (nothing drafted) needs no outline; `none` (draftable
  // but never segmented) and a `complete`-but-`stale` outline both need a regen.
  const current = await getReverseOutline(sId).catch(() => null);
  const needsRegen = !!current
    && current.status !== 'no-content'
    && (current.status === 'none' || current.stale === true);
  if (!needsRegen) {
    record.runState.reverseOutlineRefreshed = true;
    return {};
  }
  // Gate 3 (#1614) — gate-aware consumption. A check that DECLARES the outline as
  // a source still won't run if its runtime gate declines for this series (e.g. a
  // canon-less roster). Evaluate each consumer's gate against the current outline
  // and skip the refresh when none would run. Gate on SCENE PRESENCE, not
  // `status`: the precondition is "there's scene content to evaluate gates
  // against" — a never-generated (`status:'none'`) or empty outline has none, so
  // we bootstrap the first generation unconditionally rather than chicken-and-egg
  // ourselves out of it. enabledChecksConsumeReverseOutline only trusts a
  // DECLINING gate that didn't read the outline (the refresh regenerates it, so
  // an outline-content gate's stale verdict can't be trusted and keeps the check
  // a consumer) — so a scoped run of only outline-gated checks still refreshes.
  if (Array.isArray(current.scenes) && current.scenes.length > 0) {
    const gateCtx = await buildReverseOutlineGateContext(sId, { outline: current }).catch(() => null);
    if (gateCtx && !enabledChecksConsumeReverseOutline(settings, checkIds, gateCtx)) {
      record.runState.reverseOutlineRefreshed = true;
      return {};
    }
  }
  // A regenerate WILL spend one LLM call — gate the budget and bill, like the
  // other LLM passes. Bridge autopilot cancellation into the stage's AbortSignal.
  const beforeRefresh = await budgetPause();
  if (beforeRefresh) return beforeRefresh;
  const signal = { get aborted() { return record.cancelRequested; } };
  const regen = (force) => generateReverseOutline(sId, { ...providerIdOpts(record), force, signal })
    .catch((err) => {
      console.log(`⚠️ autopilot: reverse-outline refresh failed for ${sId.slice(0, 12)}: ${err.message}`);
      return null;
    });
  let result = await regen(false);
  // Canceled mid-pass — don't bill, don't mark refreshed; let the loop unwind.
  if (result?.status === 'canceled' || record.cancelRequested) return { canceled: true };
  // (#1614) A `cached:true` result means the manuscript hash still matched the
  // stored outline at generate time. Re-confirm staleness against the LIVE
  // manuscript within this run: if a concurrent edit moved the manuscript again
  // after that cache check, the cached outline is now stale and the downstream
  // checks would read it — force exactly one regen so they don't.
  if (result?.cached === true) {
    const after = await getReverseOutline(sId).catch(() => null);
    if (after?.stale === true) {
      result = await regen(true);
      if (result?.status === 'canceled' || record.cancelRequested) return { canceled: true };
    }
  }
  // Bill ONLY when the call actually regenerated (an LLM run). A `cached` result
  // (outline still fresh in the race window) or a `no-content` series spent nothing.
  // No verify:round broadcast here — a refresh isn't a review round (it produces
  // scenes, not findings); the conductor's generic step:start/step:complete already
  // surface "Refreshing scene segmentation…" / "done" to the UI.
  if (result && result.cached !== true && result.status !== 'no-content') {
    await recordDomainUsage('cos', { actions: 1 });
  }
  record.runState.reverseOutlineRefreshed = true;
  return {};
}

// STEP 5.2 — run the registry-driven editorial checks once per run, seeding
// their findings into the same manuscript-review comment set. Only LLM-kind
// checks cost tokens, so gate the daily budget AND bill a cos action only when
// an enabled LLM check will actually run — a deterministic-only (or all-checks-
// disabled) run does cheap local work and must neither pause on an exhausted
// budget nor consume quota. Failures are surfaced (logged) but never block the
// run — editorial checks are advisory.
export async function runEditorialChecksPass(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  const settings = await getSettings();
  // #1575 — narrow the pass + its budget gate to this run's subset (null = all
  // enabled). The gate (buildEditorialCheckPlan) and the run (runEditorialChecks)
  // must resolve the SAME set so billing and execution agree.
  const checkIds = editorialSubsetIds(record.options);
  const plan = await buildEditorialCheckPlan(sId, { checkIds, settings });
  const hasLlmCheck = plan.checks.some((c) => c.kind === 'llm');
  if (hasLlmCheck) {
    const beforeChecks = await budgetPause();
    if (beforeChecks) return beforeChecks;
  }
  // Bridge autopilot cancellation into the runner's cooperative AbortSignal so a
  // mid-pass /autopilot/cancel stops before the next check and skips seeding
  // (the runner re-checks `signal.aborted` after each check). A live getter
  // reflects `record.cancelRequested` without a separate controller to manage.
  const signal = { get aborted() { return record.cancelRequested; } };
  // #1578 — forward the runner's per-check check:start/check:complete frames up
  // the autopilot SSE stream (tagged scope:'editorialChecks' so the UI groups
  // them with the editorialChecks verify:round). Without this the only signal
  // during a long (issues × checks) pass is the single terminal verify:round
  // total — no per-check progress or severity breakdown.
  const onProgress = (event) => broadcast(sId, { ...event, scope: 'editorialChecks' });
  const result = await runEditorialChecks(sId, { ...providerOverrideOpts(record), checkIds, settings, signal, onProgress }).catch((err) => {
    console.log(`⚠️ autopilot: editorial checks failed for ${sId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  // Canceled mid-pass — don't bill, don't mark the step reviewed; let the loop
  // unwind via its canceled branch.
  if (result?.canceled || record.cancelRequested) return { canceled: true };
  if (result) {
    if (hasLlmCheck) await recordDomainUsage('cos', { actions: 1 });
    // #1573 — a check whose run() threw is recorded in perCheck.error but the
    // pass otherwise looks clean. Surface the errored count + failing checkIds on
    // the round frame and accumulate them onto the run so the terminal summary
    // can flag a partial failure (no silent "complete").
    const { errored, erroredCheckIds } = summarizeCheckErrors(result.perCheck);
    erroredCheckIds.forEach((id) => record.runState.editorialCheckErroredIds.add(id));
    // #1613 — count the high-severity findings this pass surfaced. The round frame
    // previously hardcoded `blocking: 0`, which made a 50-high-finding pass look
    // "complete" — the misleading per-step signal the issue calls out. Report the
    // real high count so the step's `blocking` matches what it found, whether or
    // not the optional pause gate is armed.
    const highFindings = result.findings.filter((f) => f.severity === 'high');
    broadcast(sId, { type: 'verify:round', scope: 'editorialChecks', round: 1, findings: result.findings.length, blocking: highFindings.length, errored, erroredCheckIds });
    if (errored) {
      console.error(`❌ autopilot: ${errored} editorial check(s) errored — series=${sId.slice(0, 12)} ${erroredCheckIds.join(', ')}`);
    }
    // #1613 — optional gate: when armed (threshold > 0) and the pass surfaced at
    // least that many high findings, PAUSE for human review instead of silently
    // proceeding to the health gate. Off by default (threshold 0), so existing
    // runs are unchanged. Do NOT mark the step reviewed — a resume re-runs the
    // checks and reconciles (like the health gate), so once the human reduces the
    // high findings below the threshold (or lowers it) the run continues.
    const threshold = record.options.checkFindingsPauseThreshold || 0;
    if (threshold > 0 && highFindings.length >= threshold) {
      // Editorial findings already carry severity/location/problem (manuscriptReview
      // sanitizes them), so the residual uses the same shape as the other pauses;
      // keep checkId so the UI can link a residual back to the check that raised it.
      const residual = highFindings.map((f) => ({
        severity: f.severity, // already filtered to 'high' — carry it rather than re-asserting
        location: f.location || (f.checkId ? `check ${f.checkId}` : 'manuscript'),
        problem: f.problem || 'high-severity editorial finding',
        checkId: f.checkId,
      }));
      console.log(`🚦 editorial checks gate — series=${sId.slice(0, 12)} ${highFindings.length} high finding(s) ≥ threshold ${threshold}, pausing for review`);
      return {
        pause: true,
        pauseKind: 'checkFindings',
        reason: `Editorial checks surfaced ${highFindings.length} high-severity finding(s) (≥ threshold ${threshold}) — paused for review. Address them in the manuscript editor, or raise the editorial-check pause threshold above ${highFindings.length} (set it to 0 to disable) in Options and resume.`,
        residual,
      };
    }
  }
  record.runState.editorialChecksReviewed = true;
  return {};
}

// STEP 5.3 — editorial health convergence gate (#1316). A cheap, no-LLM gate:
// read the persisted review, compute the aggregate health under the configured
// readiness gate, and either mark the run clean (proceed to visuals) or PAUSE
// with the open blockers for human triage. This is the consolidated "ready"
// signal — distinct from the completeness loop's own per-round high-only gate —
// so a blocker the registry checks (5.2) surfaced after completeness converged
// still stops the run. No auto-fix here: the completeness loop already attempted
// fixes; remaining blockers need a human (or a re-run after edits).
export async function runEditorialHealthGate(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  // The effective gate (per-run override → persisted setting → null) was resolved
  // and stamped onto record.options at start (#1580), mirroring the round bounds —
  // so the loop and the dry-run plan can't disagree on which gate applied. null
  // falls through to DEFAULT_READINESS_GATE inside computeHealth/openBlockers.
  const gate = record.options.readinessGate || undefined;
  // Do NOT swallow a getReview error into an empty review — that would fail OPEN
  // (the gate would pass on a corrupt/unreadable store and let the run proceed to
  // visuals without verifying health). Let it bubble to the coordinator's
  // top-level catch, which records a clean `error` terminal state.
  const review = await getReview(sId);
  const comments = review.comments || [];
  // Per-series severity-weight override (#1616) resolved + stamped at start, so
  // the health score the gate reads matches the live + persisted scores.
  const health = computeHealth(comments, gate, { weights: record.options.severityWeights });
  broadcast(sId, {
    type: 'verify:round', scope: 'editorialHealth', round: 1,
    findings: health.open, blocking: health.ready ? 0 : health.open, score: health.score,
  });
  if (health.ready) {
    record.runState.editorialHealthReady = true;
    return {};
  }
  // Not clean — surface the open blockers (via the shared helper, so the residual
  // can't disagree with computeHealth's `ready` verdict) for the human triage.
  // No pauseKind (#1571): this is a single-pass gate, not a bounded verify→resolve
  // loop, so it has no maxRounds/divergence distinction — leave it null. If this
  // ever gains a retry loop, thread pauseKind through trackConvergence then.
  const blockers = openBlockers(comments, gate);
  // Surface the per-check / per-issue breakdown that drove the pause (#1579) —
  // a single emoji-prefixed line so "why did health reject my 50-issue series?"
  // is answerable from the logs, and the same breakdown on the marker so the UI
  // / resume banner can render it without re-hitting the health API.
  const healthBreakdown = summarizeEditorialBlockers(health);
  console.log(`🩺 editorial health gate not clean — series=${sId.slice(0, 12)} score=${health.score}, ${health.open} open: ${formatBlockerSummary(healthBreakdown)}`);
  return { pause: true, reason: `editorial health not clean (score ${health.score}, ${health.open} open finding(s))`, residual: blockers, healthBreakdown };
}
