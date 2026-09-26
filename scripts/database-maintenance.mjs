#!/usr/bin/env node
// Operator interface for the admission boundary. This does NOT transfer data,
// stop existing writers, change mode, or authorize invoking db.sh migrate.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PATHS } from '../server/lib/paths.js';
import { createDatabaseMaintenanceJournal } from '../server/lib/databaseMaintenanceJournal.js';

const journal = createDatabaseMaintenanceJournal();
const require = createRequire(import.meta.url);

function configuredSource() {
  const text = (() => {
    try { return readFileSync(join(PATHS.installRoot, '.env'), 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
  })();
  const mode = text.match(/^PGMODE=(\S+)/m)?.[1] || 'docker';
  const config = require(join(PATHS.installRoot, 'ecosystem.config.cjs'));
  const env = config.apps.find(app => app.name === 'portos-server')?.env;
  if (!env || !['native', 'docker'].includes(mode)) throw new Error('Database configuration is not a supported backend.');
  return { mode, host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE, user: env.PGUSER };
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
    const source = configuredSource();
    if (source.mode !== sourceMode || !['native', 'docker'].includes(targetMode) || targetMode === sourceMode) {
      throw new Error('Explicit source/target must match saved mode and name different backends.');
    }
    // Target ports are resolved from the saved mode-specific override, never
    // from the current process PGPORT (which belongs to the SOURCE).
    const text = (() => {
      try { return readFileSync(join(PATHS.installRoot, '.env'), 'utf8'); }
      catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
    })();
    const key = targetMode === 'native' ? 'PGPORT' : 'PGPORT_DOCKER';
    const port = Number(text.match(new RegExp('^' + key + '=(\\S+)', 'm'))?.[1] || (targetMode === 'native' ? 5432 : 5561));
    const record = journal.begin({ source, target: { ...source, mode: targetMode, port } });
    return { id: record.id, stage: record.stage, source: sourceMode, target: targetMode };
  }
  if (command === 'cancel' && args.length === 1) {
    return journal.cancel(args[0], configuredSource());
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
