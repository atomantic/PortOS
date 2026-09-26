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

import { watch } from 'chokidar';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { schedule, cancel } from './eventScheduler.js';
import { getSettings, getSettingsWithStatus, settingsEvents } from './settings.js';
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

// How long to wait before retrying a boot-time read that came back corrupt
// (issue #8428) — mirrors backupScheduler's retry window.
const CORRUPT_SETTINGS_RETRY_MS = 60_000;

// Only confirmed enabled/disabled states are cached; the signature makes an
// unrelated settings save free, exactly as backupScheduler's does.
let registrationSignature = null;

// Guards against stacking multiple boot-retry timers while settings.json
// stays unreadable across several syncAutoUpdateSchedule() calls.
let corruptRetryTimer = null;

// The Socket.IO server, captured at boot so the scheduler's run emits the same
// `portos:update:*` / `app:update:*` frames a click would — a user watching the
// Update page sees the automatic run stream like any other.
let ioRef = null;

// Payload-free invalidations: never broadcast configuration, repo paths or
// activity records. A short fixed window bounds bursts without starving reads.
let statusTimer = null;
let configSignature = null;
let repoWatcher = null;
let watcherStart = null;

function invalidateStatus() {
  if (!ioRef || statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    try {
      ioRef?.emit('portos:auto-update:changed', {});
    } catch (err) {
      console.error(`❌ Auto-update status notify failed: ${err.message}`);
    }
  }, 100);
  statusTimer.unref?.();
}

// Git operations performed outside PortOS have no service event. Watch only
// committed ref metadata, including worktree/common-dir layouts. Exclude index:
// git status itself can refresh it, which would make a read/notify feedback loop.
// Working-tree-only edits reconcile on activity, scheduler ticks and tab show.
async function watchRepoChanges() {
  const [{ stdout: gitDir }, { stdout: commonDir }] = await Promise.all([
    execGit(['rev-parse', '--absolute-git-dir'], PATHS.root),
    execGit(['rev-parse', '--git-common-dir'], PATHS.root),
  ]);
  const roots = [...new Set([gitDir.trim(), resolve(PATHS.root, commonDir.trim())])];
  repoWatcher = watch(roots.flatMap(root => [
    join(root, 'HEAD'), join(root, 'refs'), join(root, 'packed-refs'),
  ]), { ignoreInitial: true, persistent: false, ignored: /\.lock$/ });
  repoWatcher.on('all', invalidateStatus);
  repoWatcher.on('error', err => console.error(`❌ Auto-update repo watcher failed: ${err.message}`));
}

/**
 * When the clock for the minimum interval starts.
 *
 * `lastRunAt` first (this scheduler's own last launch), then the last recorded
 * update result — which covers an update the USER ran, so a manual update also
 * resets the interval rather than leaving an automatic one queued behind it.
 * `armedAt` is the fallback for an install that has never updated: without it
 * the interval would be measured from the epoch and the first tick after
 * enabling would fire immediately.
 *
 * Deliberately does NOT fold in a repair-agent dispatch (`repairQueuedAt`,
 * see `repairDispatchDue` below): this baseline gates the WHOLE tick,
 * including the update itself, before the checkout is even read. Blending
 * the two would mean a checkout the repair agent fixed in five minutes still
 * could not update for the rest of the interval — breaking the documented
 * promise that PortOS resumes automatically once the checkout is clean.
 */
export function updateBaselineAt(runtime, lastUpdateResult, now = Date.now()) {
  const candidates = [runtime?.lastRunAt, lastUpdateResult?.completedAt, runtime?.armedAt]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : now;
}

/**
 * Whether enough time has passed since the last repair-agent DISPATCH to
 * queue another one. A separate gate from `updateBaselineAt` on purpose
 * (#7468): this one only throttles re-queueing a repair agent for a checkout
 * it could not fix, so it must never hold back the update tick itself once
 * the checkout is actually clean. Reuses the same `minIntervalMs` the update
 * cooldown uses — there is no separate configured interval for this, and
 * reusing it keeps "one dispatch per cooldown window" in one place.
 */
export function repairDispatchDue(runtime, minIntervalMs, now = Date.now()) {
  const queuedAt = typeof runtime?.repairQueuedAt === 'string' ? Date.parse(runtime.repairQueuedAt) : NaN;
  if (!Number.isFinite(queuedAt)) return true;
  return now - queuedAt >= minIntervalMs;
}

/**
 * Is the only thing standing between this checkout and readiness something
 * `prepareUpdateRepo` can mechanically fix? Those are not worth waking an agent
 * for, and they are not a reason to stand down — they are handled after the
 * idle gate.
 */
const isRepairableOnly = (verdict) => verdict.reasons.length === 0 && verdict.repairable.length > 0;

/**
 * Runtime-write failure tracking (bounded, transition-based).
 *
 * `recordAutoUpdateRuntime` persists to the same `update.json` every write
 * below lands in, so it fails for reasons that have nothing to do with what
 * the update pipeline is waiting on (a full disk, a permissions change under
 * `data/`, a corrupted state file). Every call site here used to discard that
 * rejection with `.catch(() => undefined)`, which made a real persistence
 * outage indistinguishable from "nothing to report" — the defect this module
 * exists to close. Tracked per OPERATION so one stuck write doesn't drown a
 * healthy one, and logged only on the transition into/out of failure so a
 * broken disk doesn't flood the log every five-minute tick.
 */
const failingRuntimeWrites = new Set();

/**
 * Write a patch to the auto-update runtime record. Never throws — logs (once
 * per operation, not per tick) on failure and on recovery.
 *
 * @returns {Promise<boolean>} whether the write landed.
 */
async function writeRuntime(patch, operation) {
  return updateChecker.recordAutoUpdateRuntime(patch).then(
    () => {
      invalidateStatus();
      if (failingRuntimeWrites.delete(operation)) {
        console.log(`✅ Auto-update runtime write recovered (${operation})`);
      }
      return true;
    },
    (err) => {
      if (!failingRuntimeWrites.has(operation)) {
        failingRuntimeWrites.add(operation);
        // `err.code` (ENOSPC, EACCES, …) over `err.message`, which for an fs
        // error embeds the full local path. Guard against a non-Error reject.
        console.error(`❌ Auto-update runtime write failed (${operation}): ${err?.code || err?.message || String(err)}`);
      }
      return false;
    },
  );
}

/** Record the skip and log it once per distinct reason, not once per tick. */
let lastLoggedSkip = null;
async function standDown(reason, detail) {
  const line = detail ? `${reason}: ${detail}` : reason;
  if (line !== lastLoggedSkip) {
    console.log(`🕒 Auto-update standing by — ${line}`);
    lastLoggedSkip = line;
  }
  await writeRuntime({
    lastSkip: { reason, detail: detail || null, at: new Date().toISOString() },
  }, 'skip');
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
  // Checked BEFORE the arming write below: an update already running is a
  // real, useful reason to stand down on its own, and it must not be masked
  // by a coincidental persistence failure on the very tick the feature was
  // enabled (an install has both flags open only in that one window).
  if (updateInProgress) return standDown('update-in-progress', 'an update is already running');

  // Stamp the arming point on the first tick after the feature goes on, so the
  // interval has something to measure from on an install that has never
  // updated. Written once — a re-stamp on every boot would move the deadline.
  if (!runtime.armedAt) {
    const armed = await writeRuntime({ armedAt: new Date().toISOString() }, 'arm');
    // Without a persisted arming point, `updateBaselineAt` falls back to `now`
    // on every tick (see its own doc comment) — a broken write here would
    // otherwise report the full configured cooldown, indistinguishable from a
    // freshly-armed install, on every tick forever. Stop outright instead.
    if (!armed) {
      return standDown('runtime-persistence-unavailable', 'could not persist the arming timestamp');
    }
  }

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
    if (read.needsAgent && config.resolveBlockersWithAgent && repairDispatchDue(runtime, config.minIntervalMs, now)) {
      const task = await queueRepoRepairTask(read);
      // Stamp only on a REAL dispatch. `addTask`'s dedup (cosTaskStore.js)
      // only collapses repeat ticks onto one task while that task stays open
      // — once the agent completes (fixed or not), the task flips to
      // `completed` and the very next tick would queue a fresh one with
      // nothing else to stop it. `repairDispatchDue` above makes a stand-down
      // cost one dispatch per cooldown window instead of one per 5-minute
      // tick; stamping unconditionally here (including on a failed enqueue,
      // where `task` is null) would lock out every retry for the same
      // window while nothing was actually queued.
      if (task?.id) {
        await writeRuntime({ repairQueuedAt: new Date().toISOString() }, 'repair-queued');
      }
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
  await writeRuntime({
    lastAttemptAt: new Date().toISOString(),
    lastSkip: null,
  }, 'attempt');

  const outcome = await launchUpdateFor(config.channel, io).catch((err) => ({ ok: false, message: err.message }));
  if (!outcome.ok) {
    console.error(`❌ Auto-update could not start: ${outcome.message}`);
    await writeRuntime({ lastOutcome: `failed: ${outcome.message}` }, 'outcome');
    return { ran: false, reason: 'launch-failed', detail: outcome.message, channel: config.channel };
  }

  // `lastRunAt` is stamped at the LAUNCH, not at a completion this process will
  // not live to see: update.sh pm2-deletes this server partway through. Without
  // it, a restart that lands before the update result is recorded would find
  // the interval already elapsed and immediately launch a second update.
  //
  // The launch has already happened by this point — `setUpdateInProgress`'s
  // persisted lock (acquired inside `launchUpdateFor`, not here) is what
  // actually prevents a second dispatch, not this bookkeeping write. If IT
  // fails, the launch itself must not be undone or retried; the tick result
  // just carries a degradation flag so callers know the runtime record may be
  // stale until a later write succeeds.
  const recorded = await writeRuntime({
    lastRunAt: new Date().toISOString(),
    lastOutcome: `started (${config.channel})`,
  }, 'launch-record');
  return {
    ran: true,
    channel: config.channel,
    detail: availability.detail,
    ...(recorded ? {} : { persistenceWarning: 'launched, but could not record it — cooldown timing may be stale until the next successful write' }),
  };
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
  if (!settings) {
    // No explicit snapshot: boot path (or a corrupt-read retry). Read through
    // the strict status so an unreadable/malformed settings.json is
    // distinguishable from "auto-update genuinely off" (issue #8428).
    // `settings:updated` always hands this a clean parsed snapshot, so the
    // explicit-argument path below is unaffected.
    const { corrupt, settings: read } = await getSettingsWithStatus().catch(() => ({ corrupt: true, settings: {} }));
    if (corrupt) {
      console.error('❌ Automatic updates: settings unreadable — keeping current registration, will retry on next settings change');
      const wasEnabled = registrationSignature !== null && JSON.parse(registrationSignature).enabled === true;
      // Don't cache a signature for a failed read — the next sync
      // (settings:invalidated, or the boot retry below) must re-evaluate.
      registrationSignature = null;
      scheduleCorruptRetry();
      return wasEnabled;
    }
    return syncAutoUpdateSchedule(read);
  }
  const current = settings;
  const config = resolveAutoUpdateConfig(current?.autoUpdate);
  const nextConfigSignature = JSON.stringify(config);
  if (configSignature !== nextConfigSignature) {
    configSignature = nextConfigSignature;
    invalidateStatus();
  }
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

/**
 * Arm a single one-shot retry after a corrupt boot/re-sync read (#8428), so a
 * transient failure self-heals without waiting for a user-driven settings
 * save. Runs outside the request lifecycle — the process-boundary try/catch
 * convention applies, not the route error-bubbling one.
 */
function scheduleCorruptRetry() {
  if (corruptRetryTimer) return;
  corruptRetryTimer = setTimeout(() => {
    corruptRetryTimer = null;
    syncAutoUpdateSchedule().catch(err =>
      console.error(`❌ Automatic updates: corrupt-settings retry failed: ${err.message}`));
  }, CORRUPT_SETTINGS_RETRY_MS);
  corruptRetryTimer.unref?.();
}

// Re-sync on every settings save rather than from the settings route — keeps
// the HTTP handler decoupled from the update graph (mirrors backupScheduler).
// The signature guard makes unrelated saves free.
settingsEvents.on('settings:updated', (cleaned) => {
  syncAutoUpdateSchedule(cleaned).catch(err =>
    console.error(`❌ Auto-update schedule re-sync failed: ${err.message}`));
});

// A corrupt boot read invalidates the settings read cache (settings.js's
// reloadSettings()); re-sync as soon as a later read clears, without waiting
// for a settings:updated save (#8428).
settingsEvents.on('settings:invalidated', () => {
  syncAutoUpdateSchedule().catch(err =>
    console.error(`❌ Auto-update schedule invalidation re-sync failed: ${err.message}`));
});

/**
 * Boot entry point — captures the Socket.IO server so an automatic run streams
 * its progress to whoever is watching, then registers the poll if the feature
 * is on. Later enable/disable edits are picked up by the subscription above.
 */
export async function startAutoUpdateScheduler(io) {
  ioRef = io || null;
  if (!watcherStart) {
    watcherStart = watchRepoChanges().catch(err => {
      watcherStart = null;
      console.error(`❌ Auto-update repo watcher unavailable: ${err.message}`);
    });
  }
  await watcherStart;
  return syncAutoUpdateSchedule();
}

/** Test-only: drop the cached registration signature. */
export function __resetAutoUpdateSchedulerForTests() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  configSignature = null;
  repoWatcher?.close();
  repoWatcher = null;
  watcherStart = null;
  registrationSignature = null;
  lastLoggedSkip = null;
  ioRef = null;
  failingRuntimeWrites.clear();
  if (corruptRetryTimer) {
    clearTimeout(corruptRetryTimer);
    corruptRetryTimer = null;
  }
}
