#!/usr/bin/env node
// Operator interface for the admission boundary. This does NOT transfer data,
// stop existing writers, change mode, or authorize invoking db.sh migrate.
// Transfer, mode commit and restart run only inside the owned internal worker.
// `recover` relaunches that worker for the SAME recorded operation after its
// supervisor recorded an exit; there is no force, skip, or reverse command.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PATHS } from '../server/lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../server/lib/databaseMaintenanceJournal.js';
import { createDatabaseWriterRegistry } from '../server/lib/databaseWriterRegistry.js';
import { createDatabaseAuthority } from '../server/lib/databaseAuthority.js';

const journal = createDatabaseMaintenanceJournal();
const require = createRequire(import.meta.url);

function configuredEndpoints() {
  const { DATABASE_MODE, DATABASE_ENDPOINTS } = require(join(PATHS.installRoot, 'ecosystem.config.cjs'));
  if (!['native', 'docker'].includes(DATABASE_MODE) || !DATABASE_ENDPOINTS) {
    throw new Error('Database configuration is not a supported backend.');
  }
  return { source: DATABASE_ENDPOINTS[DATABASE_MODE], endpoints: DATABASE_ENDPOINTS };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'writers' && args.length === 0) {
    const counts = { unresolved: 0, launching: 0, launched: 0, exited: 0, abandoned: 0 };
    for (const writer of createDatabaseWriterRegistry().read()) counts[writer.state] += 1;
    return { ...counts, quiescenceVerified: false };
  }
  if (command === 'status' && args.length === 0) {
    const record = journal.read();
    // Endpoints are local-only; the operator-facing status needs only direction.
    if (!record) {
      const last = createDatabaseAuthority().read();
      return last ? { stage: 'idle', lastCutover: { id: last.operationId, source: last.source.mode, target: last.target.mode } } : { stage: 'idle' };
    }
    const coordinator = journal.coordinatorStatus(record.id);
    return { id: record.id, stage: record.stage, source: record.source.mode, target: record.target.mode,
      ...(coordinator.state === 'unclaimed' ? {} : { coordinator }),
      ...(['accepted', 'quiescing'].includes(record.stage) ? {} : { transfer: journal.transferStatus(record.id) }) };
  }
  if (command === 'begin' && args.length === 2) {
    const [sourceMode, targetMode] = args;
    const { source, endpoints } = configuredEndpoints();
    if (source.mode !== sourceMode || !['native', 'docker'].includes(targetMode) || targetMode === sourceMode) {
      throw new Error('Explicit source/target must match saved mode and name different backends.');
    }
    const record = journal.begin({ source, target: endpoints[targetMode] });
    return { id: record.id, stage: record.stage, source: sourceMode, target: targetMode };
  }
  if (command === 'recover' && args.length === 1) {
    const { recoverDatabaseCutover } = await import('../server/services/databaseMaintenanceCutover.js');
    return recoverDatabaseCutover(args[0]);
  }
  if (command === 'cancel' && args.length === 1) {
    return journal.cancel(args[0], configuredEndpoints().source);
  }
  throw new Error('Usage: node scripts/database-maintenance.mjs status | writers | begin <native|docker> <native|docker> | cancel <operation-id> | recover <operation-id>');
}

try {
  console.log(JSON.stringify(await main()));
} catch (err) {
  // No filesystem paths, connection details, or raw parser inputs in output.
  console.error(err.code === 'DATABASE_CUTOVER' ? err.message : err.code === 'DATABASE_MAINTENANCE'
    ? 'Database maintenance is fenced; journal recovery is required.'
    : 'Database maintenance command refused. Check arguments, saved configuration, and operation identity; an existing or interrupted operation is never overwritten.');
  process.exitCode = 1;
}
// `recover` leaves a detached worker running; its handle's log tailer must
// not hold this command open (a released worker never writes an exit receipt
// back into the archived control directory). Drain output first: pipes are
// asynchronous on macOS.
process.stdout.write('', () => process.stderr.write('', () => process.exit()));
