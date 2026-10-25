import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('./childProcess.js', () => ({ spawn: launch }));
import { browserSuiteCanRun, chromeWithH264, probeChromeH264 } from './browserSuiteGate.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// Uniquely catches deleting a still-live probe's profile and confusing a
// post-spawn signal error with a failed spawn that acquired no process.
it('retains an unconfirmed probe profile through signal errors, then removes it only on the retained child close', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 900001, stdout: new PassThrough(), kill: vi.fn(() => false) });
  launch.mockReturnValue(child);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('private signal details'), { code: 'EPERM' }); });
  const pending = probeChromeH264('synthetic-chrome', { timeoutMs: 100, graceMs: 25 });
  const profile = launch.mock.calls.at(-1)[1].find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
  child.emit('spawn');
  child.stdout.write('H264:probably');
  child.emit('error', Object.assign(new Error('private child error'), { code: 'EPERM' }));
  await vi.advanceTimersByTimeAsync(150);
  const result = await pending;
  expect(result).toMatchObject({ ok: false, cause: 'probe-timeout', cleanupVerified: false,
    diagnostics: { spawnMs: expect.any(Number), answerMs: expect.any(Number), exitMs: null, closeMs: null, childError: 'EPERM' } });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(existsSync(profile)).toBe(true);
  child.emit('exit', 0, null);
  expect(existsSync(profile)).toBe(true);
  child.emit('close', 0, null);
  expect(existsSync(profile)).toBe(false);
  expect(result.cleanupVerified).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains bounded redacted probe phases in the required-browser failure before suite collection', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 900001, stdout: new PassThrough(), kill: vi.fn(() => true) });
  launch.mockReturnValue(child);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const pending = chromeWithH264('synthetic-chrome', { timeoutMs: 100, graceMs: 25 });
  child.emit('spawn');
  child.stdout.write('H264:probably');
  child.emit('exit', 2, null);
  child.emit('close', 2, null);
  const verdict = await pending;
  expect(verdict).toMatchObject({ probeFailure: 'teardown-failed', probeDiagnostics: expect.stringContaining('answerMs=') });
  vi.stubEnv('PORTOS_REQUIRE_BROWSER_SUITES', '1');
  try {
    expect(() => browserSuiteCanRun('synthetic suite', { Chrome: verdict })).toThrow(/probe phases .*exitMs=.*closeMs=/);
  } finally { vi.unstubAllEnvs(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('removes an allocated profile after synchronous launch refusal without exposing raw launch errors', async () => {
  launch.mockImplementation(() => { throw Object.assign(new Error('private launch details'), { code: 'EACCES' }); });
  const result = await probeChromeH264('synthetic-chrome');
  const profile = launch.mock.calls.at(-1)[1].find(arg => arg.startsWith('--user-data-dir=')).split('=')[1];
  expect(result).toMatchObject({ ok: false, cause: 'no-answer', cleanupVerified: true,
    diagnostics: { spawnMs: null, closeMs: null, childError: 'EACCES', profile: 'removed' } });
  expect(existsSync(profile)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private');
});
