import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { rm } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('./processEnv.js', () => ({ windowsPowerShell51Path: () => 'fixture-compiler', findCommandOnPath: () => 'fixture-git' }));
import { spawn } from './childProcess.js';
import { assertGitWorkSettled, execGit, withGitMutationLifetime } from './execGit.js';

const key = Symbol.for('portos.windowsGitSupervisor');
let broker, requests;
describe.skipIf(process.platform !== 'win32')('Windows Git broker failure containment', () => {
  beforeEach(() => {
    expect(process[key]).toBeUndefined();
    requests = [];
    spawn.mockImplementation(command => {
      const child = new EventEmitter();
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); return true; });
      if (command === 'fixture-compiler') queueMicrotask(() => child.emit('close', 0));
      else {
        broker = child;
        child.stdout = new PassThrough(); child.stdin = new PassThrough();
        child.stdin.on('data', bytes => { requests.push(JSON.parse(bytes.toString())); });
        child.stdin.on('finish', () => { child.emit('close', 0); });
        queueMicrotask(() => child.stdout.write('{"kind":"ready"}\n'));
      }
      return child;
    });
  });
  afterEach(async () => {
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
    expect(failure).toMatchObject({ code: 'GIT_SETTLEMENT_HELD', settlement: 'held', settlementReason: 'supervisor-unconfirmed' });
    expect(failure.message).not.toMatch(/synthetic|argument|transport/);
    expect(retain).toHaveBeenCalledOnce();
    expect(() => assertGitWorkSettled(cwd)).toThrow(/held/);
    await expect(globalThis.__portosGitSupervisorCleanup()).rejects.toMatchObject({
      code: 'GIT_SETTLEMENT_HELD', settlementReasons: ['supervisor-unconfirmed'],
    });
  });
});
