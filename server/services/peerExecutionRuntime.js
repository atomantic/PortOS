/** Lazy production composition. Reading setup never creates an execution grant. */
import { watch, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { createPeerExecutionLedger } from './peerExecutionLedger.js';
import { createPeerExecutionGrants } from './peerExecutionGrants.js';
import { createPeerExecutionReceiver } from './peerExecution.js';
import { withInstanceIdentityLock, registerInstanceExecutionAuthorityGuard } from './instanceIdentity.js';
import { peerAdminCaller, peerAdminIdentity } from './peerAdministration.js';

let singleton;
let io;
let watcher;
export function bindPeerExecutionIo(socketIo) { io = socketIo; }
export function peerExecutionRuntime() {
  singleton ??= compose();
  return singleton;
}
async function compose() {
  const db = await import('../lib/db.js');
  const adapters = await import('./peerExecutionAdapters.js');
  const ledger = createPeerExecutionLedger({ db, dataDir: PATHS.data });
  registerInstanceExecutionAuthorityGuard(() => ledger.authority.invalidate());
  const terminalProofs = new Map();
  const coordinator = createMaintenanceAdmission(PATHS.data, { verifyExclusiveReceipt: (claim, receipt) => {
    const proof = terminalProofs.get(claim.operation.operationId);
    return proof?.fingerprint === claim.fingerprint && proof.receiptDigest === receipt.receiptDigest && proof.outcome === receipt.outcome;
  } });
  const path = join(PATHS.data, 'peer-execution-grants.json');
  const grants = createPeerExecutionGrants({ ledger, identity: peerAdminIdentity,
    readStore: () => readJSONFile(path, { version: 1, grants: [] }, { strict: true, logError: false }),
    writeStore: store => atomicWrite(path, store) });
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const receiver = createPeerExecutionReceiver({ ledger, grants, coordinator, caller: peerAdminCaller, version, terminalProofs, identityLock: withInstanceIdentityLock,
    adapters: { prepare: adapters.preparePeerExecution, run: adapters.runPeerExecution, reconcile: adapters.reconcilePeerExecution },
    changed: () => io?.emit('peer-execution:changed'),
    resume: async input => (await import('./maintenanceControl.js')).resumeMaintenance(input) });
  return { ...receiver, ledger, coordinator };
}
export async function initializePeerExecution() {
  const receiver = await peerExecutionRuntime();
  // A new install remains silent and default-deny; no ledger/authority init at boot.
  if (receiver.ledger.authority.read()) await receiver.recover();
  if (!watcher) {
    assertNotRealDataWrite(receiver.coordinator.directory, 'peer execution drain notifications');
    mkdirSync(receiver.coordinator.directory, { recursive: true, mode: 0o700 });
    watcher = watch(receiver.coordinator.directory, () => receiver.kick());
    watcher.unref?.();
  }
}

export async function withPeerExecutionIdentityRestore(fn) {
  const { createPeerExecutionAuthority } = await import('../lib/peerExecutionAuthority.js');
  return withInstanceIdentityLock(async () => {
    createPeerExecutionAuthority(PATHS.data).invalidate();
    return fn();
  });
}
