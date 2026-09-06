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
  _liveForwardCountForTests,
  stopAllForwards,
  stopForwardForPeer,
  restoreForwards,
} from './tailcatPeer.js';
import { DEFAULT_TAILCAT_LOCAL_PORT, DEFAULT_TAILCAT_REMOTE_PORT } from '../lib/ports.js';

vi.mock('../lib/fileUtils.js', async (original) => ({
  ...(await original()),
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
}));
import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';

const EXAMPLE_TC = 'tcEXAMPLE' + 'A'.repeat(40);

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit('exit', 0, null);
  });
  return child;
}

describe('tailcatPeer helpers', () => {
  beforeEach(() => {
    _resetLiveForwardsForTests();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ version: 1, forwards: [] });
  });

  afterEach(() => {
    _resetLiveForwardsForTests();
    vi.useRealTimers();
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
        return calls === 1 ? null : '/example/go/bin/tailcat';
      },
      goBin: 'go',
      runGoInstall,
      probeGo: async () => true,
    });
    expect(runGoInstall).toHaveBeenCalledOnce();
    expect(result).toEqual({ bin: '/example/go/bin/tailcat', installed: true });
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
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.stderr.emit('data', 'forwarding 127.0.0.1:15555 -> remote localhost:5555\n'));
      return child;
    });
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
      ['forward', '--bind=127.0.0.1', EXAMPLE_TC, '15555:5555'],
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

  it('times out and kills a process that never confirms its listener', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child, readyMs: 8000 });
    const assertion = expect(result).rejects.toThrow('startup timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });

  it('never exposes capability diagnostics across repeated or split chunks', async () => {
    const child = fakeChild();
    const result = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child });
    child.stderr.emit('data', EXAMPLE_TC.slice(0, 10));
    child.stderr.emit('data', EXAMPLE_TC.slice(10) + EXAMPLE_TC);
    child.emit('error', new Error(EXAMPLE_TC));
    await expect(result).rejects.toThrow(/^tailcat forward process failed$/);
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
      protocol: 'http',
    });
    expect(peer.transport).toBe('tailcat');
    expect(peer.address).toBe('127.0.0.1');
  });
});


describe('tailcat lifecycle failure contracts', () => {
  beforeEach(() => {
    _resetLiveForwardsForTests();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ version: 1, forwards: [] });
  });
  afterEach(() => { _resetLiveForwardsForTests(); vi.useRealTimers(); });

  function addOptions(child, overrides = {}) {
    return {
      tcAddress: EXAMPLE_TC,
      ensureInstalled: async () => ({ bin: '/example/bin/tailcat' }),
      allocatePort: async () => 15555,
      startForward: async () => child,
      addPeerFn: async (data) => ({ id: 'peer-example', ...data }),
      persistForwardEntry: async () => {},
      ...overrides,
    };
  }

  it('rejects stalled startup at the deadline and terminates the process', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child, readyMs: 8000 });
    const failure = expect(pending).rejects.toThrow('startup timed out');
    await vi.advanceTimersByTimeAsync(7999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('waits for the correct listener and accepts a readiness line split over chunks', async () => {
    const child = fakeChild();
    let ready = false;
    const pending = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child }).then(() => { ready = true; });
    child.stderr.emit('data', 'forwarding 127.0.0.1:15556 -> remote localhost:5555\n');
    await Promise.resolve();
    expect(ready).toBe(false);
    child.stderr.emit('data', 'forwarding 127.0.0.1:15555 -> ');
    child.stderr.emit('data', 'remote localhost:5555\n');
    await pending;
    expect(ready).toBe(true);
  });

  it('never includes split or repeated capability diagnostics in startup errors', async () => {
    const child = fakeChild();
    const pending = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child });
    child.stderr.emit('data', EXAMPLE_TC.slice(0, 16));
    child.stderr.emit('data', EXAMPLE_TC.slice(16) + EXAMPLE_TC + EXAMPLE_TC);
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('tailcat forward exited early (code=1, signal=null)');
    await pending.catch((error) => expect(error.message).not.toContain('tcEXAMPLE'));
  });

  it('rolls back the peer and child if restart metadata cannot be saved', async () => {
    const child = fakeChild();
    const removePeerFn = vi.fn().mockResolvedValue(undefined);
    await expect(addPeerViaTailcat(addOptions(child, {
      persistForwardEntry: async () => { throw new Error('disk full'); }, removePeerFn,
    }))).rejects.toMatchObject({ code: 'TAILCAT_PERSIST_FAILED' });
    expect(removePeerFn).toHaveBeenCalledWith('peer-example', { stopTransport: false });
    expect(child.killed).toBe(true);
    expect(_liveForwardCountForTests()).toBe(0);
  });

  it('terminates the forward when peer registration fails', async () => {
    const child = fakeChild();
    await expect(addPeerViaTailcat(addOptions(child, {
      addPeerFn: async () => { throw new Error('peer write failed'); },
    }))).rejects.toThrow('peer write failed');
    expect(child.killed).toBe(true);
  });

  it('stops children on shutdown while preserving their restart metadata', async () => {
    const child = fakeChild();
    await addPeerViaTailcat(addOptions(child));
    stopAllForwards();
    expect(child.killed).toBe(true);
    expect(_liveForwardCountForTests()).toBe(0);
    expect(atomicWrite).not.toHaveBeenCalled();
    await expect(addPeerViaTailcat(addOptions(fakeChild()))).rejects.toThrow('shutting down');
  });

  it('restores only mappings that still belong to existing managed peers, and retires them on removal', async () => {
    const entry = { peerId: 'peer-example', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555 };
    readJSONFile.mockResolvedValue({ version: 1, forwards: [entry, { ...entry, peerId: 'deleted-peer' }] });
    const child = fakeChild();
    const startForward = vi.fn().mockResolvedValue(child);
    const getPeersFn = async () => [{ id: 'peer-example', transport: 'tailcat', address: '127.0.0.1', port: 15555 }];
    const options = { ensureInstalled: async () => ({ bin: 'tailcat' }), startForward, getPeersFn };
    await expect(restoreForwards(options)).resolves.toEqual({ restored: 1 });
    await expect(restoreForwards(options)).resolves.toEqual({ restored: 0 });
    expect(startForward).toHaveBeenCalledTimes(1);
    await stopForwardForPeer('peer-example');
    expect(child.killed).toBe(true);
    expect(atomicWrite).toHaveBeenCalledWith(expect.any(String), {
      version: 1, forwards: [{ ...entry, peerId: 'deleted-peer' }],
    });
  });
});
