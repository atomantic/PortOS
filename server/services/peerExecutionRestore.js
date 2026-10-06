/** Restore hooks only. Does not create a grant or connect an execution adapter. */
import { createPeerExecutionLedger } from './peerExecutionLedger.js';
import { executionAuthorityError } from '../lib/peerExecutionAuthority.js';

async function receiverLedger({ repairSchema = false } = {}) {
  // Restore-only subtree: ordinary backup reads pay no Postgres/ledger imports.
  const [db, { PATHS }] = await Promise.all([import('../lib/db.js'), import('../lib/paths.js')]);
  if (repairSchema) await db.ensureSchema({ force: true });
  return createPeerExecutionLedger({ db, dataDir: PATHS.data });
}

export function _createPeerExecutionRestore({ receiver = receiverLedger } = {}) {
  const preparePeerExecutionRestore = async id => {
    const ledger = await receiver();
    await ledger.initialize();
    return ledger.prepareRestore(id);
  };
  const finishPeerExecutionRestore = async (id, { rolledBack = false } = {}) => {
    const ledger = await receiver({ repairSchema: rolledBack });
    // No transient ready epoch: legacy compatibility publishes its exact ID
    // directly as capturing under the shared PG lock, and resumes only that mode.
    const current = await ledger.adoptEmptyRestore(id);
    if (current.phase === 'ready' && current.settledRecoveryId === id) return current;
    if (rolledBack && current.phase === 'ready') return current;
    if (current.phase === 'capturing') {
      if (!rolledBack) throw executionAuthorityError('A committed restore lacks completed non-rewound execution capture.');
      // Generic recovery proved no replay session can commit and no receipt exists.
      // Capture the unchanged DB; never recapture a committed/unknown rewind.
      await ledger.prepareRestore(id);
    }
    return ledger.reconcileRestore(id);
  };
  return { preparePeerExecutionRestore, finishPeerExecutionRestore };
}

const restoreHooks = _createPeerExecutionRestore();
export const preparePeerExecutionRestore = restoreHooks.preparePeerExecutionRestore;
export const finishPeerExecutionRestore = restoreHooks.finishPeerExecutionRestore;
