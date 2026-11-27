import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../../lib/childProcess.js';
import { describeNeedsBlender, runPythonDescribe } from './describeRun.js';
import { blenderScratchDir } from './workspace.js';

vi.mock('../../lib/childProcess.js', async (load) => ({ ...await load(), spawn: vi.fn() }));
vi.mock('../../lib/processEnv.js', async (load) => ({
  ...await load(),
  whichFirst: async () => 'python3',
}));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: async () => ({ executionMode: 'trusted-local' }),
}));

describe.skipIf(process.platform === 'win32')('film Python process-group teardown', () => {
  let owner;
  let job;
  let child;
  let groupSignal;
  let spawned;

  beforeEach(async () => {
    owner = { workspaceDir: await mkdtemp(join(tmpdir(), 'film-describe-')) };
    const src = join(owner.workspaceDir, 'src');
    await mkdir(src);
    await writeFile(join(src, 'film.py'), 'def describe(ctx): return {"shots": []}\n');
    job = { src, jobId: 'test' };
    child = Object.assign(new EventEmitter(), {
      pid: 1234,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    spawned = Promise.withResolvers();
    spawn.mockImplementationOnce(() => {
      spawned.resolve();
      return child;
    });
    groupSignal = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    child.emit('close', 0);
    groupSignal.mockRestore();
    vi.useRealTimers();
    spawn.mockReset();
    await rm(owner.workspaceDir, { recursive: true, force: true });
  });

  it.each([
    {
      stage: 'import scan', limitMs: 10_000,
      run: (owner) => describeNeedsBlender(owner),
      expected: true,
    },
    {
      stage: 'code-only describe', limitMs: 300_000,
      run: (owner, job) => runPythonDescribe({ owner, song: {}, job }),
      expected: {
        ok: false, canceled: false, error: 'The film exceeded the 300s limit for listing shots',
        traceback: null, manifest: null, events: {},
      },
    },
  ])('stops a stalled $stage at its deadline', async ({ limitMs, run, expected }) => {
    const pending = run(owner, job);
    await spawned.promise;
    expect(spawn).toHaveBeenCalledWith('python3', expect.any(Array), expect.objectContaining({ detached: true }));

    await vi.advanceTimersByTimeAsync(limitMs - 1);
    expect(groupSignal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(groupSignal).not.toHaveBeenCalledWith(-child.pid, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(8_000);
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    await expect(pending).resolves.toEqual(expected);
  });

  it('escalates cancellation to the group after the leader and its pipes close', async () => {
    const controller = new AbortController();
    const pending = runPythonDescribe({ owner, song: {}, job, signal: controller.signal });
    await spawned.promise;
    const scratch = blenderScratchDir(owner, 'describe-test');

    controller.abort();
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    // The group probe still sees descendants even though no Python pipes remain open.
    await vi.advanceTimersByTimeAsync(7_999);
    expect(groupSignal).not.toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(existsSync(scratch)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(groupSignal).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    await expect(pending).resolves.toMatchObject({ ok: false, canceled: true, error: 'Canceled', manifest: null });
    expect(existsSync(scratch)).toBe(false);
  });
});
