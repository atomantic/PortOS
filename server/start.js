// Keep the application graph behind a dynamic import: top-level await in a
// sibling static import would allow other dependencies to evaluate meanwhile.
const args = process.argv.slice(2);
if (args.length === 0) {
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
