import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRunOwner } from '../lib/aiToolkit/internal/runOwnership.js';
import { setAIToolkit } from './runner.js';
import { recoverInterruptedRuns } from './interruptedRunRecovery.js';

vi.mock('./providers.js', () => ({ isOllamaBackedProvider: () => false }));
const START = '2026-01-01T00:00:00.000Z';
const END = Date.parse(START) + 60_000;
const oldOwner = { id: 'previous-process', pid: 123456, startedAt: START };
const child = { pid: 123457, startedAt: START };
let directory;
let hooks;
const readRun = async id => JSON.parse(await readFile(join(directory, 'runs', id, 'metadata.json'), 'utf8'));
const seed = async (id, patch = {}) => {
  const path = join(directory, 'runs', id);
  await mkdir(path, { recursive: true });
  const run = { id, startTime: START, endTime: null, success: null,
    executionOwner: oldOwner, executionKind: 'cli', executionChild: child, ...patch };
  await writeFile(join(path, 'metadata.json'), JSON.stringify(run));
  await writeFile(join(path, 'output.txt'), 'preserved partial output');
  return run;
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'interrupted-runs-'));
  hooks = { onRunFailed: vi.fn(), onRunCanceled: vi.fn(), onRunCompleted: vi.fn() };
  setAIToolkit({ services: {} }, { dataDir: directory, hooks });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('boot interrupted-run recovery', () => {
  it('closes proven-dead CLI and API runs at observation time, preserving output without a provider fault', async () => {
    await seed('cli');
    await seed('api', { executionKind: 'api', executionChild: null });
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await recoverInterruptedRuns({ now: () => END })).toEqual({ recovered: 2 });
    expect(await readRun('cli')).toMatchObject({ endTime: new Date(END).toISOString(), duration: 60_000,
      success: false, canceled: true, errorCategory: 'canceled', completionReason: 'host-interrupted', endTimeSource: 'recovery-observation' });
    expect(await readFile(join(directory, 'runs', 'cli', 'output.txt'), 'utf8')).toBe('preserved partial output');
    expect(hooks.onRunCanceled).toHaveBeenCalledTimes(2);
    expect(hooks.onRunFailed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(await recoverInterruptedRuns({ now: () => END + 60_000 })).toEqual({ recovered: 0 });
    expect(hooks.onRunCanceled).toHaveBeenCalledTimes(2);
  });

  it('preserves current owners, live or unreadable processes, CoS runs and unknown or malformed identities', async () => {
    const fixtures = {
      current: { executionOwner: getRunOwner() },
      reusedOwnerPid: { executionOwner: { ...oldOwner, pid: getRunOwner().pid } },
      liveOwner: { executionOwner: { ...oldOwner, pid: 201 } },
      liveChild: { executionChild: { ...child, pid: 202 } },
      denied: { executionChild: { ...child, pid: 203 } },
      legacy: { executionOwner: undefined },
      pending: { executionChild: { pending: true } },
      malformed: { executionChild: { ...child, pid: '123457' } },
      apiUnknown: { executionKind: 'api', executionChild: undefined },
      cos: { agentId: 'agent-synthetic' },
      completed: { endTime: START, success: true },
    };
    const originals = Object.fromEntries(await Promise.all(Object.entries(fixtures).map(async ([id, patch]) => [id, await seed(id, patch)])));
    vi.spyOn(process, 'kill').mockImplementation(pid => {
      if (pid === 201 || pid === 202) return true;
      throw Object.assign(new Error('probe'), { code: pid === 203 ? 'EPERM' : 'ESRCH' });
    });
    expect(await recoverInterruptedRuns({ now: () => END })).toEqual({ recovered: 0 });
    for (const [id, original] of Object.entries(originals)) expect(await readRun(id)).toEqual(JSON.parse(JSON.stringify(original)));
    expect(hooks.onRunCanceled).not.toHaveBeenCalled();
  });
});
