import { setTimeout as delay } from 'node:timers/promises';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { createDatabaseAuthority } from '../lib/databaseAuthority.js';

const RELEASE_TIMEOUT_MS = 300_000;
const POLL_MS = 250;

const refused = (reason) => Object.assign(
  new Error(`Database cutover boot refused: ${reason}. Maintenance remains fenced.`),
  { code: 'DATABASE_MAINTENANCE' },
);

/**
 * Narrow startup handshake for the ordinary server while a cutover is fenced.
 * Imports only the journal and the pool module — never routes, migrations,
 * schedulers or the CoS graph — so nothing writes before this returns.
 *
 * At `verifying`/`verified`, THIS process proves its own actual pool reaches
 * the recorded target (read-only; the pool's captured host/port/database/user
 * must equal the record), publishes that proof under its pid, and waits for
 * the coordinator to release admission. It returns only when the fence is gone
 * AND the released authority names this operation's target as this pool.
 * Any other stage, a wrong pool, an unhealthy target, or a different
 * operation throws and the process exits still fenced.
 */
export async function awaitDatabaseCutoverRelease({ releaseTimeoutMs = RELEASE_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  const journal = createDatabaseMaintenanceJournal();
  const operation = journal.read();
  if (!operation) return { released: false };
  if (!['verifying', 'verified'].includes(operation.stage)) throw refused(`stage ${operation.stage} does not admit a restart`);
  const { POOL_CONFIG, verifyDatabaseMaintenanceTarget } = await import('../lib/db.js');
  await verifyDatabaseMaintenanceTarget(operation.id).catch(() => {
    throw refused('this process could not prove the recorded target backend');
  });
  journal.recordTargetProof(operation.id, process.pid);
  console.log(`🗄️ Database cutover target verified by pid ${process.pid}; waiting for admission release`);

  const deadline = Date.now() + releaseTimeoutMs;
  while (journal.isFenced()) {
    const current = journal.read();
    if (current && (current.id !== operation.id || !['verifying', 'verified'].includes(current.stage))) {
      throw refused('the fenced operation changed');
    }
    if (Date.now() >= deadline) throw refused('admission was not released');
    await delay(pollMs);
  }
  const authority = createDatabaseAuthority();
  const released = authority.read();
  if (released?.operationId !== operation.id || !authority.sameEndpoint(POOL_CONFIG, released.target)) {
    throw refused('the released backend is not this process\'s pool');
  }
  return { released: true, id: operation.id };
}
