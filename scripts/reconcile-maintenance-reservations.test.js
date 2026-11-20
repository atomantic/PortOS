import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { inspectOperatorActivity, runReservationDisposition } from './reconcile-maintenance-reservations.mjs';

let root, gate;
const deps = () => ({ gate, operator: 'local-operator', checkActivity: async () => {}, isDead: () => true });
const idle = { jobs: [], agents: { trusted: true, active: 0 }, mind: { trusted: true, thinking: false },
  llm: { trusted: true, active: 0 }, extras: { imageTo3d: [] }, appOperations: [], renders: [],
  update: { inProgress: false }, backup: { inProgress: false } };
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'reservation-cli-'));
  fs.mkdirSync(join(root, 'data'));
  fs.writeFileSync(join(root, 'data', 'media-jobs.json'), JSON.stringify({ jobs: [] }));
  gate = createMaintenanceAdmission(join(root, 'data'));
});

it('applies scoped survivor detection during an operator inspection', async () => {
  const hold = { id: '5f0fd467-7ed2-45c5-94ae-28732258a69c', revision: 1 };
  const fetcher = async url => ({ ok: true, json: async () => url.endsWith('/processing') ? idle : url.endsWith('/agents') ? [] : { hold } });
  const scoped = vi.fn(async () => { throw Object.assign(new Error('live scoped child'), { code: 'MAINTENANCE_STALE' }); });
  await expect(inspectOperatorActivity({ hold, apiOrigin: 'http://127.0.0.1:5553', runnerOrigin: 'http://127.0.0.1:5558',
    gate, root, fetcher, snapshot: async () => [], scoped })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  expect(scoped).toHaveBeenCalledOnce();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('previews and explicitly disposes the exact records against the selected install', async () => {
  gate.admit('media', 'saved-image').markUnsettled();
  gate.begin({ reason: 'Recovery', owner: 'Local operator' });
  const options = { ...deps(), checkActivity: async () => ({ pids: [], limitations: ['workspace-cwd-unavailable'] }) };
  const request = await runReservationDisposition(['inspect', '--install-root', root, '--reason', 'Reviewed inactive work'], options);
  const requestPath = join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  await expect(runReservationDisposition(['reconcile', requestPath, '--install-root', root], options)).rejects.toThrow('Usage:');
  expect(gate.operations()).toHaveLength(1);
  await expect(runReservationDisposition(['reconcile', requestPath, '--install-root', root, '--confirm-disposition'], options))
    .resolves.toMatchObject({ disposition: 'operator-disposed', outputCompleteness: 'unknown', operations: 1 });
  expect(gate.operations()).toEqual([]);
  const receipt = JSON.parse(fs.readFileSync(join(gate.directory, `reservation-disposition-${request.requestId}.json`), 'utf8'));
  expect(receipt.processInspectionLimitations).toEqual(['workspace-cwd-unavailable']);
});

it('requires fresh terminal runner evidence under the same hold and preserves live or unclassified owners', async () => {
  const agentId = 'agent-abandoned';
  const admitted = gate.admit('runner', agentId);
  gate.admit('runner', 'agent-unclassified');
  gate.admit('runner', 'agent-live-owner');
  const { hold } = gate.begin({ reason: 'Recovery', owner: 'Local operator' });
  const op = gate.operations().find(({ id }) => id === admitted.id);
  const owner = { id: agentId, completedAt: op.startedAt, pid: 42 };
  let evidenceHold = hold;
  const fetcher = async url => {
    const id = url.split('/').at(-1);
    return { ok: true, json: async () => {
      if (id === 'processing') return idle;
      if (id === 'agents') return [];
      if (id === 'maintenance') return { hold };
      if (id === agentId || id === 'agent-live-owner') return { hold: evidenceHold, owner: { ...owner, id } };
      return { hold, owner: null };
    } };
  };
  // Make the live reservation owner's PID distinct from the stale one.
  const statePath = join(gate.directory, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.revision += 1;
  const live = state.operations.find(({ resource }) => resource === 'agent-live-owner');
  live.pid = 43;
  live.startedAt = op.startedAt;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const checkActivity = (checkedHold, candidates) => inspectOperatorActivity({
    hold: checkedHold, candidates, gate, root, apiOrigin: 'http://127.0.0.1:5553',
    runnerOrigin: 'http://127.0.0.1:5558', fetcher, snapshot: async () => [], scoped: async () => [],
  });
  const options = { ...deps(), checkActivity, isDead: pid => pid !== 43 };
  const request = await runReservationDisposition(['inspect', '--install-root', root, '--reason', 'Reviewed inactive work'], options);
  expect(request.operations).toEqual([op]);
  const requestPath = join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const reconcile = (overrides = {}) => runReservationDisposition(['reconcile', requestPath, '--install-root', root, '--confirm-disposition'],
    { ...options, ...overrides });
  evidenceHold = { ...hold, revision: hold.revision + 1 };
  await expect(reconcile()).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  evidenceHold = hold;
  await expect(reconcile()).rejects.toThrow(/recorded owner process is still running/);
  await expect(reconcile({ isDead: pid => pid !== 42 })).rejects.toThrow(/recorded owner process is still running/);
  await expect(reconcile({ isDead: () => true })).resolves.toMatchObject({ operations: 1, outputCompleteness: 'unknown' });
  expect(gate.operations().map(({ resource }) => resource)).toEqual(['agent-unclassified', 'agent-live-owner']);
  await expect(reconcile()).resolves.toMatchObject({ replayed: true });
});
