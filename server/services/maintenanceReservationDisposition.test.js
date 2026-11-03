import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../lib/maintenanceJournal.js';
import { disposeInactiveReservations, inspectInactiveReservations, inspectLiveActivity } from './maintenanceReservationDisposition.js';

let root, gate;
const operator = 'local-operator';
const checkActivity = async () => {};
const isDead = () => true;
const inspect = () => inspectInactiveReservations({ gate, operator, reason: 'Reviewed inactive work', checkActivity, isDead });
const dispose = request => disposeInactiveReservations(request, { gate, operator, checkActivity, isDead });

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'reservation-disposition-'));
  gate = createMaintenanceAdmission(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('operator disposition of inactive reservations', () => {
  it('refuses to disposition a failed render with an observable live segment', async () => {
    const child = '12345678-1234-4234-8234-123456789abc';
    fs.writeFileSync(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [{ status: 'failed', videoExecutions: [{ childJobId: child }] }] }));
    gate.admit('media', 'outer');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    await expect(disposeInactiveReservations(request, { gate, operator, isDead, checkActivity: async () => ({
      pids: [], processes: [{ pid: 123, state: 'S', command: `python render.py --output /tmp/${child}.mp4` }],
    }) })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
  });
  it('preserves exact uncertain and settled records in a durable receipt, without touching other kinds', async () => {
    gate.admit('media', 'image-job').markUnsettled();
    gate.admit('settlement', 'Output publication').markUnsettled();
    gate.admit('provider', 'provider-call');
    gate.admit('agent', 'release-agent');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });

    const request = await inspect();
    expect(request.operations.map(op => op.kind)).toEqual(['media', 'settlement', 'provider']);
    const receipt = await dispose(request);
    expect(receipt).toMatchObject({ disposition: 'operator-disposed', outputCompleteness: 'unknown', request });
    expect(gate.operations().map(op => op.kind)).toEqual(['agent']);
    const saved = JSON.parse(fs.readFileSync(join(gate.directory, `reservation-disposition-${request.requestId}.json`), 'utf8'));
    expect(saved).toEqual(receipt);
    expect(await dispose(request)).toMatchObject({ ...receipt, replayed: true });
    expect(gate.operations().map(op => op.kind)).toEqual(['agent']);
  });

  it('disposes a legacy inventory under the exact hold while leaving runner ownership to its service', async () => {
    createMaintenanceJournal(root).transaction(state => {
      for (const [kind, count] of [['media', 25], ['settlement', 9], ['runner', 8], ['api-run', 4], ['provider', 3], ['music-video', 4]]) {
        for (let i = 0; i < count; i++) state.operations.push({ id: randomUUID(), kind,
          resource: kind === 'settlement' ? 'Output publication' : kind === 'runner' ? `agent-${i}` : `${kind}-${i}`,
          pid: 2147483647, startedAt: '2026-10-07T04:40:53.785Z', ...(i % 2 ? { unsettled: true } : {}) });
      }
    });
    fs.writeFileSync(join(root, 'media-jobs.json'), '{"jobs":[]}');
    const baseline = gate.operations();
    const { hold } = gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    const selected = baseline.filter(op => op.kind !== 'runner');
    expect(request.operations).toEqual(selected);
    const receipt = await disposeInactiveReservations(request, { gate, operator, checkActivity, isDead, requireMediaInventory: true });
    expect(receipt).toMatchObject({ disposition: 'operator-disposed', outputCompleteness: 'unknown' });
    expect(receipt.request.operations).toEqual(selected);
    expect(gate.operations()).toEqual(baseline.filter(op => op.kind === 'runner'));
    expect(JSON.parse(fs.readFileSync(join(gate.directory, `reservation-disposition-${request.requestId}.json`), 'utf8'))).toEqual(receipt);
    gate.resume({ id: hold.id, revision: hold.revision });
    expect(gate.status().state).toBe('normal');
  });

  it('refuses a recorded release candidate even when its task type is absent', async () => {
    gate.admit('runner', 'agent-release');
    fs.mkdirSync(join(root, 'cos', 'agents', 'agent-release'), { recursive: true });
    fs.writeFileSync(join(root, 'cos', 'agents', 'agent-release', 'metadata.json'),
      JSON.stringify({ id: 'agent-release', metadata: { releaseCandidate: { version: 1 } } }));
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    await expect(inspect()).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
  });

  it('refuses a changed reservation or newly live owner without producing a receipt', async () => {
    const permit = gate.admit('media', 'image-job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    permit.markUnsettled();
    await expect(dispose(request)).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
    expect(fs.readdirSync(gate.directory).filter(name => name.startsWith('reservation-disposition-'))).toEqual([]);

    const fresh = await inspect();
    await expect(disposeInactiveReservations(fresh, { gate, operator, checkActivity, isDead: () => false }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
  });

  it('refuses a service-owned hold and never accepts a release or updater reservation', async () => {
    gate.admit('media', 'job');
    gate.begin({ reason: 'Service work', owner: 'deferred-update' });
    await expect(inspect()).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
  });

  it('refuses when admitted work changes while activity is being checked', async () => {
    gate.admit('media', 'job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    const racingActivity = async () => { gate.admit('provider', 'continuation', { parentId: request.operations[0].id }); };
    await expect(disposeInactiveReservations(request, { gate, operator, checkActivity: racingActivity, isDead }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(2);
  });

  it('does not allow a forged request to retire release-agent reservations', async () => {
    gate.admit('media', 'job');
    gate.admit('agent', 'release-agent');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    request.operations.push(gate.operations().find(op => op.kind === 'agent'));
    await expect(dispose(request)).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(2);
  });

  it('refuses a reservation that settled after inspection without damaging the journal', async () => {
    const permit = gate.admit('media', 'job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    await permit.finish();
    await expect(dispose(request)).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.status().state).toBe('ready');
  });

  it.each(['null', '{}', '{"jobs":[{"status":"running"}]}'])('refuses an invalid or active saved media inventory: %s', async raw => {
    gate.admit('media', 'job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    fs.writeFileSync(join(root, 'media-jobs.json'), raw);
    await expect(disposeInactiveReservations(request, { gate, operator, checkActivity, isDead, requireMediaInventory: true }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
    expect(gate.status().state).not.toBe('unavailable');
  });

  it('requires the media inventory for operator recovery when media rows are selected', async () => {
    gate.admit('media', 'job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    await expect(disposeInactiveReservations(request, { gate, operator, checkActivity, isDead, requireMediaInventory: true }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
  });

  it('refuses if a media snapshot is replaced while being read', async () => {
    gate.admit('media', 'job');
    gate.begin({ reason: 'Recovery', owner: 'Local operator' });
    const request = await inspect();
    const path = join(root, 'media-jobs.json');
    fs.writeFileSync(path, '{"jobs":[]}');
    const io = { ...fs, readFileSync(fd, ...args) {
      const result = fs.readFileSync(fd, ...args);
      if (typeof fd === 'number') {
        fs.writeFileSync(`${path}.new`, '{"jobs":[{"status":"running"}]}');
        fs.renameSync(`${path}.new`, path);
      }
      return result;
    } };
    await expect(disposeInactiveReservations(request, { gate, operator, checkActivity, isDead, io, requireMediaInventory: true }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(gate.operations()).toHaveLength(1);
    expect(gate.status().state).not.toBe('unavailable');
  });
});

describe('fresh local activity check', () => {
  const hold = { id: '5f0fd467-7ed2-45c5-94ae-28732258a69c', revision: 1 };
  const idle = () => ({ jobs: [{ status: 'queued' }], agents: { trusted: true, active: 0 },
    mind: { trusted: true, thinking: false }, llm: { trusted: true, active: 0 },
    extras: { imageTo3d: [] }, appOperations: [], renders: [],
    update: { inProgress: false }, backup: { inProgress: false } });
  const fetcher = ({ activity = idle(), agents = [], status = { hold } } = {}) => async url => ({
    ok: true, json: async () => url.endsWith('/processing') ? activity : url.endsWith('/agents') ? agents : status,
  });
  const probe = fetch => inspectLiveActivity({ hold, apiOrigin: 'http://127.0.0.1:5553',
    runnerOrigin: 'http://127.0.0.1:5558', fetcher: fetch });

  it('accepts an idle held install with queued work preserved', async () => {
    await expect(probe(fetcher())).resolves.toBeUndefined();
  });
  it('checks the actual system maintenance endpoint on both sides of the activity read', async () => {
    const urls = [];
    await probe(async url => { urls.push(url); return fetcher()(url); });
    expect(urls.filter(url => url.endsWith('/api/system/maintenance'))).toHaveLength(2);
  });
  it('refuses active or unreadable work and a different install hold', async () => {
    await expect(probe(fetcher({ activity: { ...idle(), jobs: [{ status: 'running' }] } }))).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(probe(fetcher({ activity: { ...idle(), llm: { trusted: false, active: 0 } } }))).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(probe(fetcher({ agents: [{ id: 'agent-running' }] }))).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    await expect(probe(fetcher({ status: { hold: { ...hold, revision: 2 } } }))).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('does not send activity requests to a remote endpoint', async () => {
    await expect(inspectLiveActivity({ hold, apiOrigin: 'http://example.com', runnerOrigin: 'http://127.0.0.1:5558', fetcher: fetcher() }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
});
