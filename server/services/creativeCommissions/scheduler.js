/**
 * Creative Commission scheduler (#2657, Phase 1 — Autonomous Creation Engine).
 *
 * A per-commission cron that fires the Creative Director's directive pipeline on
 * the user's cadence. Modeled directly on `seriesAutopilotScheduler.js`:
 *   - one eventScheduler cron per enabled commission (id namespace below),
 *   - a `registered` set + `lastSignature` guard so re-syncs are cheap no-ops,
 *   - a fire handler that runs OUTSIDE the Express request lifecycle (whole body
 *     in try/catch — a throw here would crash the process),
 *   - re-reads the commission + autonomy config on every fire (only the cron is
 *     captured at registration).
 *
 * Cold-bootstrap compliance (AGENTS.md AI Provider Usage Policy): a commission is
 * a user-configured scheduled automation — the sanctioned exception. `start…()`
 * only ARMS crons; nothing fires until the cadence elapses. The fire handler
 * additionally gates on creative autonomy mode === 'execute' AND the daily cos
 * budget, so an `off`/`dry-run` install (or an over-budget one) generates nothing
 * and simply records a skipped run.
 *
 * Commissions are machine-local (not federated), so — unlike series autopilot —
 * the scheduler re-syncs when the commission STORE changes (routes call
 * `syncCommissionSchedules` after a mutation), not on settings:updated.
 */

import { schedule, cancel, isValidCron, isValidRecurrence } from '../eventScheduler.js';
import { getUserTimezone } from '../userTimezone.js';
import { getSettings, settingsEvents } from '../settings.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { renderTargetDefaults } from '../imageGen/cloudProviderConfig.js';
import { resolveVideoMode, VIDEO_GEN_MODE } from '../videoGen/modes.js';
import { listCommissions, getCommission, recordCommissionRun, commissionEvents } from './store.js';
import { commissionToCron, commissionToRecurrence } from './directive.js';
import { buildCommissionDirective, getAbilityAdapter } from './abilityAdapters.js';
import { buildMusicTasteRecipe } from './musicTasteRecipe.js';
import { surfaceCommissionRun } from './surface.js';
import { registerCommissionProjectReconciler } from './projectControl.js';

const eventId = (commissionId) => `creative-commission-${commissionId}`;
const registered = new Set();
let lastSignature = null;
let syncTail = Promise.resolve(); // serializes concurrent re-syncs (see syncCommissionSchedules)

function triggerResync() {
  syncCommissionSchedules().catch((err) =>
    console.error(`❌ Creative commission schedule re-sync failed: ${err.message}`));
}

// Re-arm crons whenever a commission is created/updated/deleted through ANY
// writer, not just the REST route — decoupled from the HTTP handler.
commissionEvents.on('commission:changed', triggerResync);
// Cancelling the cron only stops FUTURE fires. projectControl owns the other half
// — reconciling the work a commission ALREADY spawned when it is paused, deleted,
// or re-providered. Registered from here because this module is already the one
// the boot sequence pulls in; the logic itself stays out of the cron concern.
registerCommissionProjectReconciler();
// Also re-sync on a settings save so a global timezone change re-registers the
// crons of commissions that use the fallback tz (schedule.timezone == null) —
// same reason seriesAutopilotScheduler subscribes here. The signature guard
// makes an unrelated settings save a cheap no-op.
settingsEvents.on('settings:updated', triggerResync);

/**
 * Enabled commissions whose schedule composes into a cron the scheduler honors.
 * Pure over the passed-in list.
 */
export function activeCommissions(commissions) {
  const out = [];
  for (const c of commissions || []) {
    if (!c || c.enabled === false || !c.id) continue;
    const recurrence = commissionToRecurrence(c.schedule);
    if (recurrence) {
      if (!isValidRecurrence(recurrence)) continue;
      out.push({ id: c.id, recurrence, timezone: c.schedule?.timezone || null });
      continue;
    }
    const cron = commissionToCron(c.schedule);
    if (!cron || !isValidCron(cron)) continue;
    out.push({ id: c.id, cron, timezone: c.schedule?.timezone || null });
  }
  return out;
}

function signatureOf(active, fallbackTz) {
  return JSON.stringify({
    tz: fallbackTz || null,
    s: active.map((e) => [e.id, e.cron || null, e.recurrence || null, e.timezone]),
  });
}

function registerSchedule(entry, timezone) {
  // Resilient: a bad stored cron/timezone (e.g. a hand-edited record) throws in
  // eventScheduler.schedule → Intl.DateTimeFormat; swallow it per-entry so one
  // bad commission can't abort the whole sync loop and strand the others.
  try {
    schedule({
      id: eventId(entry.id),
      type: entry.recurrence ? 'recurrence' : 'cron',
      cron: entry.cron,
      recurrence: entry.recurrence,
      timezone: entry.timezone || timezone,
      handler: () => runScheduledCommission(entry.id),
      metadata: { source: 'creativeCommissionScheduler', commissionId: entry.id },
    });
    registered.add(entry.id);
  } catch (err) {
    console.error(`❌ Creative commission ${entry.id} cron registration failed: ${err.message}`);
  }
}

/**
 * (Re)sync the registered crons to the current commission set. Idempotent and
 * safe at boot and after every store mutation. The signature guard makes an
 * unrelated re-sync a cheap no-op.
 *
 * Serialized on a single tail promise: a settings save and a commission
 * mutation can fire concurrently, and two syncs with different snapshots
 * interleaving their mutations of `registered`/`lastSignature` could cancel a
 * still-enabled commission's cron. Chaining guarantees each sync sees a
 * consistent view (a re-entrancy guard, fine under the single-user model).
 */
export function syncCommissionSchedules(commissions) {
  syncTail = syncTail.then(() => doSyncCommissionSchedules(commissions), () => doSyncCommissionSchedules(commissions));
  return syncTail;
}

async function doSyncCommissionSchedules(commissions) {
  const list = commissions || await listCommissions().catch(() => []);
  const active = activeCommissions(list);
  const timezone = await getUserTimezone().catch(() => 'UTC');

  const signature = signatureOf(active, timezone);
  if (signature === lastSignature) return active.length;
  lastSignature = signature;

  const activeIds = new Set(active.map((e) => e.id));
  for (const id of [...registered]) {
    if (!activeIds.has(id)) { cancel(eventId(id)); registered.delete(id); }
  }
  for (const entry of active) registerSchedule(entry, timezone);
  return active.length;
}

/** Boot entry point — arms crons for existing commissions. Fires nothing now. */
export async function startCommissionScheduler() {
  return syncCommissionSchedules();
}

/** Cancel every registered cron (test teardown / shutdown). */
export function stopCommissionScheduler() {
  for (const id of [...registered]) { cancel(eventId(id)); registered.delete(id); }
  lastSignature = null;
}

/**
 * A scheduled cron tick. Runs outside the Express request lifecycle — every
 * throwable path is contained (getCommission is caught here, everything else
 * inside fireCommission), so a fire can't crash Node. Skips silently when the
 * commission vanished, was paused, or its schedule became invalid since
 * registration.
 */
export async function runScheduledCommission(commissionId) {
  const commission = await getCommission(commissionId).catch(() => null);
  if (!commission || commission.enabled === false) return;

  const recurrence = commissionToRecurrence(commission.schedule);
  const cron = commissionToCron(commission.schedule);
  if (recurrence ? !isValidRecurrence(recurrence) : (!cron || !isValidCron(cron))) return; // schedule became invalid since registration

  await fireCommission(commission, 'schedule');
}

/**
 * A user-initiated "Run Now" fire (the route's test button). Runs the SAME
 * gated fire path as a cron tick — so it's an end-to-end test of exactly what
 * the schedule will do — but deliberately skips the `enabled` and cron-validity
 * guards: a paused or half-configured commission is still testable. The
 * autonomy/budget gates stay: the downstream plan steps are gated on them in
 * `dispatchCreativeTool` anyway, so bypassing them here would only strand a
 * dead project — a skipped outcome with the reason is the honest test result.
 *
 * Throws ERR_NOT_FOUND (→404 via the route's error mapper) for an unknown id;
 * every other failure is recorded on the run history and returned as an outcome.
 */
export async function runCommissionNow(commissionId) {
  const commission = await getCommission(commissionId);
  return fireCommission(commission, 'manual');
}

// Source reads are intentionally lazy and machine-local. The recipe receives
// only the bounded stated summary and observed rollup; raw Digital Twin answers,
// Spotify caches, and activity events never enter a commission record or CD
// project. A source read failure is treated exactly like absent taste data so an
// opted-in commission records an explicit skip instead of generating generically.
async function resolveMusicTasteRecipe(commission) {
  const config = commission?.targetAbility === 'music' ? commission?.brief?.musicTaste : null;
  if (!config) return null;
  const [profile, observed] = await Promise.all([
    import('../taste-questionnaire.js')
      .then(({ getTasteProfile }) => getTasteProfile())
      .catch(() => null),
    import('../twinEnrichment.js')
      .then(({ getTasteEvidence }) => getTasteEvidence())
      .catch(() => null),
  ]);
  const musicSection = profile?.sections?.find((section) => section?.id === 'music');
  return buildMusicTasteRecipe({
    commissionId: commission.id,
    config,
    stated: {
      summary: musicSection?.summary || null,
      lastSessionAt: profile?.lastSessionAt || null,
    },
    observed,
    feedback: commission.feedback,
    recentRuns: commission.runs,
  });
}

/**
 * The shared fire core. Never throws (callers may be outside the Express
 * request lifecycle — a throw would crash Node). Re-reads the creative autonomy
 * config every fire; gates on execute-mode + budget; then mints a
 * directive-driven CD project and nudges the advance loop (which runs each plan
 * step through the gated `dispatchCreativeTool`). Every path records a run
 * (tagged with its trigger) and returns an outcome:
 *   { status: 'started', projectId, run }
 *   { status: 'skipped', reason, run }
 *   { status: 'failed',  error, run }
 */
async function fireCommission(commission, trigger) {
  const commissionId = commission.id;
  // Hoisted so a throw AFTER createProject succeeded (e.g. the advance kick)
  // still reports the minted project on the failed run/outcome — otherwise a
  // manual caller sees a bare failure, can't find the orphaned CD project, and
  // a retry mints a duplicate.
  let startedProjectId = null;
  let startedTasteRecipe = null;
  let startedMusicGeneration = null;
  const skip = async (reason) => {
    const run = await recordCommissionRun(commissionId, { status: 'skipped', reason, trigger }).catch(() => null);
    return { status: 'skipped', reason, run };
  };
  try {
    // Gate on creative autonomy mode + daily cos budget BEFORE spawning anything
    // (the planner is itself an LLM call) — honors "off ⇒ no generation" and the
    // no-cold-LLM policy. Both reads FAIL CLOSED: if governance state can't be
    // verified we skip rather than launch a paid planner on a permissive default.
    const [{ loadState }, { getCreativeAutonomyMode }, { getDomainBudgetStatus }] = await Promise.all([
      import('../cosState.js'),
      import('../../lib/domainAutonomy.js'),
      import('../domainUsage.js'),
    ]);
    const state = await loadState().catch(() => null);
    if (!state) return skip('governance-unavailable');
    const mode = getCreativeAutonomyMode(state.config);
    if (mode !== 'execute') return skip(`autonomy-${mode}`);
    const budget = await getDomainBudgetStatus('cos').catch(() => null);
    if (!budget) return skip('budget-unavailable');
    if (!budget.withinBudget) return skip('budget');

    // Resolve the output-type adapter (#2769). Every supported type (video,
    // image, music, music-video, series) has one; an unknown ability (a
    // hand-edited or forward-version record the store sanitizer couldn't clamp)
    // is skipped rather than mis-generated as a video.
    const abilityAdapter = getAbilityAdapter(commission.targetAbility);
    if (!abilityAdapter) return skip('unknown-ability');

    const tasteResult = await resolveMusicTasteRecipe(commission);
    if (tasteResult?.status === 'unavailable') return skip(tasteResult.reason);
    startedTasteRecipe = tasteResult?.recipe || null;
    if (startedTasteRecipe) {
      const { resolveMusicEngineSelection } = await import('../musicEngineCatalog.js');
      const engineResult = await resolveMusicEngineSelection({
        engineId: commission.brief.musicTaste.musicEngineId,
        modelId: commission.brief.musicTaste.musicModelId,
      }).catch(() => ({ status: 'unavailable', reason: 'music-engine-unavailable' }));
      if (engineResult.status !== 'ready') return skip(engineResult.reason);
      startedMusicGeneration = {
        ...engineResult.selection,
        durationSec: commission.generation.lengthSeconds,
      };
    }

    // NOTE: we deliberately do NOT pre-charge the cos budget here. The planner
    // spawns as a normal CoS agent (a `cd-` task) and is accounted by
    // `completeAgent` → `recordDomainUsage('cos', { actions: 1 })` on completion,
    // so a pre-charge would double-count. A hard concurrency/budget admission for
    // the planner (routing it through dequeueNextTask instead of the direct
    // task:ready emit shared with the CD directive flow) is the deeper CoS-queue
    // gap tracked on #2657.
    const [{ createProject }, { advanceAfterPlanStepSettled }, { defaultVideoModelId }] = await Promise.all([
      import('../creativeDirector/local.js'),
      import('../creativeDirector/planAdvance.js'),
      import('../videoGen/local.js'),
    ]);

    const settings = (commission.targetAbility === 'video' || commission.targetAbility === 'music-video')
      ? await getSettings().catch(() => ({}))
      : {};
    const requestedVideoMode = commission.generation?.videoMode === 'auto'
      ? null : commission.generation?.videoMode;
    const effectiveVideoMode = (commission.targetAbility === 'video' || commission.targetAbility === 'music-video')
      ? resolveVideoMode(requestedVideoMode, settings, { target: RENDER_TARGET.CREATIVE_AGENT })
      : VIDEO_GEN_MODE.LOCAL;
    const effectiveVideoModelId = effectiveVideoMode === VIDEO_GEN_MODE.LOCAL
      ? renderTargetDefaults(settings, RENDER_TARGET.CREATIVE_AGENT).videoModel
      : null;
    const directive = buildCommissionDirective(commission, {
      tasteRecipe: startedTasteRecipe,
      defaultVideoModelId,
      effectiveVideoMode,
      effectiveVideoModelId,
    });
    // createProject prefixes "Creative Director: " (19 chars) before a
    // mediaCollections name capped at 80, so cap our derived name at 61 — a long
    // commission name would otherwise fail the collection create on every run.
    const dateSuffix = ` — ${new Date().toISOString().slice(0, 10)}`; // 13 chars
    const maxBase = 61 - dateSuffix.length;
    const baseName = commission.name.length > maxBase
      ? `${commission.name.slice(0, maxBase - 1)}…`
      : commission.name;
    // Per-ability project params (#2769): each output type maps its generation
    // knobs onto createProject's render settings. Non-video types pass harmless
    // geometry defaults (the planner only forces that geometry onto video render
    // steps) and let their directive drive the non-video tools.
    const projectParams = abilityAdapter.buildProjectParams(commission, { defaultVideoModelId });
    const project = await createProject({
      name: `${baseName}${dateSuffix}`,
      ...projectParams,
      styleSpec: commission.brief?.styleSpec || '',
      directive,
      // The back-pointer, NOT a copy of the commission's provider pin. agentBridge
      // resolves that pin live from this id at every dispatch, so an edit to the
      // commission reaches a project already in flight; a snapshot written here
      // would freeze the provider for the life of the project. It is also how
      // pause/delete finds this project in order to stop it.
      commissionId,
    });

    startedProjectId = project.id;
    const run = await recordCommissionRun(commissionId, {
      status: 'started',
      trigger,
      projectId: project.id,
      promptUsed: directive.goal,
      ...(startedTasteRecipe ? { tasteRecipe: startedTasteRecipe } : {}),
      ...(startedMusicGeneration ? { musicGeneration: startedMusicGeneration } : {}),
    }).catch(() => null);
    // A taste-aware audio enqueue resolves its authoritative prompt/renderer
    // from this local run. If the write failed, advancing would make that lookup
    // look legitimately absent and silently release planner defaults instead.
    if (startedTasteRecipe && !run) throw new Error('taste-run-persistence-unavailable');

    // Surface the fire (notification + brain inbox) so the user can rate the
    // result once it lands — the reaction feeds the next run via
    // buildCommissionDirective. Best-effort; surface.js swallows its own errors,
    // and the outer catch backstops anything unexpected (we're outside the
    // request lifecycle). Only surface real runs (a run row was persisted).
    if (run) await surfaceCommissionRun(commission, run).catch(() => {});

    // Kick the planner → plan → execute loop. Fire-and-forget within this
    // try/catch (already outside the request lifecycle).
    await advanceAfterPlanStepSettled(project.id);
    return { status: 'started', projectId: project.id, run };
  } catch (err) {
    console.error(`❌ Creative commission ${commissionId} ${trigger} fire failed: ${err?.message || err}`);
    const error = err?.message || String(err);
    const run = await recordCommissionRun(commissionId, {
      status: 'failed', error, trigger, projectId: startedProjectId,
      ...(startedTasteRecipe ? { tasteRecipe: startedTasteRecipe } : {}),
      ...(startedMusicGeneration ? { musicGeneration: startedMusicGeneration } : {}),
    }).catch(() => null);
    return { status: 'failed', error, projectId: startedProjectId, run };
  }
}
