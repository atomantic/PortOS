import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: vi.fn(),
}));

import { spawn } from '../lib/childProcess.js';
import { runStandardizeFlow } from './pm2Standardizer.js';

it.each(['status', 'branch'])('stops a hung git %s and refuses to apply without a backup', async (subcommand) => {
  const repo = await mkdtemp(join(tmpdir(), 'standardizer-backup-'));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  await mkdir(join(repo, '.git'));

  vi.mocked(spawn).mockReset().mockImplementation((_command, [arg]) => {
    const child = new EventEmitter();
    Object.assign(child, { kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    if (arg !== subcommand) queueMicrotask(() => child.emit('close', 0));
    return child;
  });
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());
  const apply = vi.fn();
  const pending = runStandardizeFlow(repo, null, {
    analyze: async () => ({ success: true, proposedChanges: { processes: [] } }),
    apply,
  });

  await vi.advanceTimersByTimeAsync(30_000);
  await expect(pending).resolves.toEqual({ success: false, error: `git ${subcommand} timed out after 30s` });
  expect(apply).not.toHaveBeenCalled();
});
