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
  candidates = [], fetcher = fetch, snapshot = snapshotMaintenanceProcesses, scoped = assertNoScopedLegacyProcesses }) {
  const activity = await inspectLiveActivity({ hold, apiOrigin, runnerOrigin, token, fetcher });
  const operations = gate.operations();
  const processes = await snapshot();
  await assertNoObservedReservationProcesses(operations, root, async () => processes);
  const read = async path => {
    const response = await fetcher(`${apiOrigin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return response.ok ? response.json() : null;
  };
  const owners = new Map();
  const ordinaryOwnerIds = [];
  for (const op of candidates) {
    if (op.kind !== 'runner' || !/^agent-[a-z0-9-]+$/i.test(op.resource)) continue;
    const evidence = await read(`/api/system/maintenance/runner-owner/${encodeURIComponent(op.resource)}`);
    const owner = evidence?.owner;
    if (evidence?.hold?.id !== hold.id || evidence.hold.revision !== hold.revision
      || owner?.id !== op.resource || !(Date.parse(owner.completedAt) >= Date.parse(op.startedAt))) continue;
    owners.set(op.resource, owner);
    ordinaryOwnerIds.push(op.id);
  }
  const limitations = await scoped(operations, processes, { data: join(root, 'data'), codeRoot: root,
    idleProviderServices: activity.llm.directCallsTracked === true,
    loadAgent: async id => owners.get(id),
    loadApp: id => read(`/api/apps/${encodeURIComponent(id)}`),
    loadProvider: id => read(`/api/providers/${encodeURIComponent(id)}`) });
  const pids = [...owners.values()].filter(owner => owner.pid !== null)
    .map(({ pid, completedAt }) => ({ pid, completedAt }));
  return { pids, ordinaryOwnerIds, limitations, processes };
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
  const checkActivity = deps.checkActivity ?? (async (hold, candidates) => {
    const { token } = await resolveCredentials();
    return inspectOperatorActivity({ hold, apiOrigin: values['api-origin'], runnerOrigin: values['runner-origin'], token, gate, root, candidates });
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
