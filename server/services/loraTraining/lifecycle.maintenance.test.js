import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const fixture = vi.hoisted(() => ({
  admission: null, child: null, run: null, queueJob: null,
  release: vi.fn(), save: vi.fn(), saveDataset: vi.fn(), read: vi.fn(), adopt: vi.fn(), attach: vi.fn(), active: null,
}));
vi.mock('../../lib/fileUtils.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('training-maintenance-') }));
vi.mock('../../lib/maintenanceAdmission.js', async importOriginal => ({
  ...await importOriginal(),
  maintenance: new Proxy({}, { get: (_target, property) => fixture.admission[property] }),
}));
vi.mock('os', async importOriginal => ({ ...await importOriginal(), platform: () => 'linux' }));
vi.mock('../../lib/childProcess.js', async importOriginal => ({
  ...await importOriginal(), spawn: vi.fn(() => { throw new Error('Unexpected real child launch'); }),
}));
vi.mock('../../lib/detachedSpawn.js', () => ({
  reattachDetached: (...args) => fixture.attach(...args), spawnDetached: vi.fn(), reapDetached: vi.fn(), isReattachable: vi.fn(),
}));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  adoptHeavyLocalJob: (...args) => fixture.adopt(...args),
  claimHeavyLocalJob: vi.fn(),
}));
vi.mock('./db.js', () => ({
  getRun: (...args) => fixture.read(...args),
  listActiveRuns: async () => fixture.active || [fixture.run],
  updateRun: (...args) => fixture.save(...args), getRunRequired: vi.fn(), listRuns: vi.fn(), deleteRun: vi.fn(),
}));
vi.mock('../settings.js', () => ({ getSettings: async () => ({ loraTraining: { stallWatchdog: false } }) }));
vi.mock('../loraDatasets.js', () => ({ updateDataset: (...args) => fixture.saveDataset(...args) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  assertMediaQueueRoom: vi.fn(), enqueueJob: vi.fn(), getJob: () => fixture.queueJob, mediaJobEvents: new EventEmitter(),
}));
vi.mock('./displayPower.js', () => ({ sleepDisplayForTraining: vi.fn(), wakeDisplay: vi.fn() }));

const { runTraining, initLoraTraining, cancel, trainingEvents } = await import('./index.js');
const { createMaintenanceAdmission } = await import('../../lib/maintenanceAdmission.js');
const { isReattachable, spawnDetached, reapDetached } = await import('../../lib/detachedSpawn.js');
const { PATHS } = await import('../../lib/fileUtils.js');
let fixtureNumber = 0;
beforeEach(() => {
  fixture.admission = createMaintenanceAdmission(join(PATHS.data, 'admission-fixtures', String(fixtureNumber++)));
  fixture.child = new EventEmitter();
  Object.assign(fixture.child, { pid: 101, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  fixture.run = { id: 'example-run', jobId: 'example-job', datasetId: 'example-dataset', params: { steps: 10 }, runtime: 'mflux' };
  fixture.queueJob = {};
  fixture.active = null;
  fixture.read.mockReset().mockImplementation(async () => fixture.run);
  fixture.attach.mockReset().mockImplementation(async () => fixture.child);
  fixture.adopt.mockReset().mockImplementation(async () => ({ ok: true, holder: { pid: fixture.child.pid },
    handoffTo: async () => {}, release: () => fixture.release() }));
  vi.mocked(isReattachable).mockReset().mockResolvedValue(false);
  fixture.release.mockReset().mockResolvedValue();
  fixture.save.mockReset().mockResolvedValue();
  fixture.saveDataset.mockReset().mockResolvedValue();
});
afterEach(() => { vi.useRealTimers(); trainingEvents.removeAllListeners(); });
afterAll(cleanupTempDataRoots);

describe('training physical settlement under maintenance', () => {
  it.each([
    { terminal: 'canceled', code: 1, canceled: true, persistence: 'run' },
    { terminal: 'no result', code: 0, canceled: false, persistence: 'run' },
    { terminal: 'nonzero exit', code: 1, canceled: false, persistence: 'run' },
    { terminal: 'dataset reset', code: 0, canceled: false, persistence: 'dataset' },
  ])('retains a blocker when $terminal persistence fails after physical close', async ({ code, canceled, persistence }) => {
    fixture.queueJob.cancelRequested = canceled;
    const save = persistence === 'run' ? fixture.save : fixture.saveDataset;
    save.mockRejectedValueOnce(new Error('Terminal storage unavailable'));
    const permit = fixture.admission.admit('media', 'example-job');
    let settlement;
    const failed = vi.fn(() => { settlement = permit.finish(); });
    trainingEvents.on('failed', failed);
    await permit.run(() => runTraining({ jobId: 'example-job', runId: 'example-run', reattach: true }));
    fixture.admission.begin({ reason: 'Drain trainer', owner: 'Operator' });
    fixture.child.exitCode = code;
    fixture.child.emit('close', code, null);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    await settlement;
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ error: 'finalize failed: Terminal storage unavailable' }));
    expect(fixture.admission.status()).toMatchObject({
      state: 'draining', blockers: [expect.objectContaining({ resource: 'example-job', unsettled: true })],
    });
    if (persistence === 'run') expect(fixture.saveDataset).not.toHaveBeenCalled();
    else expect(fixture.save).toHaveBeenCalledWith('example-run', expect.objectContaining({ status: 'failed' }));
    expect(cancel('example-job')).toBe(false);
  });

  it('waits for the dataset terminal write before releasing maintenance', async () => {
    const save = Promise.withResolvers();
    fixture.saveDataset.mockReturnValueOnce(save.promise);
    const permit = fixture.admission.admit('media', 'example-job');
    let settlement;
    const failed = vi.fn(() => { settlement = permit.finish(); });
    trainingEvents.on('failed', failed);
    await permit.run(() => runTraining({ jobId: 'example-job', runId: 'example-run', reattach: true }));
    fixture.admission.begin({ reason: 'Drain trainer', owner: 'Operator' });
    fixture.child.exitCode = 0;
    fixture.child.emit('close', 0, null);
    try {
      await vi.waitFor(() => expect(fixture.saveDataset).toHaveBeenCalledTimes(1));
      expect(failed).not.toHaveBeenCalled();
      expect(fixture.admission.status().state).toBe('draining');
    } finally {
      save.resolve();
      await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
      await settlement;
    }
    expect(fixture.admission.status().state).toBe('ready');
  });

  it('retains a blocker and emits failure when a pre-spawn dataset reset cannot persist', async () => {
    fixture.child = null;
    fixture.saveDataset.mockRejectedValueOnce(new Error('Dataset storage unavailable'));
    const permit = fixture.admission.admit('media', 'example-job');
    const failed = vi.fn();
    trainingEvents.on('failed', failed);
    fixture.admission.begin({ reason: 'Drain trainer', owner: 'Operator' });
    await permit.run(() => runTraining({ jobId: 'example-job', runId: 'example-run', reattach: true }));
    await permit.finish();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fixture.admission.status()).toMatchObject({
      state: 'draining', blockers: [expect.objectContaining({ resource: 'example-job', unsettled: true })],
    });
  });

  it.each([false, true])('waits for physical close and claim cleanup after a live error (cleanup fails: %s)', async cleanupFails => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cleanup = Promise.withResolvers();
    fixture.release.mockImplementation(async () => {
      await cleanup.promise;
      if (cleanupFails) throw new Error('Claim storage unavailable');
    });
    const permit = fixture.admission.admit('media', 'example-job');
    let settlement;
    const failed = vi.fn(() => { settlement = permit.finish(); });
    trainingEvents.on('failed', failed);
    const close = () => {
      fixture.child.exitCode = 1;
      fixture.child.emit('close', 1, null);
    };
    try {
      await permit.run(() => runTraining({ jobId: 'example-job', runId: 'example-run', reattach: true }));
      fixture.admission.begin({ reason: 'Drain trainer', owner: 'Operator' });
      fixture.child.emit('error', new Error('Signal transport failed'));
      expect(failed).not.toHaveBeenCalled();
      expect(fixture.release).not.toHaveBeenCalled();
      expect(cancel('example-job')).toBe(true);
      await vi.advanceTimersByTimeAsync(8000);
      expect(fixture.child.kill).toHaveBeenCalledWith('SIGKILL');
      close();
      await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledTimes(1));
      expect(failed).not.toHaveBeenCalled();
      expect(fixture.admission.status().state).toBe('draining');
      cleanup.resolve();
      await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
      await settlement;
      expect(fixture.save).toHaveBeenCalledWith('example-run', expect.objectContaining({
        status: 'failed', error: 'trainer process failed: Signal transport failed',
      }));
      expect(fixture.admission.status().state).toBe(cleanupFails ? 'draining' : 'ready');
      if (cleanupFails) expect(fixture.admission.status().blockers[0].unsettled).toBe(true);
      close();
      expect(failed).toHaveBeenCalledTimes(1);
      expect(cancel('example-job')).toBe(false);
    } finally {
      cleanup.resolve();
      close();
      await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
      await permit.finish();
    }
  });
});

it('observes an orphan survivor without spawning/reaping and settles explicit cancellation in retained history', async () => {
  fixture.queueJob = null;
  fixture.run.status = 'running';
  vi.mocked(isReattachable).mockResolvedValue(true);
  await initLoraTraining();
  expect(spawnDetached).not.toHaveBeenCalled();
  expect(reapDetached).not.toHaveBeenCalled();
  expect(fixture.child.listenerCount('close')).toBeGreaterThan(0);
  const { withRetiredDataRemoval } = await import('../../lib/retiredLoraTraining.js');
  await expect(withRetiredDataRemoval(async () => {})).rejects.toMatchObject({ code: 'MAINTENANCE_BUSY' });
  expect(cancel('example-job')).toBe(true);
  const originalSave = fixture.save.getMockImplementation();
  let finishRecord;
  fixture.save.mockImplementationOnce(() => new Promise(resolve => { finishRecord = resolve; }));
  fixture.child.emit('close', 1, 'SIGTERM');
  await vi.waitFor(() => expect(finishRecord).toBeTypeOf('function'));
  await expect(withRetiredDataRemoval(async () => {})).rejects.toMatchObject({ code: 'MAINTENANCE_BUSY' });
  finishRecord();
  fixture.save.mockImplementation(originalSave);
  await new Promise(resolve => setImmediate(resolve));
  await expect(withRetiredDataRemoval(async () => 'settled')).resolves.toBe('settled');
  await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledWith('example-run', expect.objectContaining({ status: 'canceled' })));
});


it.each(['database', 'attach', 'claim', 'refused claim'])('preserves a live orphan after %s failure and continues boot reconciliation', async failure => {
  fixture.queueJob = null;
  fixture.run.status = 'running';
  fixture.active = [fixture.run, { id: 'next-run', status: 'queued' }];
  vi.mocked(isReattachable).mockImplementation(async path => path.includes('example-run'));
  if (failure === 'database') fixture.read.mockRejectedValueOnce(new Error('Database unavailable'));
  if (failure === 'attach') fixture.attach.mockRejectedValueOnce(new Error('Observer unavailable'));
  if (failure === 'claim') fixture.adopt.mockRejectedValueOnce(new Error('Claim unavailable'));
  if (failure === 'refused claim') fixture.adopt.mockResolvedValueOnce({ ok: false, message: 'Accelerator occupied' });
  const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
  const before = mediaJobEvents.listenerCount('canceled');
  await expect(initLoraTraining()).resolves.toBeUndefined();
  expect(fixture.save).not.toHaveBeenCalledWith('example-run', expect.anything());
  expect(fixture.save).toHaveBeenCalledWith('next-run', expect.objectContaining({ status: 'failed' }));
  expect(mediaJobEvents.listenerCount('canceled')).toBe(before + 1);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.admission.status().blockers).toEqual(expect.arrayContaining([
    expect.objectContaining({ resource: 'example-job' }),
  ]));
  expect(spawnDetached).not.toHaveBeenCalled();
  expect(reapDetached).not.toHaveBeenCalled();
});
