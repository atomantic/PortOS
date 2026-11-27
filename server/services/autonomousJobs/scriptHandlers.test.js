import { EventEmitter } from 'node:events';
import { expect, it, onTestFinished, vi } from 'vitest';

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: vi.fn(),
}));
vi.mock('../agent/agentApiAuth.js', () => ({ resolveAgentApiEnv: async () => ({}) }));

import { spawn } from '../../lib/childProcess.js';
import { SCRIPT_HANDLERS } from './scriptHandlers.js';

function mockScriptChild() {
  const child = new EventEmitter();
  Object.assign(child, { kill: vi.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() });
  vi.mocked(spawn).mockReset().mockReturnValue(child);
  return child;
}

it('bounds a scheduled script to its configured duration plus five minutes', async () => {
  const child = mockScriptChild();
  vi.useFakeTimers();
  vi.stubEnv('MOLTWORLD_DURATION_MINUTES', '7');
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const pending = SCRIPT_HANDLERS['moltworld-exploration']();
  const rejection = expect(pending).rejects.toThrow('moltworld-explore.mjs timed out');
  await vi.advanceTimersByTimeAsync(719_999);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [expect.stringContaining('moltworld-explore.mjs'), '7'], expect.anything());
  expect(child.kill).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});

it('limits log output while preserving lines split across chunks', async () => {
  const child = mockScriptChild();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  const pending = SCRIPT_HANDLERS['moltworld-exploration']();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  child.stdout.emit('data', Buffer.from('par'));
  child.stdout.emit('data', Buffer.from(`tial\n${'line\n'.repeat(9998)}final`));
  child.stdout.emit('data', Buffer.from(' line\nexcess\n'));
  child.emit('close', 0);

  await expect(pending).resolves.toEqual({ success: true, lines: 10_000 });
  expect(log).toHaveBeenCalledWith('🌍 partial');
  expect(log).toHaveBeenCalledWith('🌍 final line');
  expect(log).not.toHaveBeenCalledWith('🌍 excess');
  expect(log).toHaveBeenLastCalledWith('🌍 Moltworld output limit reached');
});
