#!/usr/bin/env node
// Operator interface for the admission boundary. This does NOT transfer data,
// stop existing writers, change mode, or authorize invoking db.sh migrate.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PATHS } from '../server/lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../server/lib/databaseMaintenanceJournal.js';

const journal = createDatabaseMaintenanceJournal();
const require = createRequire(import.meta.url);

function configuredEndpoints() {
  const { DATABASE_MODE, DATABASE_ENDPOINTS } = require(join(PATHS.installRoot, 'ecosystem.config.cjs'));
  if (!['native', 'docker'].includes(DATABASE_MODE) || !DATABASE_ENDPOINTS) {
    throw new Error('Database configuration is not a supported backend.');
  }
  return { source: DATABASE_ENDPOINTS[DATABASE_MODE], endpoints: DATABASE_ENDPOINTS };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'status' && args.length === 0) {
    const record = journal.read();
    // Endpoints are local-only; the operator-facing status needs only direction.
    return record ? { id: record.id, stage: record.stage, source: record.source.mode, target: record.target.mode } : { stage: 'idle' };
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
  if (command === 'cancel' && args.length === 1) {
    return journal.cancel(args[0], configuredEndpoints().source);
  }
  throw new Error('Usage: node scripts/database-maintenance.mjs status | begin <native|docker> <native|docker> | cancel <operation-id>');
}

try {
  console.log(JSON.stringify(main()));
} catch (err) {
  // No filesystem paths, connection details, or raw parser inputs in output.
  console.error(err.code === 'DATABASE_MAINTENANCE'
    ? 'Database maintenance is fenced; journal recovery is required.'
    : 'Database maintenance command refused. Check arguments, saved configuration, and operation identity; an existing or interrupted operation is never overwritten.');
  process.exitCode = 1;
}
