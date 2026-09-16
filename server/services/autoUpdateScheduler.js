/**
 * Unattended PortOS self-update, gated on the install being completely idle.
 *
 * The contract, in order — every gate must pass on the SAME tick:
 *
 *   1. The feature is on (`settings.autoUpdate.enabled`).
 *   2. At least `minIntervalHours` have passed since the last update landed.
 *      Before that the scheduler does not even look; after it, every tick is a
 *      chance to go.
 *   3. There is actually something to update to — a newer release tag on the
 *      `release` channel, or origin's default branch ahead of this checkout on
 *      the `main` channel. Nothing to do is a no-op, not a restart.
 *   4. The checkout is on the default branch and clean, or is one mechanical
 *      repair away (`updateRepoReadiness.js`). What no script may safely fix
 *      queues a CoS agent and waits.
 *   5. The system is idle — no render running or queued, no CoS agent, no
 *      Persistent Mind turn or queued message, no app operation
 *      (`lib/systemIdle.js`, the same verdict the dashboard's Live activity
 *      widget renders).
 *
 * Nothing on disk is WRITTEN until every one of those has passed: the checkout
 * repairs run after the idle gate, never before it.
 *
 * Then it performs EXACTLY the action the matching button performs, through the
 * same service the button reaches. This is not a second update implementation:
 * `release` calls `startPortosSelfUpdate` (what `POST /api/update/execute`
 * calls) and `main` calls `runAppUpdate` (what the `app:update` socket handler
 * calls). Every preflight refusal, lock, and launch rule therefore applies
 * unchanged, including the ones that exist because this process does not
 * survive the script it launches.
 *
 * This is a user-configured scheduled automation — the sanctioned exception in
 * the AI Provider Usage Policy — and it makes no provider call of its own. The
 * one that can occur is the repair agent in step 4, which is itself switchable.
 */

import { schedule, cancel } from './eventScheduler.js';
import { getSettings, settingsEvents } from './settings.js';
import { getSystemActivity } from './activeProcessing.js';
import { startPortosSelfUpdate } from './portosSelfUpdate.js';
import { runAppUpdate } from './appUpdateRunner.js';
import { checkUpdateRepoReadiness, prepareUpdateRepo, queueRepoRepairTask } from './updateRepoReadiness.js';
import * as updateChecker from './updateChecker.js';
import { describeActivityBlockers } from '../lib/systemIdle.js';
import { resolveAutoUpdateConfig } from '../lib/sharedSchemas.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

const EVENT_ID = 'portos-auto-update';

/** How often the scheduler looks for an idle window once it is armed. */
const AUTO_UPDATE_POLL_INTERVAL_MS = 5 * 60 * 1000;

// Only confirmed enabled/disabled states are cached; the signature makes an
// unrelated settings save free, exactly as backupScheduler's does.
let registrationSignature = null;

// The Socket.IO server, captured at boot so the scheduler's run emits the same
// `portos:update:*` / `app:update:*` frames a click would — a user watching the
// Update page sees the automatic run stream like any other.
let ioRef = null;

/**
 * When the clock for the minimum interval starts.
 *
 * `lastRunAt` first (this scheduler's own last launch), then the last recorded
 * update result — which covers an update the USER ran, so a manual update also
 * resets the interval rather than leaving an automatic one queued behind it.
 * `repairQueuedAt` covers the OTHER thing this scheduler dispatches: a repo
 * repair agent that stands down without fixing anything never produces a
 * `lastRunAt`, so without this the cooldown would never re-arm and the next
 * tick would queue a second agent immediately — repeating every 5 minutes
 * forever (#7468). `armedAt` is the fallback for an install that has never
 * updated: without it the interval would be measured from the epoch and the
 * first tick after enabling would fire immediately.
 */
export function updateBaselineAt(runtime, lastUpdateResult, now = Date.now()) {
  const candidates = [runtime?.lastRunAt, runtime?.repairQueuedAt, lastUpdateResult?.completedAt, runtime?.armedAt]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : now;
}

/**
 * Is the only thing standing between this checkout and readiness something
 * `prepareUpdateRepo` can mechanically fix? Those are not worth waking an agent
 * for, and they are not a reason to stand down — they are handled after the
 * idle gate.
 */
const isRepairableOnly = (verdict) => verdict.reasons.length === 0 && verdict.repairable.length > 0;

/** Record the skip and log it once per distinct reason, not once per tick. */
let lastLoggedSkip = null;
async function standDown(reason, detail) {
  const line = detail ? `${reason}: ${detail}` : reason;
  if (line !== lastLoggedSkip) {
    console.log(`🕒 Auto-update standing by — ${line}`);
    lastLoggedSkip = line;
  }
  await updateChecker.recordAutoUpdateRuntime({
    lastSkip: { reason, detail: detail || null, at: new Date().toISOString() },
  }).catch(() => undefined);
  return { ran: false, reason, detail: detail || null };
}

/**
 * Is there anything to update TO on this channel?
 *
 * @returns {{available: boolean, detail: string}}
 */
function updateAvailableFor(channel, status, verdict) {
  if (channel === 'release') {
    if (status.updateAvailable) return { available: true, detail: `release v${status.latestRelease?.version}` };
    return { available: false, detail: 'no newer release' };
  }
  // `main`: origin's default branch is the target, and `verdict.behind` is the
  // count of commits this checkout is missing — measured after a real fetch, so
  // it cannot report a stale "up to date" and skip a real update. An install
  // whose code is ahead of what is RUNNING (a bare `git pull`) has already been
  // updated on disk; `installState.outOfSync` is what catches that, and it
  // needs the same reconcile run.
  if (verdict.behind > 0) return { available: true, detail: `${verdict.behind} commit(s) behind origin/${verdict.defaultBranch}` };
  if (status.installState?.outOfSync) return { available: true, detail: 'install out of sync with the checked-out code' };
  return { available: false, detail: `up to date with origin/${verdict.defaultBranch || 'default'}` };
}

/**
 * One scheduler tick. Exported for the suite and for a "run the check now"
 * caller; it performs at most one update and never throws.
 *
 * @param {object} [options]
 * @param {object} [options.io] - overrides the captured Socket.IO server.
 * @returns {Promise<{ran: boolean, reason?: string, detail?: string|null, channel?: string}>}
 */
export async function runAutoUpdateTick({ io = ioRef } = {}) {
  const settings = await getSettings().catch(() => null);
  const config = resolveAutoUpdateConfig(settings?.autoUpdate);
  if (!config.enabled) return { ran: false, reason: 'disabled' };

  // ONE read of update.json serves the cooldown and the already-running check.
  // `getUpdateStatus()` is deliberately NOT called yet: its `getInstallState()`
  // walks every file under client/src, and the cooldown discards the answer on
  // 71 of every 72 ticks at the default interval.
  const { runtime, lastUpdateResult, updateInProgress } = await updateChecker.getAutoUpdateGateState();
  // Stamp the arming point on the first tick after the feature goes on, so the
  // interval has something to measure from on an install that has never
  // updated. Written once — a re-stamp on every boot would move the deadline.
  if (!runtime.armedAt) {
    await updateChecker.recordAutoUpdateRuntime({ armedAt: new Date().toISOString() }).catch(() => undefined);
  }

  if (updateInProgress) return standDown('update-in-progress', 'an update is already running');

  const now = Date.now();
  const baselineAt = updateBaselineAt(runtime, lastUpdateResult, now);
  const elapsedMs = now - baselineAt;
  if (elapsedMs < config.minIntervalMs) {
    const remainingMinutes = Math.ceil((config.minIntervalMs - elapsedMs) / 60000);
    return standDown('cooldown', `${remainingMinutes} minute(s) left of the ${config.minIntervalHours}h minimum interval`);
  }

  const status = await updateChecker.getUpdateStatus().catch(() => null);
  if (!status) return standDown('status-unavailable', 'could not read the update status');

  // READ the checkout — never write to it yet. The write half
  // (`prepareUpdateRepo`) is deliberately held until after the idle gate
  // below: `git checkout main` in the primary checkout under a live
  // `useWorktree: false` CoS agent is a branch-jack, and the whole point of the
  // idle gate is to prove nothing is running before this process touches
  // anything. Reading early is still right, because the one remedy that takes
  // TIME is the repair agent — queued now, it is work the idle gate then waits
  // on, and the window after it finishes is the one that updates.
  const read = await checkUpdateRepoReadiness({ fetch: true })
    .catch((err) => ({ ready: false, needsAgent: false, reasons: ['git-unreadable'], summary: err.message, repairable: [] }));
  if (!read.ready && !isRepairableOnly(read)) {
    if (read.needsAgent && config.resolveBlockersWithAgent) {
      await queueRepoRepairTask(read);
      // Stamp the cooldown baseline at DISPATCH, not only when an update
      // itself runs. `addTask`'s dedup (cosTaskStore.js) only collapses
      // repeat ticks onto one task while that task stays open — once the
      // agent completes (fixed or not), the task flips to `completed` and the
      // very next tick would queue a fresh one with nothing else to stop it.
      // This makes a stand-down cost one dispatch per cooldown window instead
      // of one per 5-minute tick.
      await updateChecker.recordAutoUpdateRuntime({ repairQueuedAt: new Date().toISOString() }).catch(() => undefined);
    }
    return standDown('repo-not-ready', read.summary);
  }

  const availability = updateAvailableFor(config.channel, status, read);
  if (!availability.available) return standDown('up-to-date', availability.detail);

  // Idle is checked immediately before anything is written, so the window it
  // reports is as close as this can get to the window the update runs in. The
  // update path's own preflight re-checks the agent and Persistent Mind halves
  // under the update lock — this gate is broader (renders, queued work), not a
  // replacement for it.
  const processing = await getSystemActivity().catch(() => null);
  if (!processing) return standDown('activity-unknown', 'could not read the activity snapshot');
  if (!processing.activity.idle) {
    return standDown('busy', describeActivityBlockers(processing.activity.blockers));
  }

  // Only NOW may the checkout be written to. `prepareUpdateRepo` re-reads before
  // and after its remedies, so a checkout that went dirty since the read above
  // is refused here rather than repaired blindly.
  const { verdict, actions } = await prepareUpdateRepo().catch((err) => ({
    verdict: { ready: false, reasons: ['git-unreadable'], summary: err.message },
    actions: [],
  }));
  if (!verdict.ready) return standDown('repo-not-ready', verdict.summary);
  if (actions.length) console.log(`🧹 Auto-update prepared the checkout: ${actions.join(', ')}`);

  lastLoggedSkip = null;
  console.log(`⬆️ Auto-update starting (${config.channel} channel) — ${availability.detail}`);
  await updateChecker.recordAutoUpdateRuntime({
    lastAttemptAt: new Date().toISOString(),
    lastSkip: null,
  }).catch(() => undefined);

  const outcome = await launchUpdateFor(config.channel, io).catch((err) => ({ ok: false, message: err.message }));
  if (!outcome.ok) {
    console.error(`❌ Auto-update could not start: ${outcome.message}`);
    await updateChecker.recordAutoUpdateRuntime({ lastOutcome: `failed: ${outcome.message}` }).catch(() => undefined);
    return { ran: false, reason: 'launch-failed', detail: outcome.message, channel: config.channel };
  }

  // `lastRunAt` is stamped at the LAUNCH, not at a completion this process will
  // not live to see: update.sh pm2-deletes this server partway through. Without
  // it, a restart that lands before the update result is recorded would find
  // the interval already elapsed and immediately launch a second update.
  await updateChecker.recordAutoUpdateRuntime({
    lastRunAt: new Date().toISOString(),
    lastOutcome: `started (${config.channel})`,
  }).catch(() => undefined);
  return { ran: true, channel: config.channel, detail: availability.detail };
}

/**
 * Dispatch the channel's action — the SAME service call its button makes.
 * Nothing about the update lifecycle belongs here.
 */
async function launchUpdateFor(channel, io) {
  if (channel === 'release') {
    await startPortosSelfUpdate({ io, mode: 'release' });
    return { ok: true };
  }
  const result = await runAppUpdate({ io, appId: PORTOS_APP_ID });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/**
 * (Re)synchronize the poll registration to match the given settings snapshot.
 * Idempotent — safe at boot and after every settings save. Registering the
 * interval fires nothing until it elapses, so this never updates by itself.
 *
 * @param {object} [settings] - a settings snapshot; re-read when omitted.
 * @returns {Promise<boolean>} whether the poll is registered afterwards.
 */
export async function syncAutoUpdateSchedule(settings) {
  const current = settings || await getSettings().catch(() => null);
  const config = resolveAutoUpdateConfig(current?.autoUpdate);
  // Only the enabled flag shapes the REGISTRATION; the channel and the interval
  // are re-read inside the handler, so changing either takes effect on the next
  // tick without a re-register.
  const signature = JSON.stringify({ enabled: config.enabled });
  if (signature === registrationSignature) return config.enabled;
  registrationSignature = signature;

  if (!config.enabled) {
    cancel(EVENT_ID);
    console.log('🕒 Automatic updates: off');
    return false;
  }

  schedule({
    id: EVENT_ID,
    type: 'interval',
    intervalMs: AUTO_UPDATE_POLL_INTERVAL_MS,
    handler: () => runAutoUpdateTick().catch(err => {
      // Outside the request lifecycle: an uncaught throw here takes the process
      // down with it, and a scheduler that dies stops updating silently.
      console.error(`❌ Auto-update tick failed: ${err.message}`);
    }),
    metadata: { source: 'autoUpdateScheduler' },
  });
  console.log(`🕒 Automatic updates: on (${config.channel} channel, ${config.minIntervalHours}h minimum interval)`);
  return true;
}

// Re-sync on every settings save rather than from the settings route — keeps
// the HTTP handler decoupled from the update graph (mirrors backupScheduler).
// The signature guard makes unrelated saves free.
settingsEvents.on('settings:updated', (cleaned) => {
  syncAutoUpdateSchedule(cleaned).catch(err =>
    console.error(`❌ Auto-update schedule re-sync failed: ${err.message}`));
});

/**
 * Boot entry point — captures the Socket.IO server so an automatic run streams
 * its progress to whoever is watching, then registers the poll if the feature
 * is on. Later enable/disable edits are picked up by the subscription above.
 */
export function startAutoUpdateScheduler(io) {
  ioRef = io || null;
  return syncAutoUpdateSchedule();
}

/** Test-only: drop the cached registration signature. */
export function __resetAutoUpdateSchedulerForTests() {
  registrationSignature = null;
  lastLoggedSkip = null;
  ioRef = null;
}
