#!/usr/bin/env node
// Fixed internal worker entrypoint. No command, endpoint, environment, or
// control-directory arguments are accepted. This slice inspects prerequisites;
// it never stops writers, exports/imports data, commits mode, or opens admission.
import { createDatabaseMaintenanceJournal } from '../server/lib/databaseMaintenanceJournal.js';
import { createDatabaseWriterRegistry } from '../server/lib/databaseWriterRegistry.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Invalid worker identity');
  const [id, token] = args;
  const journal = createDatabaseMaintenanceJournal();
  const operation = journal.enterCoordinatorWorker(id, token);
  const writers = { unresolved: 0, launching: 0, launched: 0, exited: 0, abandoned: 0 };
  for (const writer of createDatabaseWriterRegistry().read()) writers[writer.state] += 1;
  journal.assertCoordinatorWorker(id, token);
  console.log(JSON.stringify({ id: operation.id, stage: operation.stage,
    source: operation.source.mode, target: operation.target.mode, writers,
    quiescenceVerified: false, transferReady: false }));
  // Successful inspection is NOT a successful cutover. Even an empty registry
  // cannot exclude legacy children or an admitted producer still starting one.
  console.error('⛔ Database transfer refused: writer shutdown and descendant reconciliation are not yet integrated.');
  process.exitCode = 78;
} catch {
  // Never print tokens, paths, endpoints, or raw parser/OS exception messages.
  console.error('⛔ Database maintenance worker refused: ownership or inventory evidence is incomplete.');
  process.exitCode = 1;
}
