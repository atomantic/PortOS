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
import { runs, autopilotEvents } from './state.js';

// ---------------------------------------------------------------------------
// Run registry helpers (mirror editorialAnalysisRunner.js).
// ---------------------------------------------------------------------------

export function isAutopilotActive(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished;
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
  return true;
}

export function broadcast(seriesId, payload) {
  const run = runs.get(seriesId);
  if (!run) return;
  broadcastSse(run, payload);
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
  await updateSeries(seriesId, {
    autopilot: { ...patch, updatedAt: new Date().toISOString() },
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
export async function fileGap(record, sId, { gapKind, issueId = null, summary, context = '' }) {
  if (!record.options.fileGaps || record.mode !== 'execute') return;
  const idTag = `series ${sId}${issueId ? ` issue ${issueId}` : ''}`;
  const description = `Autopilot ${gapKind} gap — ${idTag}\n\n${summary}`;
  const result = await cosTaskStore.addTask({ description, context, app: 'pipeline' }, 'user')
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
// Two shapes because the delegated services disagree on field names: the
// arc/episode/verify passes take `providerDefault`/`modelDefault`; the child
// runners (volumeBeatsRunner, autoRunner) and the `providerId`-style services
// take `providerIdDefault`/`modelIdDefault`. Each maps its incoming defaults to
// stageRunner's `providerDefault`/`modelDefault` at the leaf call while keeping
// its existing hard `providerOverride`/`providerId` + `modelOverride`/`model`
// params untouched for manual route callers.
export const providerOverrideOpts = (record) => ({
  providerDefault: record.options.providerOverride,
  modelDefault: record.options.modelOverride,
});
export const providerIdOpts = (record) => ({
  providerIdDefault: record.options.providerOverride,
  modelIdDefault: record.options.modelOverride,
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
  return { pause: true, gapFiled: true, reason: `daily cos ${budget.exceeded || 'actions'} budget reached` };
}
