import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pinPlatform } from '../lib/testHelper.js';
vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('./cosClaimOwnershipState.js', () => ({ withClaimOwnershipLock: work => work() }));
import { spawn } from '../lib/childProcess.js';
import { _runInitializedCheckoutNative } from './initializedCheckoutRecovery.js';

let restore, child, sent;
beforeEach(() => {
  restore = pinPlatform('darwin');
  sent = [];
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', 1)); }) });
  child.stdin.on('data', value => sent.push(JSON.parse(value.toString())));
  spawn.mockReturnValue(child);
});
afterEach(() => { restore(); vi.clearAllMocks(); });

const request = { command: 'resume-quarantine', transactionDir: '/fixture/transaction' };
const ready = () => child.stdout.write(`${JSON.stringify({ mutationReady: sent[0].mutationPermit, part: 'administration' })}\n`);

describe('native mutation permission transport', () => {
  it('keeps stdin open until post-verification readiness and obtains a fresh gate decision before acknowledging', async () => {
    const gate = vi.fn(async () => {});
    const result = _runInitializedCheckoutNative(request, { beforeMutation: gate });
    expect(sent[0]).toMatchObject({ ...request, mutationPermit: expect.any(String) });
    expect(child.stdin.writableEnded).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ mutationPermit: sent[0].mutationPermit, allow: true });
    child.stdout.write('{"ok":true,"moved":true}\n'); child.emit('close', 0);
    expect(await result).toEqual({ ok: true, moved: true });
    expect(gate).toHaveBeenCalledTimes(1);
  });
  it('sends no permit when the daemon pauses during native verification, and waits for child exit', async () => {
    const gate = vi.fn(async () => { throw new Error('daemon-paused'); });
    const result = _runInitializedCheckoutNative(request, { beforeMutation: gate });
    const rejected = expect(result).rejects.toThrow('daemon-paused');
    ready();
    await rejected;
    expect(sent).toHaveLength(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('refuses a mismatched readiness token without calling the gate or acknowledging', async () => {
    const gate = vi.fn();
    const result = _runInitializedCheckoutNative(request, { beforeMutation: gate });
    const rejected = expect(result).rejects.toThrow('retirement-native-permit-invalid');
    child.stdout.write('{"mutationReady":"foreign","part":"administration"}\n');
    await rejected;
    expect(gate).not.toHaveBeenCalled(); expect(sent).toHaveLength(1);
  });
  it('does not acknowledge after child exit while the gate is still resolving', async () => {
    let finish;
    const result = _runInitializedCheckoutNative(request, { beforeMutation: () => new Promise(resolve => { finish = resolve; }) });
    const rejected = expect(result).rejects.toThrow();
    ready(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    child.emit('close', 1); await rejected;
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(sent).toHaveLength(1);
  });
  it('preserves the explicit/manual single-request protocol without a mutation permit', async () => {
    const result = _runInitializedCheckoutNative(request);
    expect(sent).toEqual([request]); expect(child.stdin.writableEnded).toBe(true);
    child.stdout.write('{"ok":true,"moved":true}\n'); child.emit('close', 0);
    expect(await result).toMatchObject({ ok: true, moved: true });
  });
});
