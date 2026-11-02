import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertUpdateImageSafety } from '../server/lib/updateImageGuard.js';
import { createMaintenanceJournal, maintenanceError, syncMaintenanceDirectory } from '../server/lib/maintenanceJournal.js';
import { createDeferredUpdateAdmission, processAbsent } from '../server/lib/maintenanceDeferredUpdate.js';
import * as fs from 'node:fs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const journal = createMaintenanceJournal();
const maintenance = { directory: journal.directory, deferredUpdate: createDeferredUpdateAdmission({
  transaction: journal.transaction, read: journal.readForStatus, makeId: randomUUID, error: maintenanceError,
  now: Date.now, directory: journal.directory, io: fs, syncDirectory: syncMaintenanceDirectory,
}) };
const readControl = async path => {
  try { return await readFile(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
};

/** Both launch paths arrive here before the script touches logs, git or PM2. */
export async function runDeferredUpdate({ admission = maintenance, launch = spawn, cwd = root,
  platform = process.platform, wait = () => delay(1000), absent = processAbsent,
  signal, emit = message => console.log(message), legacyRunning = async () => {
    const control = join(admission.directory, '..', 'update-detached');
    const raw = (await readControl(join(control, 'pid'))).trim();
    if (!raw) return false;
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid prior updater process identity');
    // Our service launcher publishes this supervisor's PID in the same directory.
    // A different live/unknown PID is retained conservatively, without importing
    // application dependencies that npm may currently be replacing.
    // A dead legacy shell without its supervisor's exit record may have left
    // descendants. Absence of that PID alone does not prove settlement.
    return pid !== process.pid && !(await readControl(join(control, 'exit'))).trim();
  } } = {}) {
  admission.deferredUpdate.reconcile();
  const operation = admission.deferredUpdate.request();
  let childStarted = false;
  try {
    emit('STEP:waiting:running:Waiting for admitted work to finish saving and cleanup');
    while (await legacyRunning() || !admission.deferredUpdate.acquire(operation.id)) {
      signal?.throwIfAborted();
      await wait();
    }
    signal?.throwIfAborted();
    emit('STEP:waiting:done:Install idle; update admission acquired');
    const windows = platform === 'win32';
    const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(cwd, 'update.ps1')] : [join(cwd, 'update.sh')];
    const child = launch(windows ? 'powershell' : 'bash', args, {
      cwd, env: { ...process.env, PORTOS_DEFERRED_UPDATE_ID: operation.id },
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
