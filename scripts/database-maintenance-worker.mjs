#!/usr/bin/env node
// Fixed internal worker entrypoint. No command, endpoint, environment, or
// control-directory arguments are accepted. It quiesces every owned writer and
// transfers the RECORDED operation (source dump → one target transaction). It
// never changes saved mode, restarts producers, or reopens admission: a
// committed import still awaits verified target restart (#8851).
import { runDatabaseTransfer } from '../server/services/databaseMaintenanceTransfer.js';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Invalid worker identity');
  const [id, token] = args;
  const result = await runDatabaseTransfer(id, token);
  console.log(JSON.stringify(result));
  // A committed import is NOT a successful cutover: saved mode, restart and
  // admission release belong to the verified-restart stage.
  console.error('⚠️ Database transfer imported; target restart verification is not yet integrated. Maintenance remains fenced.');
  process.exitCode = 78;
} catch (err) {
  // Never print tokens, paths, endpoints, or raw parser/OS exception messages.
  // Transfer and quiescence refusals carry only bounded, redacted reasons.
  console.error(['DATABASE_TRANSFER', 'DATABASE_WRITER_QUIESCENCE'].includes(err?.code)
    ? `⛔ ${err.message}`
    : '⛔ Database maintenance worker refused: ownership, writer, or transfer evidence is incomplete.');
  process.exitCode = 1;
}
