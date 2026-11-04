import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { assertUpdateImageSafety } from '../server/lib/updateImageGuard.js';
import { createMaintenanceJournal, maintenanceError, syncMaintenanceDirectory } from '../server/lib/maintenanceJournal.js';
import { createDeferredUpdateAdmission, processAbsent, reconcileReusedLaunch } from '../server/lib/maintenanceDeferredUpdate.js';
import * as fs from 'node:fs';
import { legacyLauncherGroups, legacyProcessCwds, observedDatabaseRestoreProcess, observedLegacyUpdate, observedLocalMediaProcesses, snapshotLegacyProcesses } from './lib/legacyUpdateActivity.mjs';
import { isCompletedLocalClaim, isEmptyLegacyMediaJob, remoteMediaRecoveryPending } from '../server/lib/mediaRecoveryActivity.js';
import { parseCommandArgs } from '../server/lib/commandSecurity.js';
import { offerManualUpdateRecovery } from './lib/manualUpdateRecovery.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const journal = createMaintenanceJournal();
const maintenance = { directory: journal.directory, deferredUpdate: createDeferredUpdateAdmission({
  transaction: journal.transaction, read: journal.readForStatus, makeId: randomUUID, error: maintenanceError,
  now: Date.now, directory: journal.directory, io: fs, syncDirectory: syncMaintenanceDirectory,
  lockExists: () => journal.exists(journal.lock),
}) };
const readControl = async path => {
  try { return await readFile(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
};
const savedMediaJobs = admission => {
  try {
    const path = join(admission.directory, '..', 'media-jobs.json');
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid saved media inventory');
    const snapshot = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.filter(job => !isEmptyLegacyMediaJob(job)).some(job => !job || typeof job !== 'object'
      || !['queued', 'running', 'completed', 'failed', 'canceled'].includes(job.status))) throw new Error('Invalid saved media inventory');
    return snapshot.jobs.filter(job => !isEmptyLegacyMediaJob(job));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};
const savedMediaPending = admission => savedMediaJobs(admission).some(job => job && typeof job === 'object' && remoteMediaRecoveryPending(job));

// Older running servers may hold the machine-wide accelerator without an
// admission row. Check the live claimant at the update's journal boundary.
export function legacyHeavyClaimPending(admission, processes, absent = processAbsent, observation = {}, report = () => {}) {
  const path = join(admission.directory, '..', 'heavy-local-job.claim.json');
  let stat;
  try { stat = fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid local accelerator claim');
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  let after;
  try { after = fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => stat[key] !== after[key])) return true;
  const invalidClaim = () => {
    // In-place legacy handoffs can be briefly truncated. A stable malformed
    // file alone is not evidence of live work after the next observation.
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const pending = observation.malformed !== fingerprint;
    observation.malformed = fingerprint;
    if (!pending && observation.reported !== fingerprint) {
      observation.reported = fingerprint;
      report('STEP:waiting:running:Legacy accelerator claim is unreadable; using observed activity');
    }
    return pending;
  };
  let claim;
  try { claim = JSON.parse(raw); } catch { return invalidClaim(); }
  if (!Number.isSafeInteger(claim?.pid) || claim.pid <= 0) return invalidClaim();
  observation.malformed = null;
  try {
    const markerPath = `${path}.completed.json`;
    const marker = fs.lstatSync(markerPath);
    if (marker.isFile() && marker.size <= 65536) {
      const completed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (isCompletedLocalClaim(claim, completed)) return false;
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (absent(claim.pid)) return false;
  const owner = processes.find(row => row.pid === claim.pid);
  if (String(owner?.state ?? '').startsWith('Z')) return false;
  return !(Number.isFinite(owner?.startedAt) && owner.startedAt > stat.mtimeMs + 2000);
}

/** Both launch paths arrive here before the script touches logs, git or PM2. */
export async function runDeferredUpdate({ admission = maintenance, launch = spawn, cwd = root,
  platform = process.platform, wait = () => delay(1000), absent = processAbsent, launchId = process.env.PORTOS_DEFERRED_UPDATE_LAUNCH_ID,
  legacySnapshot = snapshotLegacyProcesses, legacyCwds = legacyProcessCwds, legacyGroups = legacyLauncherGroups,
  signal, emit = message => console.log(message), legacyRunning, recoverReservations, observeWork, policy = 'automatic',
  confirmInterruption = async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await input.question('Update now? Active work may be interrupted; saved state and queued work are preserved. Type update to continue: ', { signal })).trim() === 'update'; }
    finally { input.close(); }
  } } = {}) {
  if (!['automatic', 'manual', 'interrupt'].includes(policy)) throw new Error('Invalid update policy');
  let reportedLegacyLimit = false;
  const heavyObservation = {};
  let manualLegacyWork = false;
  const checkLegacy = legacyRunning ?? (async () => {
    const control = join(admission.directory, '..', 'update-detached');
    const raw = (await readControl(join(control, 'pid')).catch(() => '')).trim();
    const candidate = Number(raw);
    const pid = raw && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
    const priorAt = pid ? await fs.promises.stat(join(control, 'pid')).then(stat => stat.mtimeMs, () => null) : null;
    // The old control file is history. Only a currently observed updater or
    // update child keeps it blocking; the file is retained without a success claim.
    let groupInspectionUnavailable = false;
    const groups = await legacyGroups(join(admission.directory, '..'), control).catch(() => {
      groupInspectionUnavailable = true;
      return [];
    });
    const rows = await legacySnapshot(platform);
    const observed = await observedLegacyUpdate({ root: cwd, priorPid: pid, priorAt, groups, platform,
      snapshot: async () => rows, probeCwds: legacyCwds });
    const exclusive = observed.running || observedDatabaseRestoreProcess(rows);
    if (exclusive && (observed.limitations.length || groupInspectionUnavailable) && !reportedLegacyLimit) {
      reportedLegacyLimit = true;
      emit('STEP:waiting:running:Some legacy work could not be inspected fully');
    }
    if (exclusive || policy === 'interrupt') return exclusive;
    const localMedia = await observedLocalMediaProcesses(rows, savedMediaJobs(admission), resolve(admission.directory, '..'),
      { platform, probeCwds: legacyCwds });
    if ((observed.limitations.length || localMedia.limitations.length || groupInspectionUnavailable) && !reportedLegacyLimit) {
      reportedLegacyLimit = true;
      emit('STEP:waiting:running:Some legacy work could not be inspected fully');
    }
    if (policy === 'manual') {
      manualLegacyWork = localMedia.running;
      return observed.running || observedDatabaseRestoreProcess(rows);
    }
    return observed.running || localMedia.running || observedDatabaseRestoreProcess(rows);
  });
  await reconcileReusedLaunch(admission, () => legacySnapshot(platform));
  admission.deferredUpdate.reconcile();
  const operation = launchId ? admission.deferredUpdate.claimLaunch(launchId) : admission.deferredUpdate.request({ recoverWaiting: true });
  let childStarted = false;
  let recovery, recoveryMessage;
  let manualChecks = 0;
  let takeoverChecks = 0;
  try {
    const handoff = await readControl(join(admission.directory, `update-handoff-${operation.id}.json`));
    const transferred = handoff ? JSON.parse(handoff) : null;
    const waitingTakeover = transferred?.successorId === operation.id && transferred.previous?.phase === 'waiting'
      && transferred.previous.childPid === null && transferred.previous.holdId === null;
    emit(`STEP:waiting:running:${policy === 'interrupt' ? 'Manual continuation: work may be interrupted during shutdown' : policy === 'manual' ? 'Checking current running work' : 'Waiting for admitted work to finish saving and cleanup'}`);
    const observedWork = async () => {
      try {
        if (observeWork) return await observeWork(operation);
        recovery ??= await import('./lib/updateReservationRecovery.mjs').then(module => module.createUpdateReservationRecovery({
          directory: admission.directory, root: cwd, signal,
        }));
        return await recovery.observeManualWork(operation);
      } catch { signal?.throwIfAborted(); return []; }
    };
    const requestInterruption = async blockers => {
      emit(`STEP:waiting:warning:${blockers.map(blocker => blocker.label).join(', ')}. Updating restarts PortOS and Chrome; active work may be interrupted.`);
      if (await confirmInterruption()) { policy = 'interrupt'; return; }
      const page = await offerManualUpdateRecovery({ root: cwd, directory: admission.directory, id: operation.id }).catch(() => null);
      if (page) emit(`STEP:waiting:warning:Open ${page} in this PortOS instance to review and explicitly continue the update in your browser.`);
      throw Object.assign(new Error(`Running work needs interruption acknowledgment. ${page ? `Open ${page} to continue in your browser. ` : ''}Re-run update.sh/update.ps1 with --interrupt to continue, or --automatic to wait for idle.`), { code: 'UPDATE_INTERRUPTION_REQUIRED' });
    };
    const checkExclusiveWork = async () => {
      manualLegacyWork = false;
      try { return await checkLegacy(); }
      catch (error) { signal?.throwIfAborted(); if (policy === 'automatic') throw error; return false; }
    };
    const legacyWork = () => manualLegacyWork ? [{ kind: 'media-worker', label: 'A media worker is running', count: 1 }] : [];
    for (;;) {
      signal?.throwIfAborted();
      let recoveryBlocked = false;
      if (policy === 'automatic' && (admission === maintenance || recoverReservations)) {
        try {
          if (recoverReservations) await recoverReservations();
          else {
            recovery ??= await import('./lib/updateReservationRecovery.mjs').then(module => module.createUpdateReservationRecovery({
              directory: admission.directory, root: cwd, signal,
            }));
            const receipt = await recovery.run();
            if (receipt) emit(`STEP:waiting:running:Recovered ${receipt.request.operations.length} inactive work reservations`);
          }
        } catch (error) {
          signal?.throwIfAborted();
          recoveryBlocked = true;
          if (error.message !== recoveryMessage) {
            recoveryMessage = error.message;
            emit(`STEP:waiting:running:Recovery is waiting: ${error.message}`);
          }
        }
      }
      const externalWorkPending = recoveryBlocked || await checkExclusiveWork();
      if (policy === 'manual') {
        const blockers = [...await observedWork(), ...legacyWork()];
        if (blockers.length) {
          if (++manualChecks < 6) { await wait(); continue; }
          await requestInterruption(blockers);
          continue;
        }
      }
      const stopFirst = policy !== 'automatic';
      const heavyPath = join(admission.directory, '..', 'heavy-local-job.claim.json');
      const processes = !stopFirst && fs.existsSync(heavyPath) ? await legacySnapshot(platform) : [];
      const acquired = admission.deferredUpdate.acquire(operation.id, {
        externalWorkPending, interrupt: policy === 'interrupt', stopFirst, checkExternal: () => {
          try {
            const dbRecovery = join(admission.directory, '..', 'database-restore-recovery.json');
            const dbMaintenance = join(admission.directory, '..', 'database-maintenance');
            try { fs.lstatSync(dbMaintenance); throw maintenanceError('MAINTENANCE_HELD', 'Database cutover maintenance is active or needs recovery. Inspect scripts/database-maintenance.mjs status.'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            let databasePending;
            try { fs.lstatSync(dbRecovery); databasePending = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; databasePending = false; }
            if (databasePending && stopFirst) throw maintenanceError('MAINTENANCE_HELD', 'Database restore recovery must finish before updating.');
            return databasePending || (!stopFirst && (savedMediaPending(admission) || legacyHeavyClaimPending(admission, processes, absent, heavyObservation, emit)));
          }
          catch (error) { if (error.code === 'MAINTENANCE_HELD') throw error; throw maintenanceError('MAINTENANCE_STALE', 'Saved work inventory could not be inspected.'); }
        },
      });
      if (acquired) {
        if (stopFirst && await checkExclusiveWork()) throw maintenanceError('MAINTENANCE_HELD', 'Another installer or database restore is still running; no update was started.');
        if (policy === 'manual') {
          const raced = [...await observedWork(), ...legacyWork()];
          if (raced.length) await requestInterruption(raced);
        }
        break;
      }
      if (stopFirst) {
        if (waitingTakeover && ++takeoverChecks <= 30) { await wait(); continue; }
        throw maintenanceError('MAINTENANCE_HELD', 'Another installer or database restore is still running; no update was started.');
      }
      signal?.throwIfAborted();
      await wait();
    }
    signal?.throwIfAborted();
    try { await recovery?.close(); recovery = null; }
    catch (error) { if (policy === 'automatic') throw error; }
    emit(`STEP:waiting:done:${policy === 'automatic' ? 'Install idle; update admission acquired' : 'Closing intake and stopping PortOS before changing the checkout'}`);
    const windows = platform === 'win32';
    const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(cwd, 'update.ps1')] : [join(cwd, 'update.sh')];
    const env = { ...process.env, PORTOS_DEFERRED_UPDATE_ID: operation.id };
    if (policy !== 'automatic') env.PORTOS_UPDATE_STOP_FIRST = '1';
    else delete env.PORTOS_UPDATE_STOP_FIRST;
    if (policy === 'interrupt') env.PORTOS_UPDATE_INTERRUPT = '1';
    else delete env.PORTOS_UPDATE_INTERRUPT;
    delete env.PORTOS_DEFERRED_UPDATE_LAUNCH_ID;
    const child = launch(windows ? 'powershell' : 'bash', args, {
      cwd, env,
      detached: !windows, stdio: 'inherit',
    });
    childStarted = true;
    const stop = () => {
      if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      } else child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', stop, { once: true });
    // Install terminal handlers in the spawn tick, before any await.
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, reason) => { signal?.removeEventListener('abort', stop); resolve({ code, signal: reason }); });
    });
    // A killed shell can leave npm/git descendants. Never release on leaf exit.
    if (!windows && child.pid) while (!absent(-child.pid)) await wait();
    const current = admission.deferredUpdate.get().operation;
    const terminal = current?.terminal;
    if (windows && current?.childPid && !terminal) throw Object.assign(new Error('Windows update settlement is unverified; admission remains held'), { code: 'UPDATE_UNVERIFIED' });
    const success = result.code === 0 && terminal?.success === true;
    admission.deferredUpdate.finish(operation.id, success);
    return success ? 0 : (Number.isInteger(result.code) && result.code > 0 ? result.code : 1);
  } catch (err) {
    // A spawn error proves no child started. Once launched, unknown settlement
    // remains held for the process-group reconciler instead of timing out.
    if (!childStarted || err.code === 'ENOENT' || err.code === 'EACCES') admission.deferredUpdate.finish(operation.id, false, { errorCode: err.code });
    throw err;
  } finally {
    try { await recovery?.close(); }
    catch (error) {
      if (policy === 'automatic') throw error;
      emit('STEP:cleanup:warning:Temporary activity session cleanup could not be verified');
    }
  }
}

export function enterUpdate(id, childPid, admission = maintenance) {
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error('Invalid update process identity');
  assertUpdateImageSafety({ dataDir: resolve(admission.directory, '..'), acknowledged: process.env.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED === '1' });
  admission.deferredUpdate.enter(id, childPid);
}

export async function settleInterruptedUpdate(id, { admission = maintenance, cwd = root, snapshot = snapshotLegacyProcesses, probeCwds = legacyProcessCwds } = {}) {
  for (const name of ['database-maintenance', 'database-restore-recovery.json']) {
    try { fs.lstatSync(join(admission.directory, '..', name)); throw new Error('Database restore or cutover is active; no reservations were retired.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const rows = await Promise.resolve().then(snapshot).catch(() => []);
  const inspected = Array.isArray(rows) ? rows : [];
  const services = ['server/start.js', 'server/index.js', 'server/cos-runner/index.js', 'browser/server.js', 'autofixer/server.js', 'autofixer/ui.js'];
  const alive = inspected.filter(row => !String(row.state ?? '').startsWith('Z'));
  const nodes = alive.map(row => ({ row, args: parseCommandArgs(String(row.command ?? '')) }))
    .filter(({ args }) => /^node(?:js|\.exe)?$/i.test(basename((args[0] ?? '').replaceAll('\\', '/'))));
  const cwds = await Promise.resolve().then(() => probeCwds(nodes.map(({ row }) => row.pid))).catch(() => new Map());
  const canonical = path => { try { return fs.realpathSync(path); } catch { return resolve(path); } };
  const servicePaths = services.map(path => canonical(join(cwd, path)));
  const survivor = nodes.find(({ row, args }) => {
    const script = args.slice(1).find(arg => !arg.startsWith('-'));
    return script && (isAbsolute(script) || cwds.has(row.pid)) && servicePaths.includes(canonical(isAbsolute(script) ? script : resolve(cwds.get(row.pid), script)));
  });
  if (survivor) throw new Error(`PortOS runtime PID ${survivor.row.pid} is still running outside the stopped PM2 apps. Stop that runtime, then retry the update; the checkout has not changed.`);
  if (observedDatabaseRestoreProcess(inspected)) throw new Error('A database restore process is still running; update stopped.');
  const state = createMaintenanceJournal(resolve(admission.directory, '..')).readForStatus();
  const preserveIds = state.operations.filter(op => op.id !== id && alive.some(row =>
    (/^(?:agent-|mv-|[a-f0-9-]{30,})/i.test(op.resource) && String(row.command ?? '').includes(op.resource))
    || (row.pid === op.pid && Number.isFinite(row.startedAt) && Math.abs(row.startedAt - Date.parse(op.startedAt)) <= 10000
      && /(?:^|[\s/\\])(?:ffmpeg|python[0-9.]*)(?:[\s]|$)/i.test(String(row.command ?? '')))))
    .map(op => op.id);
  return admission.deferredUpdate.settleInterrupted(id, { preserveIds });
}

async function enterPeerUpdate(id) {
  const { maintenance } = await import('../server/lib/maintenanceAdmission.js');
  assertUpdateImageSafety({ acknowledged: process.env.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED === '1' });
  const claim = maintenance.getExclusive();
  if (claim?.operation.operationId !== id || claim.phase !== 'in-flight'
    || claim.operation.intent.action !== 'portos.update' || maintenance.operations().length) {
    throw new Error('The peer update no longer owns exclusive maintenance');
  }
}

async function main() {
  const [command, id, pid, code] = process.argv.slice(2);
  if (command === '--enter') return enterUpdate(id, Number(pid));
  if (command === '--terminal') return maintenance.deferredUpdate.terminal(id, Number(pid), code === '0');
  if (command === '--peer-enter') return enterPeerUpdate(id);
  if (command === '--stopped') return settleInterruptedUpdate(id);
  if (command === '--recover') {
    const { operation } = maintenance.deferredUpdate.reconcile();
    if (operation) throw new Error('Update processes are alive or their liveness is unknown; admission remains held');
    return;
  }
  if (process.argv.slice(2).length > 1 || (command && !['--automatic', '--interrupt'].includes(command))) throw new Error('Use --automatic to wait for idle or --interrupt to acknowledge interruption.');
  const controller = new AbortController();
  const interrupt = () => controller.abort(Object.assign(new Error('Update interrupted'), { code: 'UPDATE_INTERRUPTED' }));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.exitCode = await runDeferredUpdate({ signal: controller.signal, policy: command === '--automatic' ? 'automatic' : command === '--interrupt' ? 'interrupt' : 'manual' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    const expected = ['UPDATE_INTERRUPTED', 'UPDATE_INTERRUPTION_REQUIRED', 'UPDATE_IMAGE_WORK', 'UPDATE_UNVERIFIED', 'MAINTENANCE_HELD', 'MAINTENANCE_STALE'].includes(err.code);
    const log = expected ? console.log : console.error;
    log(`${expected ? '🚫' : '❌'} Deferred update stopped: ${err.message}`);
    process.exitCode = 1;
  });
}
