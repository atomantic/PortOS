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
 * Cold-bootstrap compliance (CLAUDE.md AI Provider Usage Policy): a commission is
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

import { schedule, cancel, isValidCron } from '../eventScheduler.js';
import { getUserTimezone } from '../../lib/timezone.js';
import { listCommissions, getCommission, recordCommissionRun, commissionEvents } from './store.js';
import { commissionToCron, buildCommissionDirective } from './directive.js';

const eventId = (commissionId) => `creative-commission-${commissionId}`;
const registered = new Set();
let lastSignature = null;

// Re-arm crons whenever a commission is created/updated/deleted through ANY
// writer, not just the REST route — mirrors seriesAutopilotScheduler's
// `settings:updated` subscription. The signature guard makes an unrelated
// change a cheap no-op.
commissionEvents.on('commission:changed', () => {
  syncCommissionSchedules().catch((err) =>
    console.error(`❌ Creative commission schedule re-sync failed: ${err.message}`));
});

/**
 * Enabled commissions whose schedule composes into a cron the scheduler honors.
 * Pure over the passed-in list.
 */
export function activeCommissions(commissions) {
  const out = [];
  for (const c of commissions || []) {
    if (!c || c.enabled === false || !c.id) continue;
    const cron = commissionToCron(c.schedule);
    if (!cron || !isValidCron(cron)) continue;
    out.push({ id: c.id, cron, timezone: c.schedule?.timezone || null });
  }
  return out;
}

function signatureOf(active, fallbackTz) {
  return JSON.stringify({
    tz: fallbackTz || null,
    s: active.map((e) => [e.id, e.cron, e.timezone]),
  });
}

function registerSchedule(entry, timezone) {
  schedule({
    id: eventId(entry.id),
    type: 'cron',
    cron: entry.cron,
    timezone: entry.timezone || timezone,
    handler: () => runScheduledCommission(entry.id),
    metadata: { source: 'creativeCommissionScheduler', commissionId: entry.id },
  });
  registered.add(entry.id);
}

/**
 * (Re)sync the registered crons to the current commission set. Idempotent and
 * safe at boot and after every store mutation. The signature guard makes an
 * unrelated re-sync a cheap no-op.
 */
export async function syncCommissionSchedules(commissions) {
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
 * The fire handler. Runs outside the Express request lifecycle, so the whole
 * body is wrapped — a throw here would crash Node. Re-reads the commission and
 * the creative autonomy config every fire; gates on execute-mode + budget; then
 * mints a directive-driven CD project and nudges the advance loop (which runs
 * each plan step through the gated `dispatchCreativeTool`).
 */
export async function runScheduledCommission(commissionId) {
  try {
    const commission = await getCommission(commissionId).catch(() => null);
    if (!commission || commission.enabled === false) return;

    const cron = commissionToCron(commission.schedule);
    if (!cron || !isValidCron(cron)) return; // schedule became invalid since registration

    // Gate on creative autonomy mode + daily cos budget BEFORE spawning anything
    // (the planner is itself an LLM call) — honors "off ⇒ no generation" and the
    // no-cold-LLM policy.
    const [{ loadState }, { getCreativeAutonomyMode }, { getDomainBudgetStatus }] = await Promise.all([
      import('../cosState.js'),
      import('../../lib/domainAutonomy.js'),
      import('../domainUsage.js'),
    ]);
    const state = await loadState().catch(() => ({ config: {} }));
    const mode = getCreativeAutonomyMode(state.config);
    if (mode !== 'execute') {
      await recordCommissionRun(commissionId, { status: 'skipped', reason: `autonomy-${mode}` }).catch(() => {});
      return;
    }
    const budget = await getDomainBudgetStatus('cos').catch(() => ({ withinBudget: true }));
    if (!budget.withinBudget) {
      await recordCommissionRun(commissionId, { status: 'skipped', reason: 'budget' }).catch(() => {});
      return;
    }

    // Phase 1 supports video only. A non-video commission can't be created via
    // the UI (schema restricts the enum), but a hand-edited record is possible.
    if (commission.targetAbility !== 'video') {
      await recordCommissionRun(commissionId, { status: 'skipped', reason: 'unsupported-ability' }).catch(() => {});
      return;
    }

    const [{ createProject }, { advanceAfterPlanStepSettled }, { defaultVideoModelId }] = await Promise.all([
      import('../creativeDirector/local.js'),
      import('../creativeDirector/planAdvance.js'),
      import('../videoGen/local.js'),
    ]);

    const directive = buildCommissionDirective(commission);
    const gen = commission.generation || {};
    const project = await createProject({
      name: `${commission.name} — ${new Date().toISOString().slice(0, 10)}`,
      aspectRatio: gen.aspectRatio || '16:9',
      quality: gen.quality || 'standard',
      modelId: gen.model || defaultVideoModelId(),
      targetDurationSeconds: gen.targetDurationSeconds || 10,
      styleSpec: commission.brief?.styleSpec || '',
      directive,
    });

    await recordCommissionRun(commissionId, {
      status: 'started',
      projectId: project.id,
      promptUsed: directive.goal,
    }).catch(() => {});

    // Kick the planner → plan → execute loop. Fire-and-forget within this
    // try/catch (already outside the request lifecycle).
    await advanceAfterPlanStepSettled(project.id);
  } catch (err) {
    console.error(`❌ Creative commission ${commissionId} fire failed: ${err?.message || err}`);
    await recordCommissionRun(commissionId, { status: 'failed', error: err?.message || String(err) }).catch(() => {});
  }
}
