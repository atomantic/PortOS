#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { disposeInactiveReservations, inspectInactiveReservations, inspectLiveActivity } from '../server/services/maintenanceReservationDisposition.js';
import { assertNoObservedReservationProcesses, snapshotMaintenanceProcesses } from '../server/services/maintenanceProcessInventory.js';
import { assertNoScopedLegacyProcesses } from '../server/services/maintenanceScopedProcesses.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { resolveCredentials } from './portos-api.js';

export async function inspectOperatorActivity({ hold, apiOrigin, runnerOrigin, token, gate, root,
  fetcher = fetch, snapshot = snapshotMaintenanceProcesses, scoped = assertNoScopedLegacyProcesses }) {
  await inspectLiveActivity({ hold, apiOrigin, runnerOrigin, token, fetcher });
  const operations = gate.operations();
  const processes = await snapshot();
  await assertNoObservedReservationProcesses(operations, root, async () => processes);
  const read = async path => {
    const response = await fetcher(`${apiOrigin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return response.ok ? response.json() : null;
  };
  const limitations = await scoped(operations, processes, { data: join(root, 'data'), codeRoot: root,
    loadApp: id => read(`/api/apps/${encodeURIComponent(id)}`),
    loadProvider: id => read(`/api/providers/${encodeURIComponent(id)}`) });
  return { pids: [], limitations, processes };
}

export async function runReservationDisposition(argv, deps = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'install-root': { type: 'string' }, reason: { type: 'string' },
    'api-origin': { type: 'string', default: 'http://127.0.0.1:5553' },
    'runner-origin': { type: 'string', default: 'http://127.0.0.1:5558' },
    'confirm-disposition': { type: 'boolean' },
  } });
  const root = values['install-root'];
  if (!root || !isAbsolute(root) || !statSync(join(root, 'data')).isDirectory())
    throw new Error('--install-root must name the absolute install root containing data/.');
  const gate = deps.gate ?? createMaintenanceAdmission(join(root, 'data'));
  const operator = deps.operator ?? userInfo().username;
  const checkActivity = deps.checkActivity ?? (async hold => {
    const { token } = await resolveCredentials();
    return inspectOperatorActivity({ hold, apiOrigin: values['api-origin'], runnerOrigin: values['runner-origin'], token, gate, root });
  });
  const [action, requestPath, ...extra] = positionals;
  if (action === 'inspect' && !requestPath && !extra.length && values.reason && !values['confirm-disposition'])
    return inspectInactiveReservations({ gate, operator, reason: values.reason, checkActivity, isDead: deps.isDead });
  if (action === 'reconcile' && requestPath && !extra.length && !values.reason && values['confirm-disposition']) {
    const receipt = await disposeInactiveReservations(JSON.parse(readFileSync(requestPath, 'utf8')), { gate, operator, checkActivity,
      isDead: deps.isDead, requireMediaInventory: true });
    return { requestId: receipt.request.requestId, disposition: receipt.disposition,
      outputCompleteness: receipt.outputCompleteness, operations: receipt.request.operations.length,
      replayed: receipt.replayed ?? false };
  }
  throw new Error('Usage: reconcile-maintenance-reservations.mjs inspect --install-root <path> --reason <reason> | reconcile <request.json> --install-root <path> --confirm-disposition');
}

if (isDirectlyInvoked(import.meta.url)) {
  runReservationDisposition(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`❌ Reservation disposition stopped: ${error.message}`); process.exitCode = 1; });
}
