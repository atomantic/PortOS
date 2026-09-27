#!/usr/bin/env node
// Fixed internal worker entrypoint. No command, endpoint, environment, or
// control-directory arguments are accepted. It quiesces every owned writer,
// transfers the RECORDED operation (source dump → one target transaction),
// commits the saved mode, restarts the server with it, and releases admission
// only after that restarted process proved its own pool reached the target.
import { runDatabaseCutover } from '../server/services/databaseMaintenanceCutover.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Invalid worker identity');
  const [id, token] = args;
  console.log(JSON.stringify(await runDatabaseCutover(id, token)));
} catch (err) {
  // Never print tokens, paths, endpoints, or raw parser/OS exception messages.
  // Cutover, transfer and quiescence refusals carry only bounded reasons.
  console.error(['DATABASE_CUTOVER', 'DATABASE_TRANSFER', 'DATABASE_WRITER_QUIESCENCE'].includes(err?.code)
    ? `⛔ ${err.message}`
    : '⛔ Database maintenance worker refused: ownership, writer, or transfer evidence is incomplete.');
  process.exitCode = 1;
}
