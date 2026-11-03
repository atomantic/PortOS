import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertUpdateImageSafety } from '../server/lib/updateImageGuard.js';
import { createMaintenanceJournal, maintenanceError, syncMaintenanceDirectory } from '../server/lib/maintenanceJournal.js';
import { createDeferredUpdateAdmission, processAbsent, reconcileReusedLaunch } from '../server/lib/maintenanceDeferredUpdate.js';
import * as fs from 'node:fs';
import { legacyLauncherGroups, legacyProcessCwds, observedDatabaseRestoreProcess, observedLegacyUpdate, observedLocalMediaProcesses, snapshotLegacyProcesses } from './lib/legacyUpdateActivity.mjs';
import { isCompletedLocalClaim, remoteMediaRecoveryPending } from '../server/lib/mediaRecoveryActivity.js';

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
    if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.some(job => !job || typeof job !== 'object'
      || !['queued', 'running', 'completed', 'failed', 'canceled'].includes(job.status))) throw new Error('Invalid saved media inventory');
    return snapshot.jobs;
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
  signal, emit = message => console.log(message), legacyRunning } = {}) {
  let reportedLegacyLimit = false;
  const heavyObservation = {};
  const checkLegacy = legacyRunning ?? (async () => {
    const control = join(admission.directory, '..', 'update-detached');
    const raw = (await readControl(join(control, 'pid'))).trim();
    const pid = raw ? Number(raw) : null;
    if (raw && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid prior updater process identity');
    const priorAt = raw ? (await fs.promises.stat(join(control, 'pid'))).mtimeMs : null;
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
    const localMedia = await observedLocalMediaProcesses(rows, savedMediaJobs(admission), resolve(admission.directory, '..'),
      { platform, probeCwds: legacyCwds });
    if ((observed.limitations.length || localMedia.limitations.length || groupInspectionUnavailable) && !reportedLegacyLimit) {
      reportedLegacyLimit = true;
      emit('STEP:waiting:running:Some legacy work could not be inspected fully');
    }
    return observed.running || localMedia.running || observedDatabaseRestoreProcess(rows);
  });
  await reconcileReusedLaunch(admission, () => legacySnapshot(platform));
  admission.deferredUpdate.reconcile();
  const operation = launchId ? admission.deferredUpdate.claimLaunch(launchId) : admission.deferredUpdate.request();
  let childStarted = false;
  try {
    emit('STEP:waiting:running:Waiting for admitted work to finish saving and cleanup');
    for (;;) {
      const externalWorkPending = await checkLegacy();
      const heavyPath = join(admission.directory, '..', 'heavy-local-job.claim.json');
      const processes = fs.existsSync(heavyPath) ? await legacySnapshot(platform) : [];
      const acquired = admission.deferredUpdate.acquire(operation.id, {
        externalWorkPending, checkExternal: () => {
          try {
            const dbRecovery = join(admission.directory, '..', 'database-restore-recovery.json');
            let databasePending;
            try { fs.lstatSync(dbRecovery); databasePending = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; databasePending = false; }
            return databasePending || savedMediaPending(admission) || legacyHeavyClaimPending(admission, processes, absent, heavyObservation, emit);
          }
          catch { throw maintenanceError('MAINTENANCE_STALE', 'Saved work inventory could not be inspected.'); }
        },
      });
      if (acquired) break;
      signal?.throwIfAborted();
      await wait();
    }
    signal?.throwIfAborted();
    emit('STEP:waiting:done:Install idle; update admission acquired');
    const windows = platform === 'win32';
    const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(cwd, 'update.ps1')] : [join(cwd, 'update.sh')];
    const env = { ...process.env, PORTOS_DEFERRED_UPDATE_ID: operation.id };
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
    if (!childStarted || err.code === 'ENOENT' || err.code === 'EACCES') admission.deferredUpdate.finish(operation.id, false);
    throw err;
  }
}

export function enterUpdate(id, childPid, admission = maintenance) {
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error('Invalid update process identity');
  assertUpdateImageSafety({ dataDir: resolve(admission.directory, '..'), acknowledged: process.env.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED === '1' });
  admission.deferredUpdate.enter(id, childPid);
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
  if (command === '--recover') {
    const { operation } = maintenance.deferredUpdate.reconcile();
    if (operation) throw new Error('Update processes are alive or their liveness is unknown; admission remains held');
    return;
  }
  if (command) throw new Error('Unknown deferred update command');
  const controller = new AbortController();
  const interrupt = () => controller.abort(Object.assign(new Error('Update interrupted'), { code: 'UPDATE_INTERRUPTED' }));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.exitCode = await runDeferredUpdate({ signal: controller.signal });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    const expected = ['UPDATE_INTERRUPTED', 'UPDATE_IMAGE_WORK', 'UPDATE_UNVERIFIED', 'MAINTENANCE_HELD', 'MAINTENANCE_STALE'].includes(err.code);
    const log = expected ? console.log : console.error;
    log(`${expected ? '🚫' : '❌'} Deferred update stopped: ${err.message}`);
    process.exitCode = 1;
  });
}
