// Evaluate before importing either managed process's application graph.
import { createDatabaseMaintenanceJournal } from './lib/databaseMaintenanceJournal.js';

// Keep the application graph behind a dynamic import: top-level await in a
// sibling static import would allow other dependencies to evaluate meanwhile.
const args = process.argv.slice(2);
if (args.length === 0) {
  // A fenced cutover admits exactly one path: the verifying/verified handshake,
  // which proves this process's own pool and waits for release. Every other
  // stage (or a damaged journal) refuses before any writer can start.
  if (createDatabaseMaintenanceJournal().isFenced()) {
    const { awaitDatabaseCutoverRelease } = await import('./services/databaseCutoverHandshake.js');
    try {
      await awaitDatabaseCutoverRelease();
    } catch (err) {
      console.error(`❌ ${err.code === 'DATABASE_MAINTENANCE' ? err.message : 'Database maintenance is fenced; boot refused.'}`);
      process.exit(1);
    }
  }
  // A committed snapshot database restore awaiting repair (#9725). Finish it
  // before any writer, scheduler or route can load: resolve an unknown replay
  // outcome from its receipt, then repair. It never replays the dump. Anything
  // short of a completed recovery (including an unreadable journal) refuses
  // boot with the fence still closed; a restart alone is never success.
  const { createDatabaseRestoreRecovery } = await import('./lib/databaseRestoreRecovery.js');
  if (createDatabaseRestoreRecovery().isFenced()) {
    const { resumeDatabaseRestore } = await import('./services/backupRestoreRecovery.js');
    const result = await resumeDatabaseRestore().catch(err => ({ status: 'failed', reason: err.code || 'restore_recovery_error', error: err.message }));
    if (result.status !== 'ok') {
      console.error(`❌ Database restore recovery is still pending (${result.reason}); boot refused. ${result.error || ''}`.trim());
      process.exit(1);
    }
    console.log(`💾 Database restore recovery finished at boot (${result.outcome})`);
  }
  await import('./services/databaseBootFence.js');
  await import('./index.js');
} else if (args.length === 2 && args[0] === '--verify-database') {
  // This mode never imports routes, migrations, schedulers, or the CoS graph.
  // Even success exits with the persistent admission fence still closed.
  const { verifyDatabaseMaintenanceTarget, close } = await import('./lib/db.js');
  try {
    console.log(JSON.stringify(await verifyDatabaseMaintenanceTarget(args[1])));
  } catch {
    // Connection/parser errors may contain credentials or local identities.
    console.error('❌ Database target verification refused; maintenance remains fenced.');
    process.exitCode = 1;
  } finally {
    await close();
  }
} else {
  console.error('❌ Usage: node server/start.js [--verify-database <operation-id>]');
  process.exitCode = 1;
}
