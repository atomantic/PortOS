#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { diagnoseOutputPublications, inspectOutputPublication, reconcileOutputPublication } from '../server/services/outputPublicationRecovery.js';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { isWorktreeRoot } from '../server/lib/dataRoot.js';
import { PATHS } from '../server/lib/paths.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export function runPublicationRecovery(argv, deps) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { 'install-root': { type: 'string' }, 'confirm-disposition': { type: 'boolean' } } });
  const root = values['install-root'];
  if (root !== undefined) {
    if (!isAbsolute(root) || !statSync(join(root, 'data')).isDirectory()) throw new Error('--install-root must name an existing absolute install root containing data/.');
    const data = join(root, 'data');
    deps = { data, gate: createMaintenanceAdmission(data) };
  } else if (!deps && isWorktreeRoot(PATHS.root)) {
    throw new Error('A worktree ignores PORTOS_DATA_ROOT. Pass --install-root <absolute-install-root> explicitly, or run from the install checkout.');
  }
  const [action, first, second, ...extra] = positionals;
  const confirmed = values['confirm-disposition'] === true;
  if (action === 'diagnose' && second === undefined && !confirmed) return diagnoseOutputPublications(first, deps);
  if (action === 'inspect' && first && second && extra.length === 0 && !confirmed)
    return inspectOutputPublication(first, JSON.parse(readFileSync(second, 'utf8')), deps);
  if (action === 'reconcile' && first && second === undefined && confirmed) {
    const receipt = reconcileOutputPublication(JSON.parse(readFileSync(first, 'utf8')), { ...deps, confirmDisposition: true });
    return { disposition: receipt.disposition, operationId: receipt.request.operation.id,
      uncertaintyStamp: receipt.request.operation.uncertaintyStamp, outputCompleteness: receipt.outputCompleteness,
      replayed: receipt.replayed ?? false };
  }
  throw new Error('Usage: node scripts/reconcile-output-publication.mjs diagnose [operation-id] | inspect <operation-id> <evidence-spec.json> | reconcile <inspected-request.json> --confirm-disposition [--install-root <absolute-install-root>]');
}

if (isDirectlyInvoked(import.meta.url)) {
  try { console.log(JSON.stringify(runPublicationRecovery(process.argv.slice(2)), null, 2)); }
  catch (error) {
    const log = error.code === 'MAINTENANCE_STALE' ? console.log : console.error;
    log(`${error.code === 'MAINTENANCE_STALE' ? '🚫' : '❌'} ${error.message}`);
    process.exitCode = 1;
  }
}
