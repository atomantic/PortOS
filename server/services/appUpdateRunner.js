/**
 * The one implementation of "update a managed app".
 *
 * App Management's Git tab dispatches it over the `app:update` socket event;
 * the unattended auto-updater (`autoUpdateScheduler.js`, channel `main`) calls
 * it directly for the PortOS app record. Both reach THIS function, so an
 * automatic update is byte-for-byte the action the button performs — the
 * operation claim, the PortOS preflight refusals, `appUpdater.updateApp`, the
 * history ledger row, and the apps-changed broadcast, in that order.
 *
 * Refusals are RETURNED, not thrown, because the socket path answers two of
 * them on the dispatching socket rather than the io bus (only the person who
 * clicked needs to hear "already running"), while the scheduler just logs. The
 * progress/complete/error frames that every viewer needs stay on `io` in here.
 */

import * as appsService from './apps.js';
import * as appUpdater from './appUpdater.js';
import { logAction } from './history.js';
import { checkPortosUpdatePreflight } from './updatePreflight.js';
import { claimAppOperation, endAppOperation, recordOperationStep } from './appOperations.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

/**
 * Run a full managed-app update cycle.
 *
 * @param {object} params
 * @param {object} params.io - Socket.IO server for the step/complete/error frames.
 * @param {string} params.appId
 * @param {boolean} [params.syncFork]
 * @param {boolean} [params.acknowledgeFork]
 * @param {boolean} [params.acknowledgePersistentMindImageBackup]
 * @returns {Promise<
 *   | {ok: false, reason: 'not-found'|'duplicate'|'refused'|'failed', appId: string|null, code: string|null, message: string}
 *   | {ok: true}
 * >}
 *   Every failure carries a rendered `message`; a caller decides only WHERE it
 *   goes (the dispatching socket, or a log line), never how it reads. `failed`
 *   is the one the io bus has ALREADY reported — the socket stays quiet for it.
 */
export async function runAppUpdate({
  io,
  appId,
  syncFork = false,
  acknowledgeFork = false,
  acknowledgePersistentMindImageBackup = false,
}) {
  const app = await appsService.getAppById(appId);
  if (!app) return { ok: false, reason: 'not-found', appId: null, code: null, message: 'App not found' };

  // Claimed here, immediately after the app record resolves and BEFORE the
  // preflight await below — the claim has to cover every await that precedes
  // the actual update, or two dispatches land inside the gap.
  const claim = claimAppOperation(io, app, 'update');
  if (!claim.ok) {
    return {
      ok: false,
      reason: 'duplicate',
      appId: app.id,
      code: null,
      message: `An ${claim.inFlight.type} is already running for ${claim.inFlight.appName}`,
    };
  }
  const operation = claim.operation;
  let operatingAppId = app.id;
  let result = null;

  try {
    // PortOS is itself a managed app, and updating it restarts the whole
    // install — apply the same refusals POST /api/update/execute enforces (a
    // live CoS agent, in-flight Persistent Mind image work, an unacknowledged
    // fork) so App Management can't restart out from under them just because it
    // dispatches through this path instead (#5984).
    if (app.id === PORTOS_APP_ID) {
      const refusal = await checkPortosUpdatePreflight({
        acknowledgeFork,
        acknowledgePersistentMindImageBackup,
      }).then(() => null, (err) => err);
      if (refusal) {
        endAppOperation(io, app.id);
        operatingAppId = null;
        return { ok: false, reason: 'refused', appId: app.id, code: refusal.code || null, message: refusal.message };
      }
    }

    console.log(`⬇️ Update started for ${app.name}`);
    const emit = (step, status, message) => {
      const frame = { appId: app.id, step, status, message, timestamp: Date.now() };
      recordOperationStep(operation, frame);
      io.emit('app:update:step', frame);
    };

    let failure = null;
    result = await appUpdater.updateApp(app, emit, {
      syncFork,
      acknowledgeFork,
      acknowledgePersistentMindImageBackup,
    }).catch(err => {
      failure = err;
      // Refusals raised inside the update (the PortOS launcher's post-lock
      // re-check, say) carry the same acknowledgement codes the pre-check
      // emits above — the panel's retry buttons key on `code`, so dropping it
      // here would leave a refusal the user could have acted on inert.
      io.emit('app:update:error', { appId: app.id, code: err.code || null, message: err.message });
      return null;
    });

    // The ledger and the apps-changed broadcast belong to this path now that it
    // is the only way to update an app — a thrown update still gets a row, with
    // success:false, rather than vanishing from the history.
    await logAction('update', app.id, app.name, { steps: result?.steps ?? [] }, result?.success === true, failure?.message ?? null);
    appsService.notifyAppsChanged('update', app.id);

    if (result?.selfUpdateStarted) {
      // update.sh will `pm2 delete` THIS process partway through, so there is
      // no completion to report and nothing after the restart to clear the
      // operation. Leaving it registered (the map dies with the process) is
      // what keeps the row rendering the script's STEP: frames right up to the
      // moment the server goes down.
      console.log(`♻️ PortOS self-update handed off — update.sh will restart this process`);
    } else if (result) {
      io.emit('app:update:complete', { appId: app.id, success: result.success, steps: result.steps });
      console.log(`✅ Update complete for ${app.name}`);
    }

    // `ok` must mean the update actually RAN, not merely that it was dispatched.
    // An unattended caller stamps its cooldown off this answer, so reporting a
    // thrown or failed update as `ok` would suppress every retry for the whole
    // interval while nothing had happened. `updateApp` returns
    // `success: true` on the self-update hand-off too, so one check covers both.
    if (failure || !result?.success) {
      return {
        ok: false,
        reason: 'failed',
        appId: app.id,
        code: failure?.code || null,
        message: failure?.message || 'The update did not complete',
      };
    }
    return { ok: true };
  } finally {
    if (operatingAppId && !result?.selfUpdateStarted) endAppOperation(io, operatingAppId);
  }
}
