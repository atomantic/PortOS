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
