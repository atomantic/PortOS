/**
 * Scheduled Series Autopilot (#2174)
 *
 * Registers a cron job per user-configured series so a series can progress
 * unattended (autonovel-style overnight runs). This is the AI Provider Usage
 * Policy's sanctioned "scheduled automations" exception — the user explicitly
 * configured each schedule via Settings, naming the provider/model and enabling
 * it (OFF by default), so it may call an AI provider on its own cadence.
 *
 * Design decisions:
 * - **Machine-local, not federated.** Schedules live in `settings.seriesAutopilot`
 *   (settings.json is per-machine and does NOT sync between peers). A schedule on
 *   the federated *series record* would double-run the same series across two sync
 *   peers; storing it in settings keeps execution to the machine that configured it.
 * - **Re-read settings every invocation** (backupScheduler.js pattern): the handler
 *   re-reads `settings.seriesAutopilot`, so `enabled`, provider/model, and the run
 *   options all take effect on the next scheduled run without a restart. The cron
 *   expression itself is captured at registration — so an edited cron needs a
 *   re-sync, which `syncSeriesAutopilotSchedules()` performs (wired into the
 *   settings PUT route) so even a cron change applies without a restart.
 * - **Every autonomy gate still applies.** The handler delegates to
 *   `startSeriesAutopilot`, which rejects when the cos domain is `off`, runs
 *   under the cos daily action budget, and (when `notifyOnPause`) notifies rather
 *   than retrying forever on a convergence pause — the scheduler adds no new
 *   autonomy surface, it only *triggers* the existing one on a timer.
 */

import { schedule, cancel, isValidCron } from './eventScheduler.js';
import { getSettings, settingsEvents } from './settings.js';
import { getSeries } from './pipeline/series.js';
import { startSeriesAutopilot } from './pipeline/seriesAutopilot.js';
import { getUserTimezone } from '../lib/timezone.js';

// eventScheduler id namespace for a per-series cron. One event per seriesId.
const eventId = (seriesId) => `series-autopilot-${seriesId}`;

// seriesIds we currently hold a registered cron for — so a re-sync can cancel
// events whose schedule was removed or disabled since the last registration.
const registered = new Set();

// Signature of the last-synced registration inputs (which series, at what cron
// + timezone). The `settings:updated` subscription fires on EVERY settings save;
// this lets an unrelated save short-circuit instead of re-registering — and
// re-computing next-run for — every series cron. provider/model are excluded
// deliberately: they don't affect registration (the handler re-reads them per run).
let lastSignature = null;

/**
 * Pure extractor: the enabled, cron-valid schedules from a settings snapshot.
 * A schedule needs `enabled === true`, a non-empty `seriesId`, and a cron
 * expression the eventScheduler accepts — anything else is skipped (a disabled
 * or malformed entry simply doesn't register). Deduplicates by seriesId,
 * last-wins, so a hand-edited settings.json with two entries for one series
 * can't register two competing crons.
 * @param {object} settings - a full settings object
 * @returns {Array<object>} the runnable schedule entries
 */
export function activeSchedules(settings) {
  const raw = settings?.seriesAutopilot?.schedules;
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    if (s.enabled !== true) continue;
    if (typeof s.seriesId !== 'string' || !s.seriesId) continue;
    if (typeof s.cron !== 'string' || !isValidCron(s.cron)) continue;
    byId.set(s.seriesId, s);
  }
  return [...byId.values()];
}

/**
 * Map a schedule entry to the options object passed to startSeriesAutopilot.
 * Only forwards the honored subset, dropping absent fields so the autopilot's
 * own per-run → persisted → default resolution still applies to everything the
 * schedule doesn't pin. The schedule stores user-facing `provider`/`model`; the
 * autopilot LLM calls read `providerOverride`/`modelOverride` (the pipeline's
 * provider-override convention), so map them here.
 */
export function runOptionsFor(entry) {
  const opts = {};
  if (entry.provider) opts.providerOverride = entry.provider;
  if (entry.model) opts.modelOverride = entry.model;
  return opts;
}

/**
 * The cron handler for one series. Re-reads settings so a toggle/edit since
 * registration takes effect, re-checks the series still exists, then delegates
 * to startSeriesAutopilot — which owns the autonomy gate (it returns
 * `{ rejected: true }` when the cos domain is `off`), the cos daily action
 * budget, and the notify-on-pause behavior. The scheduler adds no new autonomy
 * surface, so it delegates rather than re-deriving the cos mode (which lives in
 * the cos state, not settings). Runs outside the Express request lifecycle, so
 * it must never throw — a throw here would crash the process (no `next(err)` to
 * bubble to).
 */
async function runScheduledAutopilot(seriesId) {
  try {
    const settings = await getSettings().catch(() => null);
    const entry = activeSchedules(settings).find((s) => s.seriesId === seriesId);
    if (!entry) {
      console.log(`🎬 Series Autopilot scheduler: #${seriesId} disabled/removed since registration — skipping run`);
      return;
    }
    const series = await getSeries(seriesId).catch(() => null);
    if (!series) {
      console.log(`🎬 Series Autopilot scheduler: series ${seriesId} not found — skipping run`);
      return;
    }
    console.log(`🎬 Series Autopilot scheduler: starting scheduled run for ${seriesId}`);
    const result = await startSeriesAutopilot(seriesId, runOptionsFor(entry));
    if (result?.rejected) {
      // cos autonomy is off — the sanctioned gate refused the run. Expected, not an error.
      console.log(`🎬 Series Autopilot scheduler: run for ${seriesId} rejected (cos autonomy ${result.mode})`);
    } else if (result?.alreadyRunning) {
      console.log(`🎬 Series Autopilot scheduler: ${seriesId} already running — scheduled tick is a no-op`);
    }
  } catch (err) {
    console.error(`❌ Series Autopilot scheduler: run for ${seriesId} failed: ${err.message}`);
  }
}

/**
 * Register (or re-register) the cron for one schedule entry. eventScheduler's
 * `schedule()` cancels an existing event with the same id, so calling this for
 * a series that already has a cron cleanly replaces it (picking up an edited
 * cron/timezone).
 */
function registerSchedule(entry, timezone) {
  const sid = entry.seriesId; // capture only the id — the handler re-reads the entry per run
  schedule({
    id: eventId(sid),
    type: 'cron',
    cron: entry.cron,
    timezone: entry.timezone || timezone,
    handler: () => runScheduledAutopilot(sid),
    metadata: { source: 'seriesAutopilotScheduler', seriesId: sid },
  });
  registered.add(sid);
}

// Registration-affecting fingerprint of the active schedules (+ the fallback
// timezone). Two snapshots with the same fingerprint register identical crons,
// so a save that didn't touch scheduling can skip the whole re-sync.
function signatureOf(active, fallbackTz) {
  return JSON.stringify({
    tz: fallbackTz ?? null,
    s: active.map((e) => [e.seriesId, e.cron, e.timezone ?? null]),
  });
}

/**
 * (Re)synchronize the registered crons to match the given settings snapshot:
 * register/replace every active schedule and cancel any previously-registered
 * series that is no longer active (removed or disabled). Idempotent — safe to
 * call at boot and after every settings save. Short-circuits when the
 * registration inputs are unchanged since the last sync (the `settings:updated`
 * bus fires on every save, most of which don't touch scheduling).
 * @param {object} [settings] - a settings snapshot; re-read when omitted
 */
export async function syncSeriesAutopilotSchedules(settings) {
  const current = settings || await getSettings().catch(() => null);
  const active = activeSchedules(current);
  const timezone = await getUserTimezone().catch(() => 'UTC');

  const signature = signatureOf(active, current?.timezone);
  if (signature === lastSignature) return active.length; // nothing registration-affecting changed
  lastSignature = signature;

  const activeIds = new Set(active.map((s) => s.seriesId));
  // Cancel crons whose schedule is gone/disabled.
  for (const seriesId of [...registered]) {
    if (!activeIds.has(seriesId)) {
      cancel(eventId(seriesId));
      registered.delete(seriesId);
    }
  }
  // Register/replace the active ones.
  for (const entry of active) {
    registerSchedule(entry, timezone);
  }
  console.log(`🎬 Series Autopilot scheduler: ${active.length} schedule(s) active`);
  return active.length;
}

// Re-sync when settings change, rather than being called from the settings
// route — keeps the HTTP handler decoupled from the autopilot pipeline graph
// (mirrors meatspacePostReminder.js). The signature guard above makes an
// unrelated save a cheap no-op.
settingsEvents.on('settings:updated', (cleaned) => {
  syncSeriesAutopilotSchedules(cleaned).catch((err) =>
    console.error(`❌ Series Autopilot schedule re-sync failed: ${err.message}`));
});

/**
 * Boot entry point — registers the configured schedules once at startup.
 * No-ops cleanly when nothing is configured (no cold LLM calls: registering a
 * timer fires nothing until its cron elapses, and even then only if enabled +
 * cos autonomy is on).
 */
export async function startSeriesAutopilotScheduler() {
  return syncSeriesAutopilotSchedules();
}

/**
 * Cancel every registered series-autopilot cron (test teardown / shutdown).
 */
export function stopSeriesAutopilotScheduler() {
  for (const seriesId of [...registered]) {
    cancel(eventId(seriesId));
    registered.delete(seriesId);
  }
  lastSignature = null;
}
