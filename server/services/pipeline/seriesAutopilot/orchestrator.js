/**
 * Series Autopilot — run orchestration (#2842 split of seriesAutopilot.js):
 * `startSeriesAutopilot` (the resolve → dispatch → broadcast loop) and the
 * boot-time recovery of runs interrupted by a restart.
 */

import { randomUUID } from 'crypto';
import { getDomainMode } from '../../../lib/domainAutonomy.js';
import { mergeSeverityWeights, resolveBlockingSet } from '../../../lib/editorial/index.js';
import { loadState } from '../../cosState.js';
import { getDomainBudgetStatus } from '../../domainUsage.js';
import { getSettings } from '../../settings.js';
import { getSeries, updateSeries } from '../series.js';
import { listIssues } from '../issues.js';
import { buildEditorialCheckPlan } from '../editorial/checkRunner.js';
import { runs } from './state.js';
import {
  resolveAutopilotRounds, resolveAutopilotFoundationGate, resolveAutopilotFoundationThreshold,
  resolveAutopilotReadinessGate, resolveAutopilotCheckPauseThreshold, resolveAutopilotNotifyOnPause,
  resolveAutopilotProduceTeaser, resolveAutopilotRevision, resolveAutopilotLlm,
  resolveAutopilotUnlockForRun, resolveAutopilotSelfImprove, resolveAutopilotObserver,
} from './config.js';
import { runSelfImproveDiagnosis } from './selfImprove.js';
import { observerEnabled, runObserverPass, summarizeObserver } from './observer.js';
import { VISUAL_DRAFT_ENABLED, summarizePlanCost } from './convergence.js';
import { broadcast, broadcastStart, persistMarker, clearPauseNotice, notifyPause, fileGap, scheduleCleanup } from './session.js';
import { resolveNextStep } from './stepResolver.js';
import { editorialSubsetIds } from './editorialSteps.js';
import { dispatchStep } from './dispatch.js';
import { buildDryRunPlan } from './dryRun.js';

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

/**
 * Start (or no-op resume of) the autopilot for a series. Returns immediately;
 * progress lands via SSE. When the cos domain is `off`, returns
 * `{ rejected:true, mode:'off' }` WITHOUT starting (route maps to 409).
 */
export async function startSeriesAutopilot(sId, options = {}) {
  const existing = runs.get(sId);
  if (existing && !existing.finished) {
    return { runId: existing.runId, alreadyRunning: true, mode: existing.mode };
  }

  const state = await loadState().catch(() => ({ config: {} }));
  const mode = getDomainMode(state.config, 'cos');
  if (mode === 'off') {
    return { rejected: true, mode: 'off' };
  }

  // Resolve the convergence-round bounds ONCE at start (per-run option →
  // persisted setting → default) and stamp them onto the run's options so the
  // synchronous loops, the dry-run plan, and a later resume all read the same
  // effective values. A resume reuses this same path, so a raised persisted
  // setting takes effect on the next Resume without re-specifying it.
  const settings = await getSettings().catch(() => null);
  // Per-series severity config (#1616): resolve the (possibly overridden) health
  // severity weights + the per-gate blocking-severity Sets ONCE at start and
  // stamp them onto run options, mirroring the round bounds / readiness gate —
  // so every gate read site + the health gate use the same resolved values, and
  // a resume re-reads them fresh. Loading the series here is cheap; a missing
  // series (deleted mid-run) falls through to the frozen defaults.
  const seriesRecord = await getSeries(sId).catch(() => null);
  const runOptions = {
    ...options,
    ...resolveAutopilotRounds(options, settings),
    foundationGate: resolveAutopilotFoundationGate(options, settings),
    foundationThreshold: resolveAutopilotFoundationThreshold(options, settings),
    readinessGate: resolveAutopilotReadinessGate(options, settings),
    checkFindingsPauseThreshold: resolveAutopilotCheckPauseThreshold(options, settings),
    notifyOnPause: resolveAutopilotNotifyOnPause(options, settings),
    produceTeaser: resolveAutopilotProduceTeaser(options, settings),
    unlockForRun: resolveAutopilotUnlockForRun(options),
    ...resolveAutopilotRevision(options, settings),
    // Pipeline self-improvement (opt-in): diagnose the AUTOMATION at the run's
    // terminal and file a PortOS fix task when the pipeline — not the story — is
    // what failed. Resolved here with the other gates so the signal tap in
    // `broadcast` sees the flag from the run's very first frame.
    selfImprove: resolveAutopilotSelfImprove(options, settings),
    // Observing orchestrator (opt-in): watch the run's telemetry step by step
    // and dispatch AUTO-APPROVED PortOS fix tasks (PR + review loop + merge, no
    // human gate) as pipeline defects surface. Same early resolution so the
    // signal tap retains frames from the first one.
    observer: resolveAutopilotObserver(options, settings),
    // Run provider/model: per-run override → the series' own `series.llm` →
    // unset (stage pin / active provider downstream). Resolved ONCE here so the
    // manual run, a scheduled run and the UI's "this run calls X / Y" copy all
    // name the same thing, and so a resume re-reads a since-changed series LLM.
    ...resolveAutopilotLlm(options, seriesRecord),
    severityWeights: mergeSeverityWeights(seriesRecord?.severityWeights),
    blockingSets: {
      arc: resolveBlockingSet(seriesRecord?.blockingSeverities, 'arc'),
      beatContinuity: resolveBlockingSet(seriesRecord?.blockingSeverities, 'beatContinuity'),
      editorial: resolveBlockingSet(seriesRecord?.blockingSeverities, 'editorial'),
    },
  };

  if (existing) {
    // A finished run still in its replay window — evict it so this fresh run
    // fully replaces it (mirrors editorialAnalysisRunner).
    if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    for (const c of existing.clients) c.end();
  }

  const runId = randomUUID();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    cancelRequested: false,
    finished: false,
    cleanupTimer: null,
    startedAt: new Date().toISOString(),
    mode,
    options: runOptions,
    // Diagnosable telemetry retained for the opt-in self-improvement pass —
    // appended by `broadcast` → `noteSignal`, bounded by MAX_SIGNALS (the
    // overflow is counted in `signalsDropped`, not stored). Empty on every run
    // that didn't opt in.
    signals: [],
    signalsDropped: 0,
    runState: {
      // Unlock-everything pre-pass (opt-in, see unlockPass.js) has run this
      // run. Boolean latch like arcVerified so the resolver routes there at
      // most once, and a resume re-runs it (idempotent) against fresh state.
      locksUnlocked: false,
      arcAttempted: false,
      arcVerified: false,
      // #2176 — foundation-quality gate satisfied this run (threshold cleared,
      // or the gate disabled/0-round). Boolean like arcVerified so the resolver
      // routes here at most once per run.
      foundationGated: false,
      beatContinuityChecked: false,
      editorialReviewed: false,
      reverseOutlineRefreshed: false,
      editorialChecksReviewed: false,
      editorialHealthReady: false,
      canonVerified: false,
      episodesAttempted: new Set(),
      beatsAttempted: new Set(),
      textAttempted: new Set(),
      scriptChecked: new Set(),
      visualDrafted: new Set(),
      // #2185 — issues whose optional teaser deliverable has been produced (or
      // attempted) this run, so the resolver can't re-loop into produceTeaser.
      teaserProduced: new Set(),
      // #1572 — issues whose ADVISORY craft gate filed a blocking gap task, and
      // the total blocking-finding count. Carried into the terminal `complete`
      // frame + persisted marker so a "clean complete" doesn't hide downstream
      // render blockers the user still has to resolve.
      scriptCraftGapIssues: new Set(),
      scriptCraftBlocking: 0,
      // #1573 — checkIds of editorial checks that threw during this run's checks
      // pass. Surfaced on the terminal `complete` frame + persisted marker so a
      // check that errors every run is visible instead of a silent "clean".
      editorialCheckErroredIds: new Set(),
      // #2171 — iterate-to-quality revision loop state (opt-in). `revisionCyclesRun`
      // is the completed-cycle count (the resolver's cursor); `revisionScoreHistory`
      // is the per-cycle mean series qualityScore the plateau detector reads;
      // `revisionConverged` latches true once a stop condition fires so the resolver
      // routes past the loop to canon/visuals.
      revisionCyclesRun: 0,
      revisionScoreHistory: [],
      revisionConverged: false,
      // Observing orchestrator state (opt-in, see observer.js). `observerCursor`
      // is the index into `signals` the next mid-run pass reads from (each pass
      // consumes its window so the same frames are never billed twice);
      // `observerPassesRun` counts the bounded mid-run passes;
      // `observerFindings` is the bounded log of dispatched tasks, carried to
      // the terminal frame + marker.
      observerCursor: 0,
      observerPassesRun: 0,
      observerFindings: [],
    },
    activeChild: null,
  };
  runs.set(sId, record);

  // Shared `start` frame for both modes. `provider`/`model`/`effort` are the
  // run's resolved soft defaults — what the panel shows as "this run calls X / Y";
  // a stage pinned on the Prompts page still overrides them for that stage.
  const startFrame = (target, extra = {}) => ({
    type: 'start', runId, mode, target,
    provider: runOptions.providerOverride ?? null,
    model: runOptions.modelOverride ?? null,
    effort: runOptions.effortOverride ?? null,
    ...extra,
  });

  // Post-mortem hook for the opt-in diagnosis passes. Best-effort by contract:
  // a diagnosis that throws must never turn a completed run into a failed one,
  // so every terminal calls it through these catches. Never fires on a cancel
  // (the user stopped it — there's no failure to explain) or a budget pause (an
  // exhausted budget is a spend fact, not an automation defect, and there'd be
  // no budget left to diagnose it with anyway). When the observing orchestrator
  // is on it SUPERSEDES the one-shot self-improve post-mortem — same evidence,
  // stronger action policy; running both would bill one run's telemetry twice
  // and file near-duplicate tasks under different dedup keys. Returns
  // `{ selfImprove, observer }` so each terminal spreads both marker fields.
  const postMortem = async (outcome, reason = null) => {
    if (observerEnabled(record)) {
      // Let any in-flight mid-run pass land first — its frames must precede
      // the terminal frame (SSE replays only the last payload), and its filing
      // must be in the summary the marker persists.
      await observerIdle();
      await runObserverPass(sId, record, { phase: 'terminal', outcome, reason })
        .catch((err) => {
          console.log(`⚠️ autopilot: observer terminal pass failed for ${sId.slice(0, 12)}: ${err.message}`);
        });
      return { selfImprove: null, observer: summarizeObserver(record) };
    }
    const selfImprove = await runSelfImproveDiagnosis(sId, record, { outcome, reason })
      .catch((err) => {
        console.log(`⚠️ autopilot: self-improve diagnosis failed for ${sId.slice(0, 12)}: ${err.message}`);
        return null;
      });
    return { selfImprove, observer: null };
  };

  // Mid-run observer beat: after each completed step, spend one bounded
  // diagnosis pass when the step's fresh telemetry warrants it (see
  // observer.js#shouldObserveStep — a clean step costs nothing). NOT awaited in
  // the step loop — the pass rides a per-run promise chain so a heavy-model
  // diagnosis never stalls the next pipeline step (the whole point is fixing
  // the pipeline WHILE the run continues); the gate re-evaluates when the
  // chained pass actually runs, so back-to-back enqueues collapse into cheap
  // no-ops once the first pass consumes the window. Best-effort like the
  // post-mortem: observing must never break the run.
  let observerChain = Promise.resolve();
  const observeStep = (step) => {
    if (!observerEnabled(record)) return;
    observerChain = observerChain
      .then(() => runObserverPass(sId, record, { phase: 'step', stepKind: step.kind }))
      .catch((err) => {
        console.log(`⚠️ autopilot: observer pass failed for ${sId.slice(0, 12)}: ${err.message}`);
        return null;
      });
  };
  // Every terminal awaits this before broadcasting: a pass landing after the
  // terminal frame would clobber the SSE replay payload clients resume from.
  const observerIdle = () => observerChain.catch(() => null);

  // Fire-and-forget coordinator. The try/catch is the permitted boundary use —
  // an unhandled LLM rejection here would crash the process on Node ≥15.
  (async () => {
    try {
      // DRY-RUN: enumerate the plan, no side effects.
      if (mode === 'dry-run') {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        // Resolve the enabled LLM-check count (#1576) so the plan's editorialChecks
        // step can estimate its issues × checks LLM fan-out. Mirrors the actual
        // pass: same subset (editorialSubsetIds) and same settings the checks read.
        const settings = await getSettings().catch(() => null);
        const checkPlan = await buildEditorialCheckPlan(sId, { checkIds: editorialSubsetIds(runOptions), settings }).catch(() => null);
        const editorialLlmCheckCount = checkPlan ? checkPlan.checks.filter((c) => c.kind === 'llm').length : undefined;
        const plan = buildDryRunPlan(series, issues, runOptions, { editorialLlmCheckCount });
        const planTotals = summarizePlanCost(plan);
        broadcastStart(sId, startFrame(series.targetFormat, { plan, planTotals }));
        // Carry the plan on the terminal frame too: a dry-run emits start +
        // complete synchronously, often before the client attaches, and
        // attachSseClient replays only the LAST frame — so the plan would be
        // lost if it lived solely on the start frame.
        broadcast(sId, { type: 'complete', runId, dryRun: true, steps: plan.length, plan, planTotals, completedAt: new Date().toISOString() });
        console.log(`🧭 autopilot dry-run — series=${sId.slice(0, 12)} steps=${plan.length} est≈${planTotals.estActions} action(s) ${planTotals.estLlmCalls} LLM call(s)`);
        return;
      }

      // EXECUTE.
      const series0 = await getSeries(sId);
      broadcastStart(sId, startFrame(series0.targetFormat));
      await persistMarker(sId, { status: 'running', runId, currentStep: null, residualFindings: [], lastError: null });
      // A resume is a fresh start: drop any stale pause banner up front so a run
      // that completes/errors without re-pausing doesn't leave a dead resume link.
      await clearPauseNotice(sId);
      if (runOptions.includeVisual && !VISUAL_DRAFT_ENABLED) {
        broadcast(sId, { type: 'note', message: 'Draft visual rendering is not enabled in this build — running to text-ready + editorial review.' });
      }

      let ordinal = 0;
      while (!record.cancelRequested) {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        const step = resolveNextStep(series, issues, record.runState, runOptions);

        if (step.kind === 'done') {
          // #1572 — qualify "complete" when the advisory craft gate filed
          // blocking script-craft gaps during this run: the run is done, but
          // those gaps still block downstream visual rendering, so report them
          // on both the persisted marker and the terminal frame.
          const craftGapIssues = record.runState.scriptCraftGapIssues.size;
          const craftGapFindings = record.runState.scriptCraftBlocking;
          // #1573 — qualify "complete" when an editorial check threw this run: the
          // run finished, but a check that errored produced no findings, so its
          // dimension was never actually evaluated. Persist the count + carry the
          // failing checkIds on the frame so the UI flags it instead of "clean".
          const editorialCheckErroredIds = [...record.runState.editorialCheckErroredIds];
          const editorialCheckErrors = editorialCheckErroredIds.length;
          // A "complete" run can still have limped (a check threw, a child was
          // retried, a step was skipped) — diagnose the automation BEFORE the
          // terminal frame so the verdict rides it. No-ops unless the run opted
          // in AND carries such a signal.
          const pm = await postMortem('done', craftGapIssues || editorialCheckErrors
            ? `completed with ${craftGapIssues} filed craft gap(s) and ${editorialCheckErrors} errored check(s)`
            : null);
          await persistMarker(sId, { status: 'done', runId, currentStep: null, craftGapIssues, craftGapFindings, editorialCheckErrors, selfImprove: pm.selfImprove, observer: pm.observer });
          broadcast(sId, { type: 'complete', runId, steps: ordinal, craftGapIssues, craftGapFindings, editorialCheckErrors, editorialCheckErroredIds, selfImprove: pm.selfImprove, observer: pm.observer, completedAt: new Date().toISOString() });
          console.log(`✅ autopilot complete — series=${sId.slice(0, 12)} steps=${ordinal}${craftGapIssues ? ` (${craftGapIssues} issue(s) with filed script-craft gaps)` : ''}${editorialCheckErrors ? ` (${editorialCheckErrors} editorial check(s) errored: ${editorialCheckErroredIds.join(', ')})` : ''}`);
          return;
        }

        // Budget gate (mirrors cosJobScheduler) — pause when today's cos action
        // budget is exhausted rather than burning past it. The editorialChecks
        // step is exempt from this blanket pre-dispatch gate because it
        // self-gates: runEditorialChecksPass only pauses/bills the budget when an
        // enabled LLM check will actually run (returning a pause result this loop
        // still handles), so a deterministic-only or all-disabled checks step can
        // complete a text-ready series even with the budget exhausted. The
        // editorialHealthGate (#1316) is likewise exempt — it's a pure read +
        // score with no LLM cost, so a budget-exhausted run can still produce its
        // readiness verdict (and pause on the findings, not the budget). The
        // reverseOutline refresh is exempt for the SAME reason as editorialChecks:
        // runReverseOutlineRefresh self-gates (it only calls budgetPause + bills
        // when it will actually regenerate), and it no-ops when no enabled check —
        // narrowed to this run's #1575 subset — consumes the outline. A blanket
        // pre-dispatch pause here would wrongly stall a deterministic-only subset
        // (whose refresh is a guaranteed no-op) on an exhausted budget. A gate
        // whose resolved rounds is 0 ("skip") is also exempt: runArcVerify /
        // runEditorial short-circuit with no LLM spend, so "0 skips the gate" must
        // hold even when the budget is exhausted (otherwise the run pauses on
        // budget instead of skipping).
        const zeroRoundSkip = (step.kind === 'verifyArc' && runOptions.maxArcVerifyRounds === 0)
          || (step.kind === 'beatContinuity' && runOptions.maxBeatContinuityRounds === 0)
          || (step.kind === 'editorialReview' && runOptions.maxEditorialRounds === 0)
          || (step.kind === 'foundationGate' && (runOptions.maxFoundationRounds === 0 || runOptions.foundationGate === false));
        const selfGatingStep = step.kind === 'editorialChecks'
          || step.kind === 'editorialHealthGate'
          || step.kind === 'reverseOutline';
        // Distinct from the self-gating steps (which bill, but decide for
        // themselves when): `unlockLocks` makes no LLM call and bills nothing at
        // all — it only clears lock bits — so pausing it on an exhausted budget
        // would strand the run before its first real step for zero spend.
        const costFreeStep = step.kind === 'unlockLocks';
        if (!selfGatingStep && !costFreeStep && !zeroRoundSkip) {
          const budget = await getDomainBudgetStatus('cos');
          if (!budget.withinBudget) {
            const budgetReason = `daily cos ${budget.exceeded} budget reached`;
            await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, lastError: budgetReason });
            broadcast(sId, { type: 'paused', runId, reason: budgetReason, completedAt: new Date().toISOString() });
            await notifyPause(record, sId, { reason: budgetReason, pauseKind: 'budget', currentStep: step.kind });
            console.log(`⏸️  autopilot paused (budget) — series=${sId.slice(0, 12)} after ${ordinal} steps`);
            return;
          }
        }

        ordinal += 1;
        await persistMarker(sId, { status: 'running', runId, currentStep: step.kind });
        broadcast(sId, { type: 'step:start', kind: step.kind, seasonId: step.seasonId, issueId: step.issueId, ordinal, reason: step.reason });

        const result = await dispatchStep(sId, step, record);

        if (result?.canceled || record.cancelRequested) break;
        if (result?.pause) {
          // Diagnose the automation BEFORE the terminal frame so the verdict
          // rides it (a client tears its stream down on `paused`). No-ops unless
          // the run opted into self-improvement.
          const pm = await postMortem('paused', `${step.kind}: ${result.reason}`);
          await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, residualFindings: result.residual || [], lastError: result.reason, pauseKind: result.pauseKind || null, healthBreakdown: result.healthBreakdown || null, selfImprove: pm.selfImprove, observer: pm.observer });
          broadcast(sId, { type: 'paused', runId, scope: step.kind, reason: result.reason, residualFindings: result.residual || [], pauseKind: result.pauseKind || null, healthBreakdown: result.healthBreakdown || null, selfImprove: pm.selfImprove, observer: pm.observer, completedAt: new Date().toISOString() });
          await notifyPause(record, sId, { reason: result.reason, pauseKind: result.pauseKind || null, currentStep: step.kind });
          // Only file the generic stalled task when the step didn't already file
          // a more specific gap (canon-undescribed, visual-no-pages, …) — else
          // fileGaps would create two CoS tasks for one underlying problem (the
          // differing gapKind defeats addTask's first-line dedup).
          if (!result.gapFiled) {
            await fileGap(record, sId, {
              gapKind: `${step.kind}-stalled`,
              issueId: step.issueId || null,
              summary: `Autopilot paused: ${result.reason}. Needs human review of the residual findings before it can continue.`,
              context: JSON.stringify(result.residual || []).slice(0, 1000),
            });
          }
          console.log(`⏸️  autopilot paused (${step.kind}) — series=${sId.slice(0, 12)}: ${result.reason}`);
          return;
        }
        broadcast(sId, { type: 'step:complete', kind: step.kind, seasonId: step.seasonId, issueId: step.issueId, ordinal });
        observeStep(step);
      }

      // Cancelled. No post-mortem (nothing to explain), but an in-flight
      // observer pass must still land before the terminal frame.
      await observerIdle();
      await persistMarker(sId, { status: 'paused', runId, currentStep: null, lastError: 'canceled by user' });
      broadcast(sId, { type: 'canceled', runId, steps: ordinal, completedAt: new Date().toISOString() });
      console.log(`🛑 autopilot canceled — series=${sId.slice(0, 12)} after ${ordinal} steps`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ autopilot failed — series=${sId.slice(0, 12)} ${message}`);
      // Same ordering as the other terminals: diagnose first so the verdict can
      // ride the `error` frame + marker rather than arriving after the client
      // has torn its stream down.
      const pm = await postMortem('error', message);
      await persistMarker(sId, { status: 'error', runId, lastError: message, selfImprove: pm.selfImprove, observer: pm.observer });
      broadcast(sId, { type: 'error', runId, error: message, selfImprove: pm.selfImprove, observer: pm.observer, failedAt: new Date().toISOString() });
      await fileGap(record, sId, {
        gapKind: 'run-error',
        summary: `The autonomous run failed and stopped: ${message}`,
        context: message,
      }).catch(() => {});
    } finally {
      record.finished = true;
      scheduleCleanup(sId, record);
    }
  })();

  return { runId, alreadyRunning: false, mode };
}

/**
 * Boot-time recovery: the in-memory run map is lost on restart, so any series
 * whose persisted marker still says `running` is demoted to `paused` (the user
 * can click Run to resume from the next missing step). Mirrors
 * recoverStuckAutoRuns in autoRunner.js. Best-effort; never blocks boot.
 */
export async function recoverStuckAutopilots() {
  const { listSeries } = await import('../series.js');
  const all = await listSeries().catch(() => []);
  const stuck = all.filter((s) => s.autopilot?.status === 'running');
  if (stuck.length === 0) return 0;
  for (const s of stuck) {
    await updateSeries(s.id, {
      autopilot: { ...s.autopilot, status: 'paused', lastError: 'interrupted by server restart', updatedAt: new Date().toISOString() },
    }).catch(() => null);
  }
  console.log(`📝 autopilot: recovered ${stuck.length} stuck run${stuck.length === 1 ? '' : 's'} on boot`);
  return stuck.length;
}
