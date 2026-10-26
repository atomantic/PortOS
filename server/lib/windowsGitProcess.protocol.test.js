import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, rm } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('./processEnv.js', () => ({ windowsPowerShell51Path: () => 'fixture-compiler', findCommandOnPath: vi.fn() }));
import { spawn } from './childProcess.js';
import { findCommandOnPath } from './processEnv.js';
import { assertGitWorkSettled, execGit, withGitMutationLifetime } from './execGit.js';

const key = Symbol.for('portos.windowsGitSupervisor');
let broker, compiler, requests, startupFailure;
const privateError = code => Object.assign(new Error('synthetic-private-credentials-and-argv'), {
  code, path: '/synthetic-private-path', stderr: 'synthetic-private-compiler-output',
  startupPhase: 'synthetic-private-phase', compilerExitCode: 'synthetic-private-code',
});
describe.skipIf(process.platform !== 'win32')('Windows Git broker failure containment', () => {
  beforeEach(() => {
    expect(process[key]).toBeUndefined();
    requests = []; broker = null; compiler = null; startupFailure = null;
    findCommandOnPath.mockReset().mockReturnValue('fixture-git');
    spawn.mockImplementation(command => {
      if (startupFailure === `${command === 'fixture-compiler' ? 'compiler' : 'broker'}-spawn-sync`) throw privateError('EACCES');
      const child = new EventEmitter();
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true; });
      if (command === 'fixture-compiler') {
        compiler = child;
        queueMicrotask(() => {
          if (startupFailure === 'compiler-timeout') return;
          if (startupFailure === 'compiler-spawn') child.emit('error', privateError('ENOENT'));
          else if (startupFailure === 'compiler-spawn-private') child.emit('error', privateError('synthetic-private-code'));
          else child.emit('close', startupFailure === 'compiler-exit' ? 23 : 0);
        });
      }
      else {
        broker = child;
        child.stdout = new PassThrough(); child.stdin = new PassThrough();
        child.stdin.on('data', bytes => { requests.push(JSON.parse(bytes.toString())); });
        child.stdin.on('finish', () => { child.emit('close', 0); });
        queueMicrotask(() => {
          if (startupFailure === 'broker-readiness') return;
          if (startupFailure === 'broker-spawn') child.emit('error', privateError('EPERM'));
          else if (startupFailure === 'broker-exit') child.emit('close', 17);
          else if (startupFailure === 'broker-protocol') child.stdout.write('synthetic-private-invalid-frame\n');
          else if (startupFailure === 'broker-transport') child.stdin.emit('error', privateError('EPIPE'));
          else child.stdout.write('{"kind":"ready"}\n');
        });
      }
      return child;
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    const state = process[key];
    // Every process in this suite is an EventEmitter double. Remove only its
    // private compiler directory after asserting that production teardown held.
    if (state) {
      clearTimeout(state.idle);
      if (state.directory) await rm(state.directory, { recursive: true, force: true });
      delete process[key];
      delete globalThis.__portosGitSupervisorCleanup;
    }
  });

  // These reach the public command boundary: its terminal catch used to erase
  // every startup discriminator, including compiler exit and spawn results.
  it.each([
    ['compiler-exit', { startupPhase: 'compiler-exit', compilerExitCode: 23 }],
    ['compiler-spawn', { startupPhase: 'compiler-spawn', spawnErrorCode: 'ENOENT' }],
    ['compiler-spawn-sync', { startupPhase: 'compiler-spawn', spawnErrorCode: 'EACCES' }],
    ['compiler-spawn-private', { startupPhase: 'compiler-spawn' }],
    ['git-lookup', { startupPhase: 'git-lookup' }],
    ['broker-spawn', { startupPhase: 'broker-spawn', spawnErrorCode: 'EPERM' }],
    ['broker-spawn-sync', { startupPhase: 'broker-spawn', spawnErrorCode: 'EACCES' }],
    ['broker-exit', { startupPhase: 'broker-exit' }],
    ['broker-protocol', { startupPhase: 'broker-protocol' }],
    ['broker-transport', { startupPhase: 'broker-transport' }],
  ])('reports bounded %s evidence without launching Git or leaking raw errors', async (mode, metadata) => {
    startupFailure = mode;
    if (mode === 'git-lookup') findCommandOnPath.mockReturnValue(null);
    const cwd = '/synthetic-startup';
    const failure = await execGit(['status', 'synthetic-private-argument'], cwd).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'GIT_CONTAINMENT_UNAVAILABLE', ...metadata });
    expect(Object.keys(failure).sort()).toEqual(['code', ...Object.keys(metadata)].sort());
    expect(`${failure.message} ${JSON.stringify(failure)}`).not.toMatch(/synthetic|private|credentials|argv/);
    expect(requests).toEqual([]);
    expect(() => assertGitWorkSettled(cwd)).not.toThrow();
    await expect(globalThis.__portosGitSupervisorCleanup()).resolves.toBeUndefined();
  });

  it.each(['compiler-timeout', 'broker-readiness'])('identifies the existing %s deadline using injected time', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    startupFailure = phase;
    const failure = execGit(['status'], '/synthetic-startup-timeout').catch(error => error);
    await vi.waitFor(() => expect(phase === 'compiler-timeout' ? compiler : broker).not.toBeNull());
    await vi.advanceTimersByTimeAsync(15000);
    expect(await failure).toMatchObject({ code: 'GIT_CONTAINMENT_UNAVAILABLE', startupPhase: phase });
    expect(requests).toEqual([]);
    expect((phase === 'compiler-timeout' ? compiler : broker).kill).toHaveBeenCalledOnce();
    if (phase === 'compiler-timeout') {
      await expect(globalThis.__portosGitSupervisorCleanup()).rejects.toMatchObject({
        code: 'GIT_SETTLEMENT_HELD', settlementReasons: ['compiler-unconfirmed'],
      });
      await expect(access(process[key].directory)).resolves.toBeUndefined();
    } else await globalThis.__portosGitSupervisorCleanup();
  });

  it('distinguishes a settled native launch refusal from startup loss without retaining an obligation', async () => {
    const cwd = '/synthetic-native-launch';
    const failure = execGit(['status'], cwd).catch(error => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    broker.stdout.write(`${JSON.stringify({ kind: 'done', id: requests[0].id,
      settled: true, launched: false, exitCode: 1, reason: 'launch-failed' })}\n`);
    expect(await failure).toMatchObject({ code: 'GIT_CONTAINMENT_UNAVAILABLE', startupPhase: 'native-launch' });
    expect(() => assertGitWorkSettled(cwd)).not.toThrow();
    await globalThis.__portosGitSupervisorCleanup();
  });

  it.each(['malformed-completion', 'broker-loss', 'dispatch-failure'])('retains mutation admission and a bounded obligation on %s', async mode => {
    const retain = vi.fn();
    const cwd = `/synthetic-broker-${mode}`;
    const outcome = withGitMutationLifetime(() => execGit(['status', 'synthetic-private-argument'], cwd), retain).catch(error => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    if (mode === 'malformed-completion') {
      broker.stdout.write(`${JSON.stringify({ kind: 'done', id: requests[0].id, settled: 'yes', launched: true, exitCode: 0, reason: 'settled' })}\n`);
    } else if (mode === 'dispatch-failure') {
      broker.stdin.emit('error', new Error('synthetic-private-transport-detail'));
    } else broker.emit('close', 1);
    const failure = await outcome;
    expect(failure).toMatchObject({ code: 'GIT_SETTLEMENT_HELD', settlement: 'held', settlementReason: 'supervisor-unconfirmed',
      startupPhase: { 'malformed-completion': 'broker-protocol', 'broker-loss': 'broker-exit', 'dispatch-failure': 'broker-transport' }[mode] });
    expect(failure.message).not.toMatch(/synthetic|argument|transport/);
    expect(retain).toHaveBeenCalledOnce();
    expect(() => assertGitWorkSettled(cwd)).toThrow(/held/);
    await expect(globalThis.__portosGitSupervisorCleanup()).rejects.toMatchObject({
      code: 'GIT_SETTLEMENT_HELD', settlementReasons: ['supervisor-unconfirmed'],
    });
  });
});
