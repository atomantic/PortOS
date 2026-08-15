/**
 * Series Autopilot — run session plumbing (#2842 split of seriesAutopilot.js):
 * SSE client attach/broadcast, cancellation, cleanup, the persisted run marker,
 * CoS gap filing, pause notifications, provider option shaping and the budget gate.
 */

import { attachSseClient, broadcastSse, SSE_CLEANUP_DELAY_MS } from '../../../lib/sseUtils.js';
import * as cosTaskStore from '../../cosTaskStore.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../../domainUsage.js';
import { addNotification, removeByMetadata, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../../notifications.js';
import { getSeries, updateSeries } from '../series.js';
import * as volumeBeatsRunner from '../volumeBeatsRunner.js';
import * as autoRunner from '../autoRunner.js';
import { patchRunMetadata, stopRun } from '../../runner.js';
import { runs, autopilotEvents, noteSignal, noteProgress, snapshotProgress } from './state.js';

// ---------------------------------------------------------------------------
// Run registry helpers (mirror editorialAnalysisRunner.js).
// ---------------------------------------------------------------------------

export function isAutopilotActive(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished;
}

export function isAutopilotPauseRequested(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished && run.pauseRequested === true;
}

// The `start` frame of an IN-FLIGHT run (null when none is active). Everything
// a client needs to describe a run it didn't watch begin — mode (the dry-run
// badge), target, the resolved run provider/model — lives on that frame, but
// attachSseClient replays only the LAST payload, so a client attaching mid-run
// never sees it. Kept whole (rather than rescuing one field at a time through
// bespoke status keys) so a new start-frame field needs no new plumbing.
export function activeRunStart(seriesId) {
  const run = runs.get(seriesId);
  if (!run || run.finished) return null;
  return run.startPayload || null;
}

// The live progress snapshot of an IN-FLIGHT run (null when none is active) —
// the milestone map's cursor: completed counts per step kind, the step running
// now, and what each gate last verified. Same object the `progress` frame
// carries, so a client attaching mid-run starts from the run's real position
// instead of an empty map.
export function activeRunProgress(seriesId) {
  const run = runs.get(seriesId);
  if (!run || run.finished) return null;
  return snapshotProgress(run);
}

export function attachClient(seriesId, res) {
  return attachSseClient(runs, seriesId, res);
}

export function cancelSeriesAutopilot(seriesId) {
  const run = runs.get(seriesId);
  if (!run || run.finished) return false;
  run.cancelRequested = true;
  // Emit an immediate acknowledgement frame so the UI can switch to a
  // "cancelling…" state right away. Cancellation is cooperative and checked
  // between steps (the terminal `canceled` frame follows once the active
  // step/LLM call returns) — without this ack the user sees no feedback until
  // the loop unwinds, which can be the length of a long in-flight LLM call (#1617).
  broadcastSse(run, { type: 'cancel:acknowledged', runId: run.runId, requestedAt: new Date().toISOString() });
  // Propagate to the currently-delegated child so cancel is responsive
  // mid-step instead of only between steps.
  const child = run.activeChild;
  if (child?.kind === 'beats') volumeBeatsRunner.cancelVolumeBeatsRun(child.id);
  else if (child?.kind === 'text') autoRunner.cancelAutoRun(child.id);
  // Direct staged-LLM steps (arc, episode plan, foundation judge/repair) do
  // not have a delegated child coordinator. Stop their concrete run too; the
  // prompt runner reports fallback run ids through the same lifecycle hook.
  if (run.activeLlmRunId) {
    stopRun(run.activeLlmRunId).catch((err) => {
      console.log(`⚠️ autopilot: active LLM stop failed for ${seriesId.slice(0, 12)}: ${err.message}`);
    });
  }
  return true;
}

// Graceful control for quality-first runs: finish the current top-level step
// (and any provisional repair + independent verification transaction inside
// it), then persist a resumable pause. Unlike Cancel this deliberately does not
// stop the active provider run or delegated child.
export function pauseSeriesAutopilot(seriesId) {
  const run = runs.get(seriesId);
  if (!run || run.finished) return false;
  run.pauseRequested = true;
  broadcastSse(run, {
    type: 'pause:acknowledged',
    runId: run.runId,
    requestedAt: new Date().toISOString(),
  });
  return true;
}

function emitFrame(run, seriesId, payload, sseOpts) {
  broadcastSse(run, payload, sseOpts);
  // Retain the diagnosable frames for the opt-in self-improvement pass. A single
  // tap here (rather than instrumenting each step runner) means any telemetry
  // frame a future step emits is diagnosable evidence for free. No-op unless the
  // run opted in — see state.js#noteSignal (it lives with the run registry it
  // mutates, which is what keeps selfImprove.js out of this module's imports).
  noteSignal(run, payload);
  // Mirror every frame onto the in-process bus (CDO Phase 3, #2185) so a
  // server-side consumer (CD plan step) sees the same progress/pause/terminal
  // frames as an SSE client. Emit is best-effort — a listener throw must never
  // abort the run (this runs inside the fire-and-forget coordinator).
  try {
    autopilotEvents.emit(seriesId, payload);
  } catch (err) {
    console.log(`⚠️ autopilot: event emit failed for ${seriesId.slice(0, 12)}: ${err.message}`);
  }
}

export function broadcast(seriesId, payload) {
  const run = runs.get(seriesId);
  if (!run) return;
  emitFrame(run, seriesId, payload);
  // Milestone map: fold the frame into the run's progress snapshot and, when it
  // moved, follow it with the snapshot itself. Emitted as its own frame (rather
  // than stamped onto every frame) so the existing frame shapes — and the
  // diagnosis evidence read off them — are untouched, and NOT retained for SSE
  // replay: it follows nearly every meaningful frame, so retaining it would take
  // the single replay slot and leave a late-attaching client with a snapshot
  // instead of the frame that says what the run is doing. That client reads the
  // same snapshot off the status route.
  if (noteProgress(run, payload)) {
    emitFrame(run, seriesId, { type: 'progress', runId: run.runId, ...snapshotProgress(run) }, { retain: false });
  }
}

// Broadcast the run's `start` frame AND retain it on the run record, so a
// client attaching mid-run can still read it back via `activeRunStart`.
export function broadcastStart(seriesId, payload) {
  const run = runs.get(seriesId);
  if (run) run.startPayload = payload;
  broadcast(seriesId, payload);
}

export function scheduleCleanup(seriesId, record) {
  record.cleanupTimer = setTimeout(() => {
    if (runs.get(seriesId) !== record) return;
    for (const c of record.clients) c.end();
    runs.delete(seriesId);
  }, SSE_CLEANUP_DELAY_MS);
}

// Thin persisted marker for resume/paused UI + boot recovery. NOT a step
// cursor — see module header. Best-effort; a marker write must never abort a run.
export async function persistMarker(seriesId, patch) {
  const run = runs.get(seriesId);
  const resumable = ['running', 'paused', 'error'].includes(patch.status) && run?.options
    ? {
      includeVisual: run.options.includeVisual !== false,
      fileGaps: run.options.fileGaps === true,
      ...(run.options.providerOverride ? { providerOverride: run.options.providerOverride } : {}),
      ...(run.options.modelOverride ? { modelOverride: run.options.modelOverride } : {}),
      ...(run.options.effortOverride ? { effortOverride: run.options.effortOverride } : {}),
      ...(run.options.judgeLlm ? { judgeLlm: run.options.judgeLlm } : {}),
      ...(run.options.stageLlm ? { stageLlm: run.options.stageLlm } : {}),
      autoSelectModels: run.options.autoSelectModels === true,
      overrideStagePins: run.options.overrideStagePins === true,
    }
    : null;
  // Milestone map (#4140). Both halves the Autonomous card draws it from live
  // ONLY on the in-memory run record — the projected plan on the retained
  // `start` frame, and the progress snapshot folded onto the record — so a run
  // that paused overnight came back as a resume banner with no map beside it.
  // Carry them on the marker, which outlives the run.
  //
  // Stamped on EVERY marker write that has a plan, not only the terminals: the
  // marker is wholesale-replaced per write, so a terminals-only stamp would
  // leave the map missing for the one interruption that skips a terminal write
  // entirely — a hard restart, whose `running` marker the boot recovery demotes
  // to `paused` by spreading whatever the marker already held. The plan is ~20
  // small rows and the snapshot is keyed by the same step vocabulary, so this
  // costs a couple of KB on a series record that is already tens.
  const plan = Array.isArray(run?.startPayload?.plan) ? run.startPayload.plan : null;
  const progress = plan ? snapshotProgress(run) : null;
  await updateSeries(seriesId, {
    autopilot: {
      ...patch,
      ...(resumable ? { resumeOptions: resumable } : {}),
      ...(plan ? { plan } : {}),
      ...(progress ? { progress } : {}),
      updatedAt: new Date().toISOString(),
    },
  }).catch((err) => {
    console.log(`⚠️ autopilot: marker write failed for ${seriesId.slice(0, 12)}: ${err.message}`);
  });
}

// File a CoS task for a capability/quality gap the autopilot can't resolve on
// its own (a script that won't parse, a render that keeps failing, a stalled
// verify, a run-ending error). Opt-in via `options.fileGaps`; never fires in
// dry-run. The first description line is kept STABLE per (series, gapKind,
// issue) so cosTaskStore.addTask's pending/in_progress dedup collapses repeats
// instead of spamming a task per page / per run. Best-effort — a task-store
// failure must never abort the autopilot.
//
// No `app` is passed. `metadata.app` is WORKSPACE ROUTING — it must name a
// record in `data/apps.json` — not a feature tag. These gaps are work on
// PortOS's own pipeline code, so the correct workspace is the PortOS root,
// which is exactly what an absent `app` resolves to. Passing the feature name
// `'pipeline'` made every gap task unrunnable once the #3180 guard landed:
// `prepareAgentWorkspace` refuses to spawn an agent whose app doesn't resolve
// to a repo path, so the task was filed and then blocked at every spawn
// attempt. Same reasoning as the investigation tasks in agentErrorAnalysis.js.
export async function fileGap(record, sId, { gapKind, issueId = null, summary, context = '' }) {
  if (!record.options.fileGaps || record.mode !== 'execute') return;
  const idTag = `series ${sId}${issueId ? ` issue ${issueId}` : ''}`;
  const description = `Autopilot ${gapKind} gap — ${idTag}\n\n${summary}`;
  const result = await cosTaskStore.addTask({
    description,
    context,
    autopilotGapSeriesId: sId,
    autopilotGapKind: gapKind,
  }, 'user')
    .catch((err) => { console.log(`⚠️ autopilot: fileGap (${gapKind}) failed: ${err.message}`); return null; });
  if (result && !result.duplicate) {
    broadcast(sId, { type: 'gap:filed', gapKind, issueId, taskId: result.id });
  }
}

// Pause escalation (#1615): post an in-app notification when a run pauses so the
// user is told actively, not only when they happen to open the status page. The
// SSE `paused` frame still fires for an attached client; this is the persistent
// out-of-band signal for a user who isn't watching. Opt-out via
// `options.notifyOnPause` / the persisted setting (default on); never fires in
// dry-run. Prior pause notifications for this series are cleared first so a
// resume→pause cycle leaves exactly one current banner instead of a stack, and
// the metadata field is series-scoped so removeByMetadata can't touch unrelated
// notifications. Best-effort — a notification failure must never abort the run.
// Drop any pause banner for this series. Called before posting a fresh one (so a
// resume→pause cycle leaves exactly one) AND when a new execute run starts (so a
// run resumed from a pause that then completes/errors doesn't leave a stale
// "paused" banner + dead resume link). Series-scoped metadata so it can't touch
// unrelated notifications. Best-effort.
export async function clearPauseNotice(sId) {
  await removeByMetadata('autopilotPauseSeriesId', sId).catch(() => {});
}

// The gap task's counterpart to clearPauseNotice: retire any gap task still
// QUEUED for this series when a fresh execute run starts.
//
// A gap task is a snapshot of one pause ("needs human review of the residual
// findings before it can continue"). Once a run is moving again that premise is
// void, but nothing used to retire the task — so CoS kept dispatching agents
// against findings the run had already repaired. On this install that burned ten
// agent sessions across two series, each re-fixing what the previous one fixed.
//
// Worse than waste: the resumed run OWNS the fields those findings name (the
// foundation gate repairs worldbuilding/character/craft itself, and the arc gate
// rewrites `arc.summary` + `season.synopsis`), so an agent hand-editing them
// concurrently clobbers the run's own repair.
//
// Self-correcting by construction: the gate re-judges from live content on the
// way past, and re-files a gap with FRESH findings if it still fails. Clearing
// early can only drop a task whose findings are about to be re-derived.
//
// Scoped to `pending` on purpose — an `in_progress` task has an agent attached,
// and flipping it mid-run would strand that agent and re-open the dedup slot.
// Status flip, never deletion, so the retirement federates (the #2619 precedent
// in cosTaskStore.sweepResolvedFailureTasks). Best-effort: this must never
// abort a run.
export async function clearGapTasks(sId) {
  const { tasks = [] } = await cosTaskStore.getUserTasks().catch(() => ({ tasks: [] }));
  // Legacy gap tasks (filed before `autopilotGapSeriesId` existed — every
  // install upgrading into this has some) carry no metadata handle, so fall back
  // to the first line, which fileGap builds deterministically above.
  const isGapFor = (t) => {
    if (t.metadata?.autopilotGapSeriesId) return t.metadata.autopilotGapSeriesId === sId;
    const line = cosTaskStore.firstLine(t.description);
    return line.startsWith('Autopilot ') && line.includes(` gap — series ${sId}`);
  };
  const stale = tasks.filter((t) => t.status === 'pending' && isGapFor(t));
  let retired = 0;
  for (const task of stale) {
    const updated = await cosTaskStore.updateTask(task.id, {
      status: 'completed',
      metadata: {
        resolution: 'auto-expired',
        autoExpiredReason: 'autopilot-resumed',
        autoExpiredAt: new Date().toISOString(),
      },
    }, 'user').catch(() => null);
    if (updated && !updated.error) retired++;
  }
  if (retired > 0) {
    console.log(`🧹 autopilot: retired ${retired} stale gap task(s) for ${sId.slice(0, 12)} on resume`);
  }
  return retired;
}

export async function notifyPause(record, sId, { reason, pauseKind = null, currentStep = null }) {
  if (record.options.notifyOnPause === false || record.mode !== 'execute') return;
  const series = await getSeries(sId).catch(() => null);
  const seriesName = series?.name || 'a series';
  await clearPauseNotice(sId);
  await addNotification({
    type: NOTIFICATION_TYPES.AUTOPILOT_PAUSED,
    title: `Autopilot paused — ${seriesName}`,
    description: reason || 'The run paused and needs human review before it can continue.',
    priority: PRIORITY_LEVELS.HIGH,
    link: `/pipeline/series/${sId}`,
    metadata: { autopilotPauseSeriesId: sId, runId: record.runId, pauseKind, currentStep },
  }).catch((err) => { console.log(`⚠️ autopilot: pause notification failed for ${sId.slice(0, 12)}: ${err.message}`); });
}

// Series Autopilot threads BOTH its run provider AND its run model as SOFT
// defaults, NOT hard overrides — so a deliberate per-stage pin (Prompts page /
// stage-config.json) still wins for that stage, matching what verifyComicScript
// already does (#1514 for provider; #1558 for model). Each run-level value lands
// on stageRunner's soft channel (`providerDefault` tier 3 / `modelDefault`): it
// applies only to UNPINNED stages and soft-falls-through (to the active provider
// / the provider's default model) when unavailable, rather than throwing
// PROVIDER_OVERRIDE_UNAVAILABLE or beating a stage's deliberate pin the way a
// hard override would. For the model dimension "unpinned" means a stage carrying
// only a *tier* value (default/quick/coding/heavy) — the run model overrides the
// tier but still loses to a deliberate explicit-model pin (see
// stageRunner.resolveModelHint). Before #1558 the model was threaded as a hard
// `modelOverride`, which let the run model beat even an explicit stage pin.
//
// The run's reasoning effort (#3641) rides the same soft channel as a third
// dimension: `effortDefault` applies only to stages with no `stage.effort` pin,
// and the runner clamps it to (or drops it for) whatever provider actually runs.
//
// The run's `overrideStagePins` option does NOT change the channels below — the
// values here still come from the per-role/per-stage routes. It only stops
// stageRunner from consulting the stage-config pins that would otherwise
// outrank them (lib/stagePinPolicy.js).
//
// Two shapes because the delegated services disagree on field names: the
// arc/episode/verify passes take `providerDefault`/`modelDefault`; the child
// runners (volumeBeatsRunner, autoRunner) and the `providerId`-style services
// take `providerIdDefault`/`modelIdDefault`. Each maps its incoming defaults to
// stageRunner's `providerDefault`/`modelDefault` at the leaf call while keeping
// its existing hard `providerOverride`/`providerId` + `modelOverride`/`model`
// params untouched for manual route callers.
const inheritLlmRoute = (route, base) => {
  if (!route || typeof route !== 'object') return base;
  const providerOverride = route.providerOverride || base.providerOverride;
  // A model id belongs to its provider. When a route changes provider and
  // leaves model blank, use that provider's default instead of carrying a model
  // across. Same-provider and effort-only routes deliberately inherit it.
  const providerChanged = !!route.providerOverride
    && route.providerOverride !== base.providerOverride;
  return {
    providerOverride,
    modelOverride: route.modelOverride || (providerChanged ? undefined : base.modelOverride),
    effortOverride: route.effortOverride || base.effortOverride,
  };
};

export const roleLlm = (record, role = 'creative') => {
  const options = record?.options || {};
  const base = {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
    effortOverride: options.effortOverride,
  };
  const roleRoute = role === 'judge'
    ? inheritLlmRoute(options.judgeLlm, base)
    : base;
  const stageRoute = options.stageLlm?.[record?.currentStep]?.[role];
  if (stageRoute && typeof stageRoute === 'object' && Object.keys(stageRoute).length > 0) {
    return inheritLlmRoute(stageRoute, roleRoute);
  }
  // Evidence-based routing (`autoSelectModels`) only fills in for a role left
  // ENTIRELY unrouted — read off `roleRoute`, the route this role would
  // otherwise run on, so the rule has one definition and cannot desync from the
  // inheritance above it.
  //
  // That inheritance is the whole point: with no separate judge configured, the
  // judge route IS the run route, so choosing a run provider/model chooses the
  // judge too — which is exactly what the Options panel promises when "Use a
  // separate model for judging and verification" is unchecked. Deriving this
  // from `options.judgeLlm` alone instead left a run that picked ONE
  // provider/model with creation on the chosen route while every judge/verify
  // call (pipeline-arc-verify above all, plus volume verify, the foundation
  // judge and the editorial checks) was silently re-pointed at the learned one.
  // Reading `roleRoute` also covers the run route the series' own `series.llm`
  // supplied (orchestrator.js resolves that into these options before the run
  // starts), so a series that names its provider keeps it here too — and keeps
  // it identically across a pause, since that resolved route is what the resume
  // marker persists.
  const routeChosen = !!(
    roleRoute.providerOverride || roleRoute.modelOverride || roleRoute.effortOverride
  );
  const learned = options.autoSelectModels === true && !routeChosen
    ? options.modelRecommendations?.[record?.currentStep]?.[role]
    : null;
  if (learned) {
    return {
      providerOverride: learned.providerOverride,
      modelOverride: learned.modelOverride,
      effortOverride: learned.effortOverride,
    };
  }
  return roleRoute;
};

const runLifecycle = (record, role) => ({
  onRunCreated: (runId) => {
    record.activeLlmRunId = runId;
    patchRunMetadata(runId, {
      autopilotSystem: 'series',
      autopilotRunId: record.runId || null,
      pipelineStage: record.currentStep || 'unknown',
      pipelineRole: role,
    }).catch(() => {});
    // Close the race where Stop lands after createRun but before provider
    // execution registers its child process.
    if (record.cancelRequested) stopRun(runId).catch(() => {});
  },
  onRunSettled: (runId) => {
    if (record.activeLlmRunId === runId) record.activeLlmRunId = null;
  },
});

export const providerOverrideOpts = (record, role = 'creative') => {
  const llm = roleLlm(record, role);
  return {
    providerDefault: llm.providerOverride,
    modelDefault: llm.modelOverride,
    effortDefault: llm.effortOverride,
    ...runLifecycle(record, role),
  };
};
export const providerIdOpts = (record, role = 'creative') => {
  const llm = roleLlm(record, role);
  return {
    providerIdDefault: llm.providerOverride,
    modelIdDefault: llm.modelOverride,
    effortIdDefault: llm.effortOverride,
    ...runLifecycle(record, role),
    // Multi-candidate draft gate (#2169): bill one cos action per re-roll and stop
    // re-rolling when the daily budget is spent. Only ever invoked by
    // generateStage's runDraftGate on a judgeable stage with draftAttempts > 1 — a
    // no-op for every other stage/run. Check-then-bill so a skipped (budget-out)
    // attempt isn't charged. Returns false to halt further attempts (keep the best
    // so far); true when the attempt may proceed.
    chargeAction: async () => {
      const budget = await getDomainBudgetStatus('cos');
      if (!budget.withinBudget) return false;
      await recordDomainUsage('cos', { actions: 1 });
      return true;
    },
  };
};

// Non-deletion guarantee for every arc-rewriting call this run makes. Once the
// unlock pre-pass has cleared the per-season locks (see ./unlockPass.js), those
// locks can no longer stop an LLM-proposed arc from DROPPING a volume — and
// "unlock so the autopilot can edit" must never become "unlock so it can
// delete". Lives here beside the other record→options fragments so every arc
// path (generateArc, arc auto-resolve, the foundation gate's structure fix)
// spreads the SAME rule instead of each inlining its own copy.
export const seasonPreserveOpts = (record) => ({
  preserveDroppedSeasons: record.options.unlockForRun === true,
});

// Pause result when the cos action budget is exhausted, else null. Used to gate
// EACH billable call inside the multi-call verify/editorial convergence loops —
// the conductor's per-step budget check only fires once before the step, so
// without this a single step could bill several actions past the daily cap.
// gapFiled:true so a budget pause doesn't also file a generic stalled gap
// (mirrors the conductor's own loop-level budget pause, which files none).
export async function budgetPause() {
  const budget = await getDomainBudgetStatus('cos');
  if (budget.withinBudget) return null;
  return { pause: true, gapFiled: true, pauseKind: 'budget', reason: `daily cos ${budget.exceeded || 'actions'} budget reached` };
}
