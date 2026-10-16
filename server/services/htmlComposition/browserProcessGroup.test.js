import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const observation = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../lib/childProcess.js', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: observation.read }) };
});
const { drainBrowserProcessGroup, signalBrowserProcessGroup } = await import('./browserProcessGroup.js');
const group = 12345;
const snapshot = (...rows) => ({ stdout: [`${process.pid} 1 S`, ...rows].join('\n') });
let signal;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  signal = vi.spyOn(process, 'kill').mockReturnValue(true);
  observation.read.mockReset().mockResolvedValue(snapshot());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('does not signal an empty or zombie-only owned group', async () => {
  observation.read.mockResolvedValue(snapshot(`23456 ${group} Z`));
  await drainBrowserProcessGroup(group, 500, 100);
  expect(signal).not.toHaveBeenCalled();
  expect(observation.read).toHaveBeenCalledWith('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], expect.objectContaining({ timeout: 500 }));
});

it('requires observed quiescence after accepted signals and escalates surviving descendants', async () => {
  observation.read.mockResolvedValue(snapshot(`23456 ${group} S`));
  let settled = false;
  const drain = drainBrowserProcessGroup(group, 500, 100).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(100);
  expect(signal.mock.calls).toEqual([[-group, 'SIGTERM'], [-group, 'SIGKILL']]);
  expect(settled).toBe(false);
  observation.read.mockResolvedValue(snapshot(`23456 ${group} Z`));
  await vi.advanceTimersByTimeAsync(25);
  await drain;
  expect(settled).toBe(true);
});

it.each([
  ['reused leader', () => snapshot(`${group} ${group} S`), /identity changed/],
  ['malformed output', () => ({ stdout: 'invalid' }), /observation failed/],
  ['incomplete output', () => ({ stdout: '23456 1 S' }), /observation failed/],
])('refuses to signal on %s', async (_, result, error) => {
  observation.read.mockResolvedValue(result());
  await expect(drainBrowserProcessGroup(group, 500, 100)).rejects.toThrow(error);
  expect(signal).not.toHaveBeenCalled();
});

it('fails closed when process observation is unavailable without exposing output', async () => {
  observation.read.mockRejectedValue(new Error('/private/command'));
  await expect(drainBrowserProcessGroup(group, 500, 100)).rejects.toThrow(/^Composition browser group observation failed \(groupSignalError=none, groupFailedSignal=none, groupFailedPhase=none\)$/);
  expect(signal).not.toHaveBeenCalled();
});

it('rejects within the retained deadline if accepted signals do not stop writers', async () => {
  observation.read.mockResolvedValue(snapshot(`23456 ${group} S`));
  const verdict = expect(drainBrowserProcessGroup(group, 100, 25)).rejects.toThrow(/exceeded its deadline/);
  await vi.advanceTimersByTimeAsync(100);
  await verdict;
  expect(signal.mock.calls).toEqual([[-group, 'SIGTERM'], [-group, 'SIGKILL']]);
});

it.each(['EPERM', '/private/code'])('retains signal failure %s until the deadline without signaling again', async code => {
  observation.read.mockResolvedValue(snapshot(`23456 ${group} S`));
  signal.mockImplementation(() => { throw Object.assign(new Error('/private/path'), { code }); });
  const expected = code === 'EPERM' ? 'EPERM' : 'other';
  const verdict = expect(drainBrowserProcessGroup(group, 100, 25)).rejects.toThrow(`Composition browser group cleanup exceeded its deadline (groupSignalError=${expected}, groupFailedSignal=SIGTERM, groupFailedPhase=drain)`);
  await vi.advanceTimersByTimeAsync(100);
  await verdict;
  expect(signal).toHaveBeenCalledExactlyOnceWith(-group, 'SIGTERM');
});

it.each(['SIGTERM', 'SIGKILL'])('requires observed quiescence after failed %s, preserving one safe diagnostic', async failedSignal => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  observation.read.mockResolvedValue(snapshot(`23456 ${group} S`));
  signal.mockImplementation((_, name) => {
    if (name === failedSignal) throw Object.assign(new Error('/private'), { code: 'EPERM' });
    return true;
  });
  let settled = false;
  const drain = drainBrowserProcessGroup(group, 500, 25).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(75);
  expect(settled).toBe(false);
  expect(signal).toHaveBeenCalledTimes(failedSignal === 'SIGTERM' ? 1 : 2);
  observation.read.mockResolvedValue(snapshot(`23456 ${group} Z`));
  await vi.advanceTimersByTimeAsync(25);
  await drain;
  expect(warning).toHaveBeenCalledExactlyOnceWith(`⚠️ Composition browser group quiesced after signal failure (code=EPERM, signal=${failedSignal}, phase=drain)`);
});

it('carries a shutdown failure into draining without another group signal', async () => {
  const state = { error: 'none' };
  signal.mockImplementation(() => { throw Object.assign(new Error('/private'), { code: 'EPERM' }); });
  signalBrowserProcessGroup(group, 'SIGTERM', state, 'shutdown');
  signalBrowserProcessGroup(group, 'SIGKILL', state, 'shutdown');
  observation.read.mockResolvedValueOnce(snapshot(`23456 ${group} S`)).mockResolvedValue(snapshot());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const drain = drainBrowserProcessGroup(group, 500, 25, state);
  await vi.advanceTimersByTimeAsync(25);
  await drain;
  expect(signal).toHaveBeenCalledTimes(1);
  expect(state).toMatchObject({ error: 'EPERM', failedSignal: 'SIGTERM', failedPhase: 'shutdown' });
});

it.each(['observation', 'reuse'])('retains inherited failure when %s becomes unsafe', async kind => {
  if (kind === 'observation') observation.read.mockRejectedValue(new Error('/private'));
  else observation.read.mockResolvedValue(snapshot(`${group} ${group} S`));
  await expect(drainBrowserProcessGroup(group, 500, 25, { error: '/private/code' })).rejects.toThrow('(groupSignalError=other, groupFailedSignal=other, groupFailedPhase=other)');
  expect(signal).not.toHaveBeenCalled();
});

it('reobserves after ESRCH instead of treating a signal result as quiescence', async () => {
  signal.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  observation.read.mockResolvedValueOnce(snapshot(`23456 ${group} S`)).mockResolvedValue(snapshot());
  const drain = drainBrowserProcessGroup(group, 500, 100);
  await vi.advanceTimersByTimeAsync(25);
  await drain;
  expect(observation.read).toHaveBeenCalledTimes(2);
});


it('redacts inherited fields in the successful-quiescence diagnostic', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await drainBrowserProcessGroup(group, 500, 25, { error: '/private/code', failedSignal: '/private/signal', failedPhase: '/private/phase' });
  expect(warning).toHaveBeenCalledExactlyOnceWith('⚠️ Composition browser group quiesced after signal failure (code=other, signal=other, phase=other)');
});
