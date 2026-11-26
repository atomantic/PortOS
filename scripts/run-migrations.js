#!/usr/bin/env node
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { runMigrations } from './lib/fileMigrationRunner.js';

// Vitest records this public entry even when a factory replaces all its exports.
// Keeping the implementation behind an import lets the record distinguish an
// actual migration reader, including one loaded through importOriginal.
export { runMigrations };
export { sourceDeclaresPurge } from './lib/fileMigrationRunner.js';
export { listPendingMigrations } from './lib/migrationLedger.js';

if (isDirectlyInvoked(import.meta.url)) {
  runMigrations().catch(err => {
    console.error(`❌ Migration failed: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
