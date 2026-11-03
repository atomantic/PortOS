import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { inspectOperatorActivity, runReservationDisposition } from './reconcile-maintenance-reservations.mjs';

let root, gate;
const deps = () => ({ gate, operator: 'local-operator', checkActivity: async () => {}, isDead: () => true });
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'reservation-cli-'));
  fs.mkdirSync(join(root, 'data'));
  fs.writeFileSync(join(root, 'data', 'media-jobs.json'), JSON.stringify({ jobs: [] }));
  gate = createMaintenanceAdmission(join(root, 'data'));
});

it('applies scoped survivor detection during an operator inspection', async () => {
  const hold = { id: '5f0fd467-7ed2-45c5-94ae-28732258a69c', revision: 1 };
  const idle = { jobs: [], agents: { trusted: true, active: 0 }, mind: { trusted: true, thinking: false },
    llm: { trusted: true, active: 0 }, extras: { imageTo3d: [] }, appOperations: [], renders: [],
    update: { inProgress: false }, backup: { inProgress: false } };
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
