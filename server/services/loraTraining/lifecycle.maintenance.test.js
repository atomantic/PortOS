import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const fixture = vi.hoisted(() => ({ admission: null, child: null, release: vi.fn(), save: vi.fn() }));
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
  reattachDetached: async () => fixture.child, spawnDetached: vi.fn(), reapDetached: vi.fn(), isReattachable: vi.fn(),
}));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  adoptHeavyLocalJob: async () => ({ ok: true, holder: { pid: fixture.child.pid },
    handoffTo: async () => {}, release: () => fixture.release() }),
  claimHeavyLocalJob: vi.fn(),
}));
vi.mock('./db.js', () => ({
  getRun: async () => ({ id: 'example-run', jobId: 'example-job', params: { steps: 10 }, runtime: 'mflux' }),
  updateRun: (...args) => fixture.save(...args), getRunRequired: vi.fn(), listRuns: vi.fn(), deleteRun: vi.fn(),
}));
vi.mock('../settings.js', () => ({ getSettings: async () => ({ loraTraining: { stallWatchdog: false } }) }));
vi.mock('../loraDatasets.js', () => ({ updateDataset: vi.fn() }));
vi.mock('../mediaJobQueue/index.js', () => ({
  assertMediaQueueRoom: vi.fn(), enqueueJob: vi.fn(), getJob: vi.fn(), mediaJobEvents: new EventEmitter(),
}));
vi.mock('./displayPower.js', () => ({ sleepDisplayForTraining: vi.fn(), wakeDisplay: vi.fn() }));

const { runTraining, cancel, trainingEvents } = await import('./index.js');
const { createMaintenanceAdmission } = await import('../../lib/maintenanceAdmission.js');
const { PATHS } = await import('../../lib/fileUtils.js');
let fixtureNumber = 0;
beforeEach(() => {
  fixture.admission = createMaintenanceAdmission(join(PATHS.data, 'admission-fixtures', String(fixtureNumber++)));
  fixture.child = new EventEmitter();
  Object.assign(fixture.child, { pid: 101, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  fixture.release.mockReset().mockResolvedValue();
  fixture.save.mockReset().mockResolvedValue();
});
afterEach(() => { vi.useRealTimers(); trainingEvents.removeAllListeners(); });
afterAll(cleanupTempDataRoots);

describe('training physical settlement under maintenance', () => {
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
