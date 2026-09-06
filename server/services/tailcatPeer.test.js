import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  redactTcAddress,
  isValidTcAddress,
  ensureTailcatInstalled,
  allocateLocalPort,
  startForwardProcess,
  addPeerViaTailcat,
  _resetLiveForwardsForTests,
} from './tailcatPeer.js';
import { DEFAULT_TAILCAT_LOCAL_PORT, DEFAULT_TAILCAT_REMOTE_PORT } from '../lib/ports.js';

const EXAMPLE_TC = 'tcEXAMPLE' + 'A'.repeat(40);

function fakeChild({ exitImmediately = false, exitCode = 1 } = {}) {
  const child = new EventEmitter();
  child.killed = false;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit('exit', 0, null);
  });
  if (exitImmediately) {
    queueMicrotask(() => Promise.resolve()) //.then(() => child.emit('exit', exitCode, null));
  }
  return child;
}

describe('tailcatPeer helpers', () => {
  beforeEach(() => {
    _resetLiveForwardsForTests();
  });

  afterEach(() => {
    _resetLiveForwardsForTests();
  });

  it('redacts tc addresses so logs never hold the full capability', () => {
    const redacted = redactTcAddress(EXAMPLE_TC);
    expect(redacted).not.toBe(EXAMPLE_TC);
    expect(redacted.startsWith('tcEX')).toBe(true);
    expect(redacted.includes('…')).toBe(true);
    expect(redactTcAddress('')).toBe('(empty)');
  });

  it('validates tc address shape without accepting short garbage', () => {
    expect(isValidTcAddress(EXAMPLE_TC)).toBe(true);
    expect(isValidTcAddress('tcEXAMPLE…')).toBe(false); // ellipsis / placeholder
    expect(isValidTcAddress('not-a-tc')).toBe(false);
    expect(isValidTcAddress('tcshort')).toBe(false);
    expect(isValidTcAddress('')).toBe(false);
  });

  it('ensureTailcatInstalled returns existing binary without installing', async () => {
    const runGoInstall = vi.fn();
    const result = await ensureTailcatInstalled({
      detect: async () => '/usr/bin/tailcat',
      runGoInstall,
      probeGo: async () => true,
    });
    expect(result).toEqual({ bin: '/usr/bin/tailcat', installed: false });
    expect(runGoInstall).not.toHaveBeenCalled();
  });

  it('ensureTailcatInstalled runs go install when missing, then re-detects', async () => {
    let calls = 0;
    const runGoInstall = vi.fn(async () => {});
    const result = await ensureTailcatInstalled({
      detect: async () => {
        calls += 1;
        return calls === 1 ? null : '/home/box/go/bin/tailcat';
      },
      goBin: 'go',
      runGoInstall,
      probeGo: async () => true,
    });
    expect(runGoInstall).toHaveBeenCalledOnce();
    expect(result).toEqual({ bin: '/home/box/go/bin/tailcat', installed: true });
  });

  it('ensureTailcatInstalled fails clearly when Go is absent', async () => {
    await expect(ensureTailcatInstalled({
      detect: async () => null,
      probeGo: async () => false,
      runGoInstall: vi.fn(),
    })).rejects.toMatchObject({ code: 'TAILCAT_MISSING', status: 503 });
  });

  it('allocateLocalPort prefers 15555 then walks upward when busy', async () => {
    expect(DEFAULT_TAILCAT_LOCAL_PORT).toBe(15555);
    expect(DEFAULT_TAILCAT_REMOTE_PORT).toBe(5555);
    const isFree = vi.fn(async (port) => port === 15557);
    const port = await allocateLocalPort({ preferred: 15555, isFree, limit: 5 });
    expect(port).toBe(15557);
    expect(isFree).toHaveBeenCalledWith(15555);
    expect(isFree).toHaveBeenCalledWith(15556);
    expect(isFree).toHaveBeenCalledWith(15557);
  });

  it('startForwardProcess spawns tailcat forward with local:remote mapping', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const started = await startForwardProcess({
      bin: '/usr/bin/tailcat',
      tcAddress: EXAMPLE_TC,
      localPort: 15555,
      remotePort: 5555,
      spawnFn,
      readyMs: 10,
    });
    expect(started).toBe(child);
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/tailcat',
      ['forward', EXAMPLE_TC, '15555:5555'],
      expect.any(Object)
    );
  });

  it('startForwardProcess rejects when the child exits immediately', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      // Schedule exit after startForwardProcess attaches its listeners.
      process.nextTick(() => child.emit('exit', 2, null));
      return child;
    });
    await expect(startForwardProcess({
      bin: '/usr/bin/tailcat',
      tcAddress: EXAMPLE_TC,
      localPort: 15555,
      spawnFn,
      readyMs: 5_000,
    })).rejects.toThrow(/exited early/);
  });

  it('addPeerViaTailcat installs, forwards, and registers loopback peer', async () => {
    const child = fakeChild();
    const addPeerFn = vi.fn(async (data) => ({ id: 'peer-1', ...data }));
    const peer = await addPeerViaTailcat({
      tcAddress: EXAMPLE_TC,
      name: 'sandbox',
      ensureInstalled: async () => ({ bin: '/usr/bin/tailcat', installed: false }),
      allocatePort: async () => 15555,
      startForward: async () => child,
      addPeerFn,
      persistForwardEntry: async () => {},
    });
    expect(addPeerFn).toHaveBeenCalledWith({
      address: '127.0.0.1',
      port: 15555,
      name: 'sandbox',
      auth: undefined,
      transport: 'tailcat',
    });
    expect(peer.transport).toBe('tailcat');
    expect(peer.address).toBe('127.0.0.1');
  });
});

