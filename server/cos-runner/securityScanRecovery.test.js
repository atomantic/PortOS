import { expect, it, vi } from 'vitest';
import { cleanupSecurityScanGroup } from './securityScanRecovery.js';

const owner = { pid: 1234, startedAt: 10000, marker: '00000000-0000-4000-8000-000000000001', outputDir: '/example/private/scan-one' };
it.skipIf(process.platform === 'win32')('reaps proven detached descendants after their scanner leader exits', async () => {
  const signal = vi.fn();
  const processes = async () => signal.mock.calls.length ? [] : [{ pid: 1235, pgid: 1234, startedAt: 11000, state: 'S', command: 'worker' }];
  expect(await cleanupSecurityScanGroup(owner, { processes, marked: async () => true, signal })).toBe(true);
  expect(signal).toHaveBeenCalledWith(1234, 'SIGKILL');
});
it.skipIf(process.platform === 'win32')('confirms a freshly empty group when its last descendant exits before marker verification', async () => {
  const signal = vi.fn();
  const processes = vi.fn()
    .mockResolvedValueOnce([{ pid: 1235, pgid: 1234, startedAt: 11000, state: 'S', command: 'worker' }])
    .mockResolvedValue([]);
  const marked = vi.fn(async () => { throw Object.assign(new Error('Synthetic process exited'), { code: 'ESRCH' }); });
  expect(await cleanupSecurityScanGroup(owner, { processes, marked, signal })).toBe(true);
  expect(marked).toHaveBeenCalledWith(1235, owner.marker);
  expect(processes).toHaveBeenCalledTimes(2);
  expect(signal).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('never signals a leader whose start time matches but whose command lacks the output-directory proof', async () => {
  const signal = vi.fn();
  const processes = async () => signal.mock.calls.length ? [] : [{ pid: 1234, pgid: 1234, startedAt: owner.startedAt, state: 'S', command: 'unrelated-process' }];
  expect(await cleanupSecurityScanGroup(owner, { processes, marked: async () => true, signal })).toBe(false);
  expect(signal).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('never signals a reused group leader or an unverified descendant', async () => {
  const signal = vi.fn();
  const processes = vi.fn(async () => [{ pid: 1234, pgid: 1234, startedAt: 90000, state: 'S', command: owner.outputDir }]);
  expect(await cleanupSecurityScanGroup(owner, { processes, marked: async () => true, signal })).toBe(false);
  expect(processes).toHaveBeenCalledTimes(2);
  const unverified = vi.fn(async () => [{ pid: 1235, pgid: 1234, state: 'S' }]);
  expect(await cleanupSecurityScanGroup(owner, { processes: unverified, marked: async () => false, signal })).toBe(false);
  expect(unverified).toHaveBeenCalledTimes(2);
  expect(signal).not.toHaveBeenCalled();
});
