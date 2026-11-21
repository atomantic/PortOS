import { EventEmitter } from 'events';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/bufferedSpawn.js', async (load) => {
  const actual = await load();
  return {
    ...actual,
    prepareCliSpawn: vi.fn(actual.prepareCliSpawn),
    bufferedSpawn: vi.fn(),
  };
});
vi.mock('../../lib/childProcess.js', async (load) => ({ ...await load(), spawn: vi.fn() }));
vi.mock('../../lib/fileUtils.js', async (load) => ({ ...await load(), rmGuarded: vi.fn(async () => {}) }));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({
  withBackupAssetPublication: async (work) => work(),
  runOutsideBackupAssetPublication: (work) => work(),
}));
vi.mock('../../lib/maintenanceAdmission.js', () => ({
  maintenance: { continueSettlement: (work) => work(), markCurrentUnsettled: vi.fn() },
}));

import { bufferedSpawn, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { spawn } from '../../lib/childProcess.js';
import { rmGuarded } from '../../lib/fileUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { createCliImageJobRunner } from './cliJobRunner.js';
import { checkConnection as checkGrokConnection } from './grok.js';

const fakeProvider = { mode: 'example', provider: 'Example', defaultBin: 'example', timeoutMs: 5000 };
const register = (runner, jobId) => runner.registerJob({
  meta: { id: jobId, filename: `${jobId}.png` },
  renderStartedAtMs: Date.now(), scratchDir: 'scratch',
});

beforeEach(() => vi.clearAllMocks());

it('probes the Windows Grok shim using the prepared command with shell disabled', async () => {
  const bin = 'C:\\example\\grok.cmd';
  const prepare = await vi.importActual('../../lib/bufferedSpawn.js');
  prepareCliSpawn.mockImplementationOnce((command, args) => prepare.prepareCliSpawn(command, args, {}, true));
  bufferedSpawn.mockResolvedValueOnce({ code: 0, stdout: 'grok 0.2.7', stderr: '' });

  await expect(checkGrokConnection({ grokPath: bin })).resolves.toEqual({ connected: true, mode: 'grok', model: 'grok-cli 0.2.7' });
  expect(prepareCliSpawn).toHaveBeenCalledWith(bin, ['--version']);
  expect(bufferedSpawn).toHaveBeenCalledWith('cmd.exe', ['/c', bin, '--version'], {
    timeoutMs: 15_000, shell: false,
  });
});

it('reports the spawn error message without the Error wrapper', async () => {
  bufferedSpawn.mockResolvedValueOnce({ error: new Error('ENOENT') });
  await expect(checkGrokConnection()).resolves.toEqual({
    connected: false, mode: 'grok', reason: 'Grok CLI not found (ENOENT)',
  });
});

it('rolls back active and SSE state and removes scratch if registration throws', async () => {
  const runner = createCliImageJobRunner(fakeProvider);
  const fault = vi.spyOn(imageGenEvents, 'emit').mockImplementationOnce(() => { throw new Error('registration failed'); });
  try {
    await expect(register(runner, 'rejected-job')).rejects.toThrow('registration failed');
  } finally {
    fault.mockRestore();
  }
  expect(runner.getActiveJob()).toBeNull();
  expect(runner.attachSseClient('rejected-job', {})).toBe(false);
  expect(rmGuarded).toHaveBeenCalledExactlyOnceWith('scratch', { recursive: true, force: true });
  expect(spawn).not.toHaveBeenCalled();
});

it('settles an asynchronous spawn error and subsequent close only once, including extra cleanup', async () => {
  const runner = createCliImageJobRunner(fakeProvider);
  const job = await register(runner, 'spawn-error');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const cleanup = vi.fn();
  const discover = vi.fn();
  spawn.mockReturnValueOnce(child);
  const published = new Promise(resolve => imageGenEvents.once('failed', resolve));

  runner.run(job, { args: [], scratchDir: 'scratch', prepareAttempt: () => ({ cleanup, discover }) });
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -1, null);

  await expect(published).resolves.toMatchObject({ generationId: job.id, error: 'Failed to spawn example: ENOENT', inputProcessSettled: true });
  await vi.waitFor(() => expect(rmGuarded).toHaveBeenCalledTimes(1));
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(discover).not.toHaveBeenCalled();
  expect(runner.getActiveJobs()).toEqual([]);
});
