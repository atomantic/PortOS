/** Restore hooks only. Does not create a grant or connect an execution adapter. */
import { createPeerExecutionLedger } from './peerExecutionLedger.js';
import { executionAuthorityError } from '../lib/peerExecutionAuthority.js';

async function receiverLedger({ repairSchema = false } = {}) {
  // Restore-only subtree: ordinary backup reads pay no Postgres/ledger imports.
  const [db, { PATHS }] = await Promise.all([import('../lib/db.js'), import('../lib/paths.js')]);
  if (repairSchema) await db.ensureSchema({ force: true });
  return createPeerExecutionLedger({ db, dataDir: PATHS.data });
}

export async function preparePeerExecutionRestore(id) {
  const ledger = await receiverLedger();
  await ledger.initialize();
  return ledger.prepareRestore(id);
}

export async function finishPeerExecutionRestore(id, { rolledBack = false } = {}) {
  const ledger = await receiverLedger({ repairSchema: rolledBack });
  const before = ledger.authority.read();
  const current = await ledger.initialize();
  // A generic restore started by a version predating the ledger has no capture.
  // initialize only permits this when BOTH new tables are empty; no identity is lost.
  if (!before) return current;
  if (rolledBack && current.phase === 'ready') return current;
  if (current.phase === 'capturing') {
    if (!rolledBack) throw executionAuthorityError('A committed restore lacks completed non-rewound execution capture.');
    // Generic recovery proved no replay session can commit and no receipt exists.
    // Capture the unchanged DB; never recapture a committed/unknown rewind.
    await ledger.prepareRestore(id);
  }
  return ledger.reconcileRestore(id);
}
