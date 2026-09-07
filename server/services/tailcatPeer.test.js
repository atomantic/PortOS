import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { delimiter, join } from 'node:path';
import {
  redactTcAddress,
  isValidTcAddress,
  ensureTailcatInstalled,
  listTailcatInstallers,
  listCandidateTailcatBins,
  manualInstallHint,
  allocateLocalPort,
  startForwardProcess,
  classifyTailcatRuntimeError,
  addPeerViaTailcat,
  listTailcatForwards,
  retryTailcatForward,
  forgetTailcatForward,
  redactTailcatDiagnostics,
  derpMapCachePath,
  primeDerpMapCache,
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

// Only the install path spawns through this; forwards use spawn() directly.
vi.mock('../lib/bufferedSpawn.js', async (original) => ({
  ...(await original()),
  bufferedSpawn: vi.fn(),
}));
import { bufferedSpawn } from '../lib/bufferedSpawn.js';

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
    const run = vi.fn();
    const result = await ensureTailcatInstalled({
      detect: async () => '/usr/bin/tailcat',
      installers: [{ label: 'brew install tailcat', run }],
    });
    expect(result).toEqual({ bin: '/usr/bin/tailcat', installed: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('ensureTailcatInstalled installs when missing, then re-detects', async () => {
    let calls = 0;
    const run = vi.fn(async () => {});
    const result = await ensureTailcatInstalled({
      detect: async () => {
        calls += 1;
        return calls === 1 ? null : '/example/go/bin/tailcat';
      },
      installers: [{ label: 'go install', run }],
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ bin: '/example/go/bin/tailcat', installed: true });
  });

  it('falls back to the next installer when the first one fails', async () => {
    let calls = 0;
    const brew = vi.fn(async () => { throw new Error('Error: No available formula\nsecond line'); });
    const go = vi.fn(async () => {});
    const result = await ensureTailcatInstalled({
      detect: async () => {
        calls += 1;
        return calls <= 1 ? null : '/example/go/bin/tailcat';
      },
      installers: [{ label: 'brew install tailcat', run: brew }, { label: 'go install', run: go }],
    });
    expect(brew).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledOnce();
    expect(result).toEqual({ bin: '/example/go/bin/tailcat', installed: true });
  });

  it('reports what every installer said when they all fail', async () => {
    const error = await ensureTailcatInstalled({
      detect: async () => null,
      platform: 'linux',
      installers: [
        { label: 'brew install tailcat', run: async () => { throw new Error('brew boom'); } },
        { label: 'go install', run: async () => { throw new Error('dial tcp: connect: bad file descriptor\nignored'); } },
      ],
    }).catch((err) => err);
    expect(error).toMatchObject({ code: 'TAILCAT_INSTALL_FAILED', status: 503 });
    // Every strategy is named, not just the first one that failed.
    expect(error.message).toContain('brew install tailcat failed: brew boom');
    expect(error.message).toContain('go install failed: dial tcp: connect: bad file descriptor');
    // Only the first line of a multi-line diagnostic reaches the toast.
    expect(error.message).not.toContain('ignored');
    expect(error.message).toContain('https://github.com/tailscale/tailcat/releases');
  });

  it('falls through to the next installer even when one throws synchronously', async () => {
    let calls = 0;
    const result = await ensureTailcatInstalled({
      detect: async () => {
        calls += 1;
        return calls <= 1 ? null : '/example/go/bin/tailcat';
      },
      installers: [
        { label: 'brew install tailcat', run: () => { throw new Error('sync boom'); } },
        { label: 'go install', run: async () => {} },
      ],
    });
    expect(result).toEqual({ bin: '/example/go/bin/tailcat', installed: true });
  });

  it('treats an installer that leaves no binary as a failure, not a success', async () => {
    await expect(ensureTailcatInstalled({
      detect: async () => null,
      installers: [{ label: 'go install', run: async () => {} }],
    })).rejects.toMatchObject({
      code: 'TAILCAT_INSTALL_FAILED',
      message: expect.stringContaining('go install finished but no tailcat binary was found'),
    });
  });

  it('ensureTailcatInstalled fails clearly when no package manager is present', async () => {
    await expect(ensureTailcatInstalled({
      detect: async () => null,
      installers: [],
    })).rejects.toMatchObject({ code: 'TAILCAT_MISSING', status: 503 });
  });

  it('points macOS at Homebrew, since tailcat ships no darwin release binary', () => {
    expect(manualInstallHint('darwin')).toContain('brew install tailcat');
    expect(manualInstallHint('darwin')).not.toContain('/releases');
    expect(manualInstallHint('linux')).toContain('https://github.com/tailscale/tailcat/releases');
  });

  it('lists brew before go, and only for package managers that exist', () => {
    const runInstall = vi.fn(async () => {});
    expect(listTailcatInstallers({ brewBin: '/opt/homebrew/bin/brew', goBin: '/usr/bin/go', runInstall })
      .map((i) => i.label)).toEqual(['brew install tailcat', 'go install']);
    expect(listTailcatInstallers({ brewBin: null, goBin: '/usr/bin/go', runInstall })
      .map((i) => i.label)).toEqual(['go install']);
    expect(listTailcatInstallers({ brewBin: null, goBin: null, runInstall })).toEqual([]);
  });

  it('skips Homebrew auto-update so adding a peer does not refresh the formula index', async () => {
    const runInstall = vi.fn(async () => {});
    const [brew] = listTailcatInstallers({ brewBin: '/opt/homebrew/bin/brew', goBin: null, runInstall });
    await brew.run();
    expect(runInstall).toHaveBeenCalledWith('/opt/homebrew/bin/brew', ['install', 'tailcat'],
      expect.objectContaining({ HOMEBREW_NO_AUTO_UPDATE: '1' }));
  });

  // The default runner maps a bufferedSpawn result onto the message the operator
  // reads in the toast; each terminal condition has to say something different.
  it.each([
    ['a non-zero exit', { success: false, code: 1, stdout: '', stderr: 'Warning: tap not trusted\nError: No available formula\n', timedOut: false },
      'Error: No available formula'],
    ['a spawn failure', { success: false, code: -1, stdout: '', stderr: '', timedOut: false, error: new Error('spawn /example/missing/go ENOENT') },
      'spawn /example/missing/go ENOENT'],
    ['a silent non-zero exit', { success: false, code: 7, stdout: '', stderr: '', timedOut: false }, 'exit 7'],
    ['a timeout', { success: false, code: -1, stdout: '', stderr: '', timedOut: true }, 'timed out after 180s'],
  ])('surfaces %s as a readable install error', async (_label, result, expected) => {
    bufferedSpawn.mockResolvedValueOnce(result);
    const [installer] = listTailcatInstallers({ brewBin: null, goBin: '/example/go' });
    await expect(installer.run()).rejects.toThrow(expected);
  });

  it('treats a clean install-command exit as success', async () => {
    bufferedSpawn.mockResolvedValueOnce({ success: true, code: 0, stdout: '', stderr: '', timedOut: false });
    const [installer] = listTailcatInstallers({ brewBin: '/example/brew', goBin: null });
    await expect(installer.run()).resolves.toBeUndefined();
    expect(bufferedSpawn).toHaveBeenCalledWith('/example/brew', ['install', 'tailcat'],
      expect.objectContaining({ env: expect.objectContaining({ HOMEBREW_NO_AUTO_UPDATE: '1' }) }));
  });

  it('looks for tailcat in the GOBIN and Homebrew prefixes a server may not have on PATH', () => {
    // Empty PATH so the injected env is the only source — the real PATH must not leak in.
    const bins = listCandidateTailcatBins({
      env: { PATH: '', GOBIN: join('/example', 'gobin'), HOMEBREW_PREFIX: join('/example', 'brew') },
      home: join('/example', 'home'),
    });
    expect(bins).toEqual([
      join('/example', 'gobin', 'tailcat'),
      join('/example', 'gobin', 'tailcat.exe'),
      join('/example', 'brew', 'bin', 'tailcat'),
      join('/opt', 'homebrew', 'bin', 'tailcat'),
      join('/usr', 'local', 'bin', 'tailcat'),
    ]);
    // No GOBIN → the first GOPATH entry's bin; no GOPATH at all → ~/go/bin.
    expect(listCandidateTailcatBins({
      env: { PATH: '', GOPATH: [join('/example', 'gopath'), join('/example', 'other')].join(delimiter) },
      home: join('/example', 'home'),
    })).toContain(join('/example', 'gopath', 'bin', 'tailcat'));
    expect(listCandidateTailcatBins({ env: { PATH: '' }, home: join('/example', 'home') }))
      .toContain(join('/example', 'home', 'go', 'bin', 'tailcat'));
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
      readyMs: 200,
      probeMs: 5,
      isListening: async () => false,
    });
    expect(started).toBe(child);
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/tailcat',
      ['forward', '--verbose', '--bind=127.0.0.1', EXAMPLE_TC, '15555:5555'],
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
      isListening: async () => false,
    })).rejects.toThrow(/exited early/);
  });

  it('times out and kills a process that never confirms its listener', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child, readyMs: 8000, isListening: async () => false });
    const assertion = expect(result).rejects.toThrow('startup timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });

  it('never exposes capability diagnostics across repeated or split chunks', async () => {
    const child = fakeChild();
    const result = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child, isListening: async () => false });
    child.stderr.emit('data', EXAMPLE_TC.slice(0, 10));
    child.stderr.emit('data', EXAMPLE_TC.slice(10) + EXAMPLE_TC);
    child.emit('error', new Error(EXAMPLE_TC));
    // The message now carries tailcat's own (redacted) diagnostics, which is the
    // whole point — but never the capability itself, however it was chunked.
    const failure = await result.catch((err) => err);
    expect(failure.message).toContain('tailcat forward process failed');
    expect(failure.message).not.toContain('tcEXAMPLE');
  });

  it('reports a post-startup delivery failure instead of a bound-but-dead "running"', async () => {
    const child = fakeChild();
    const errors = [];
    const logSpy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(line));
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.stderr.emit('data', 'forwarding 127.0.0.1:15555 -> remote localhost:5555\n'));
      return child;
    });
    await startForwardProcess({
      bin: 'tailcat', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
      spawnFn, readyMs: 200, probeMs: 5, isListening: async () => false,
    });
    // Healthy relay churn is not a verdict; only a failed delivery is.
    child.stderr.emit('data', 'derp-301: [v1] backoff: 114 msec\n');
    expect(child.tailcatRuntimeError).toBeNull();

    // Split across chunks, exactly as a real pipe delivers it.
    child.stderr.emit('data', 'dial remote port 5555: context');
    child.stderr.emit('data', ' deadline exceeded\n');
    expect(child.tailcatRuntimeError.message).toContain('dial remote port 5555');
    expect(errors.join(' ')).toContain('cannot reach the remote');
    logSpy.mockRestore();
  });

  it('never leaks the capability through a post-startup diagnostic', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.stderr.emit('data', 'forwarding 127.0.0.1:15555 -> remote localhost:5555\n'));
      return child;
    });
    await startForwardProcess({
      bin: 'tailcat', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
      spawnFn, readyMs: 200, probeMs: 5, isListening: async () => false,
    });
    child.stderr.emit('data', `dial remote target ${EXAMPLE_TC}: refused\n`);
    expect(child.tailcatRuntimeError.message).not.toContain('tcEXAMPLE');
  });

  it('classifyTailcatRuntimeError ignores relay churn and picks the delivery failure', () => {
    expect(classifyTailcatRuntimeError('netcheck: UDP is blocked, trying HTTPS')).toBeNull();
    expect(classifyTailcatRuntimeError('derp-301: [v1] backoff: 5 msec')).toBeNull();
    expect(classifyTailcatRuntimeError(
      'derp-301: [v1] backoff: 5 msec\ndial remote port 5555: context deadline exceeded'
    )).toContain('dial remote port 5555: context deadline exceeded');
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
      primeDerpMap: async () => ({ primed: false }),
      persistForwardEntry: async () => {},
      patchForwardEntry: async () => ({}),
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
      primeDerpMap: async () => ({ primed: false }),
      persistForwardEntry: async () => {},
      patchForwardEntry: async () => ({}),
      ...overrides,
    };
  }

  it('rejects stalled startup at the deadline and terminates the process', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC,
      localPort: 15555, spawnFn: () => child, readyMs: 8000, isListening: async () => false });
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
      localPort: 15555, spawnFn: () => child, probeMs: 5, isListening: async () => false })
      .then(() => { ready = true; });
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
      localPort: 15555, spawnFn: () => child, isListening: async () => false });
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
      patchForwardEntry: async () => { throw new Error('disk full'); }, removePeerFn,
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
    // Pre-retry entries carried no id/status, so restore must still recognize them.
    const entry = { peerId: 'peer-example', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555 };
    readJSONFile.mockResolvedValue({ version: 1, forwards: [entry, { ...entry, peerId: 'deleted-peer' }] });
    const child = fakeChild();
    const startForward = vi.fn().mockResolvedValue(child);
    const getPeersFn = async () => [{ id: 'peer-example', transport: 'tailcat', address: '127.0.0.1', port: 15555 }];
    const options = {
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      startForward,
      getPeersFn,
    };
    await expect(restoreForwards(options)).resolves.toEqual({ restored: 1 });
    await expect(restoreForwards(options)).resolves.toEqual({ restored: 0 });
    expect(startForward).toHaveBeenCalledTimes(1);
    await stopForwardForPeer('peer-example');
    expect(child.killed).toBe(true);
    // Removing the peer drops only its own mapping; the stale one stays put.
    const [, written] = atomicWrite.mock.calls.at(-1);
    expect(written.version).toBe(1);
    expect(written.forwards).toHaveLength(1);
    expect(written.forwards[0]).toMatchObject({ peerId: 'deleted-peer', tcAddress: EXAMPLE_TC });
  });

  it('records why a boot-time restore failed so the retry surface can show it', async () => {
    const entry = { id: 'fwd_1', peerId: 'peer-example', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555 };
    readJSONFile.mockResolvedValue({ version: 1, forwards: [entry] });
    await expect(restoreForwards({
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      startForward: async () => { throw new Error(`could not dial ${EXAMPLE_TC}`); },
      getPeersFn: async () => [{ id: 'peer-example', transport: 'tailcat', address: '127.0.0.1', port: 15555 }],
    })).resolves.toEqual({ restored: 0 });
    const [, written] = atomicWrite.mock.calls.at(-1);
    expect(written.forwards[0]).toMatchObject({ id: 'fwd_1', status: 'failed' });
    expect(written.forwards[0].lastError).toContain('could not dial');
    expect(written.forwards[0].lastError).not.toContain('tcEXAMPLE');
  });
});

describe('saved tailcat forwards', () => {
  beforeEach(() => {
    _resetLiveForwardsForTests();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ version: 1, forwards: [] });
  });
  afterEach(() => { _resetLiveForwardsForTests(); });

  it('saves the capability before anything can fail, so a broken add stays retryable', async () => {
    const saved = [];
    await expect(addPeerViaTailcat({
      tcAddress: EXAMPLE_TC,
      name: 'sandbox',
      ensureInstalled: async () => { throw new Error('tailcat is not installed'); },
      persistForwardEntry: async (entry) => { saved.push(entry); },
      patchForwardEntry: async () => ({}),
    })).rejects.toThrow('tailcat is not installed');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ tcAddress: EXAMPLE_TC, name: 'sandbox', status: 'pending', peerId: null });
  });

  it('never lets the capability out through the list endpoint', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: 'peer-1', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
      name: 'sandbox', protocol: 'https', auth: { username: 'u', password: 'p' },
      status: 'failed', lastError: 'tailcat listener startup timed out', createdAt: '2026-01-01T00:00:00.000Z',
    }] });
    const [row] = await listTailcatForwards();
    expect(row).toMatchObject({
      id: 'fwd_1', peerId: 'peer-1', localPort: 15555, protocol: 'https',
      hasAuth: true, status: 'failed', live: false,
    });
    expect(row.tcAddress).toBe(redactTcAddress(EXAMPLE_TC));
    expect(JSON.stringify(row)).not.toContain(EXAMPLE_TC);
    // The stored Basic credential is a secret too — presence only, never a value.
    expect(JSON.stringify(row)).not.toContain('password');
  });

  it('separates a bound listener from a tunnel that cannot carry a request', async () => {
    const child = fakeChild();
    const saved = [];
    await addPeerViaTailcat({
      tcAddress: EXAMPLE_TC,
      name: 'sandbox',
      ensureInstalled: async () => ({ bin: '/example/bin/tailcat' }),
      primeDerpMap: async () => null,
      allocatePort: async () => 15555,
      startForward: async () => child,
      addPeerFn: async (data) => ({ id: 'peer-1', ...data }),
      persistForwardEntry: async (entry) => { saved.push(entry); },
      patchForwardEntry: async (id, patch) => ({ ...saved[0], ...patch, id }),
    });
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      ...saved[0], peerId: 'peer-1', localPort: 15555, status: 'active',
    }] });

    // Bound and tracked: the row reads exactly as the operator's did — green.
    const [healthy] = await listTailcatForwards();
    expect(healthy).toMatchObject({ live: true, status: 'active', tunnelError: null });

    const at = new Date().toISOString();
    child.tailcatRuntimeError = { message: 'dial remote port 5555: context deadline exceeded', at };
    const [broken] = await listTailcatForwards();
    expect(broken).toMatchObject({
      live: true, status: 'active', tunnelErrorAt: at,
      tunnelError: 'dial remote port 5555: context deadline exceeded',
    });

    // A forward that started working again goes quiet, so the failure ages out
    // rather than latching "no route" on a tunnel that now delivers.
    child.tailcatRuntimeError = { message: 'dial remote port 5555: context deadline exceeded',
      at: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
    const [recovered] = await listTailcatForwards();
    expect(recovered).toMatchObject({ live: true, tunnelError: null, tunnelErrorAt: null });
  });

  it('retries from the stored address without the operator supplying it again', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: null, tcAddress: EXAMPLE_TC, localPort: null, remotePort: 5555,
      name: 'sandbox', protocol: 'https', status: 'failed', lastError: 'startup timed out',
    }] });
    const child = fakeChild();
    const startForward = vi.fn().mockResolvedValue(child);
    const addPeerFn = vi.fn(async (data) => ({ id: 'peer-9', ...data }));
    const patches = [];
    const peer = await retryTailcatForward('fwd_1', {
      ensureInstalled: async () => ({ bin: '/example/bin/tailcat' }),
      primeDerpMap: async () => ({ primed: true }),
      allocatePort: async () => 15556,
      startForward,
      addPeerFn,
      patchForwardEntry: async (id, patch) => { patches.push([id, patch]); return { id, ...patch }; },
      getPeersFn: async () => [],
    });
    expect(startForward).toHaveBeenCalledWith(expect.objectContaining({ tcAddress: EXAMPLE_TC, localPort: 15556 }));
    expect(addPeerFn).toHaveBeenCalledWith(expect.objectContaining({
      address: '127.0.0.1', port: 15556, name: 'sandbox', transport: 'tailcat', protocol: 'https',
    }));
    expect(peer.id).toBe('peer-9');
    expect(patches).toEqual([['fwd_1', expect.objectContaining({ peerId: 'peer-9', status: 'active', lastError: null })]]);
  });

  it('repoints an existing peer when a retry has to bind a different port', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: 'peer-1', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
    }] });
    const addPeerFn = vi.fn();
    const setPeerPort = vi.fn(async (id, port) => ({ id, port, transport: 'tailcat' }));
    const peer = await retryTailcatForward('fwd_1', {
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      allocatePort: async () => 15557,
      startForward: async () => fakeChild(),
      addPeerFn,
      patchForwardEntry: async (id, patch) => ({ id, ...patch }),
      getPeersFn: async () => [{ id: 'peer-1', transport: 'tailcat', address: '127.0.0.1', port: 15555 }],
      setPeerPortFn: setPeerPort,
    });
    // Re-registering would create a duplicate peer; the record has to follow the port.
    expect(addPeerFn).not.toHaveBeenCalled();
    expect(setPeerPort).toHaveBeenCalledWith('peer-1', 15557);
    expect(peer.port).toBe(15557);
  });

  it('fails the retry rather than leaving a peer pointed at the dead port', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: 'peer-1', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
    }] });
    const child = fakeChild();
    await expect(retryTailcatForward('fwd_1', {
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      allocatePort: async () => 15557,
      startForward: async () => child,
      addPeerFn: async () => { throw new Error('must not register a duplicate'); },
      patchForwardEntry: async (id, patch) => ({ id, ...patch }),
      getPeersFn: async () => [{ id: 'peer-1', transport: 'tailcat', address: '127.0.0.1', port: 15555 }],
      // The record vanished (or stopped being a tailcat peer) mid-retry.
      setPeerPortFn: async () => null,
    })).rejects.toMatchObject({ code: 'TAILCAT_PEER_REPOINT_FAILED', status: 409 });
    expect(child.killed).toBe(true);
  });

  it('registers a fresh peer when the saved peerId no longer names a tailcat peer', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: 'peer-1', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
    }] });
    const addPeerFn = vi.fn(async (data) => ({ id: 'peer-new', ...data }));
    const setPeerPortFn = vi.fn();
    const peer = await retryTailcatForward('fwd_1', {
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      allocatePort: async () => 15555,
      startForward: async () => fakeChild(),
      addPeerFn,
      patchForwardEntry: async (id, patch) => ({ id, ...patch }),
      // Same id, but a classic peer now — adopting it would repoint an unrelated route.
      getPeersFn: async () => [{ id: 'peer-1', address: '192.0.2.10', port: 5555 }],
      setPeerPortFn,
    });
    expect(setPeerPortFn).not.toHaveBeenCalled();
    expect(addPeerFn).toHaveBeenCalledOnce();
    expect(peer.id).toBe('peer-new');
  });

  it('records a redacted reason when a retry fails again', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: null, tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
    }] });
    const patches = [];
    await expect(retryTailcatForward('fwd_1', {
      ensureInstalled: async () => ({ bin: 'tailcat' }),
      primeDerpMap: async () => ({ primed: false }),
      allocatePort: async () => 15555,
      startForward: async () => { throw new Error(`no relay for ${EXAMPLE_TC}`); },
      patchForwardEntry: async (id, patch) => { patches.push(patch); return { id, ...patch }; },
      getPeersFn: async () => [],
    })).rejects.toMatchObject({ code: 'TAILCAT_FORWARD_FAILED' });
    expect(patches.at(-1)).toMatchObject({ status: 'failed' });
    expect(patches.at(-1).lastError).toContain('no relay');
    expect(patches.at(-1).lastError).not.toContain('tcEXAMPLE');
  });

  it('rejects a retry for an unknown forward instead of inventing one', async () => {
    await expect(retryTailcatForward('fwd_missing')).rejects.toMatchObject({ status: 404 });
  });

  it('forget removes the stored capability along with its peer', async () => {
    readJSONFile.mockResolvedValue({ version: 1, forwards: [{
      id: 'fwd_1', peerId: 'peer-1', tcAddress: EXAMPLE_TC, localPort: 15555, remotePort: 5555,
    }] });
    const removePeerFn = vi.fn().mockResolvedValue({ id: 'peer-1' });
    await expect(forgetTailcatForward('fwd_missing', { removePeerFn })).rejects.toMatchObject({ status: 404 });
    await expect(forgetTailcatForward('fwd_1', { removePeerFn })).resolves.toEqual({ id: 'fwd_1', peerId: 'peer-1' });
    expect(removePeerFn).toHaveBeenCalledWith('peer-1', { stopTransport: false });
    const [, written] = atomicWrite.mock.calls.at(-1);
    expect(written.forwards).toEqual([]);
  });
});

describe('tailcat startup diagnostics and DERP map priming', () => {
  beforeEach(() => { _resetLiveForwardsForTests(); vi.clearAllMocks(); });
  afterEach(() => { _resetLiveForwardsForTests(); });

  it('scrubs capability tokens out of diagnostics but keeps the reason readable', () => {
    const text = `Expand: fetching DERPMap for region -1: context deadline exceeded\ndial ${EXAMPLE_TC}: refused`;
    const redacted = redactTailcatDiagnostics(text);
    expect(redacted).toContain('fetching DERPMap');
    expect(redacted).toContain('refused');
    expect(redacted).not.toContain('tcEXAMPLE');
    expect(redactTailcatDiagnostics('')).toBe('');
  });

  it('reports what tailcat said when startup times out, instead of only that it did', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = startForwardProcess({ bin: 'tailcat', tcAddress: EXAMPLE_TC, localPort: 15555,
      spawnFn: () => child, readyMs: 8000, isListening: async () => false });
    const assertion = expect(pending).rejects.toThrow(/fetching DERPMap/);
    child.stderr.emit('data', 'Expand: fetching DERPMap for region -1: context deadline exceeded\n');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    vi.useRealTimers();
  });

  it('accepts a listening local port as readiness, so a quiet CLI build still works', async () => {
    // tailcat <=0.5.0 logs `forwarding …` only under --verbose; readiness must not
    // depend on any log wording, or a released build times out while working fine.
    const child = fakeChild();
    let probes = 0;
    await expect(startForwardProcess({
      bin: 'tailcat', tcAddress: EXAMPLE_TC, localPort: 15555, spawnFn: () => child,
      readyMs: 2_000, probeMs: 5,
      // First probe: nothing listening yet. Second: the listener is up.
      isListening: async () => { probes += 1; return probes > 1; },
    })).resolves.toBe(child);
  });

  it('names the DERP map cache file the way tailcat does, per platform', () => {
    expect(derpMapCachePath({
      url: 'https://example.com/derpmap.json', platform: 'darwin', home: '/example/home', env: {},
    })).toBe('/example/home/Library/Caches/tailcat/derpmap-https%3A%2F%2Fexample.com%2Fderpmap.json.json');
    expect(derpMapCachePath({
      url: 'https://example.com/derpmap.json', platform: 'linux', home: '/example/home',
      env: { XDG_CACHE_HOME: '/example/cache' },
    })).toBe('/example/cache/tailcat/derpmap-https%3A%2F%2Fexample.com%2Fderpmap.json.json');
    expect(derpMapCachePath({
      url: 'https://example.com/derpmap.json', platform: 'win32', home: 'C:\\example\\home',
      env: { LOCALAPPDATA: 'C:\\example\\cache' },
    })).toBe('C:\\example\\cache\\tailcat\\derpmap-https%3A%2F%2Fexample.com%2Fderpmap.json.json');
  });

  it('primes the DERP map with PortOS own fetch, but never caches a non-map body', async () => {
    const writes = [];
    const write = async (path, body) => { writes.push([path, body]); };
    const missing = async () => { throw new Error('ENOENT'); };
    await expect(primeDerpMapCache({
      cachePath: '/example/cache/derpmap.json',
      fetchFn: async () => ({ ok: true, text: async () => '{"Regions":{"1":{}}}' }),
      statFn: missing, writeFn: write,
    })).resolves.toMatchObject({ primed: true });
    expect(writes).toEqual([['/example/cache/derpmap.json', '{"Regions":{"1":{}}}']]);

    writes.length = 0;
    await expect(primeDerpMapCache({
      cachePath: '/example/cache/derpmap.json',
      fetchFn: async () => ({ ok: true, text: async () => '<html>gateway timeout</html>' }),
      statFn: missing, writeFn: write,
    })).resolves.toMatchObject({ primed: false, reason: 'unavailable' });
    expect(writes).toEqual([]);
  });

  it('skips the fetch entirely while the cached map is still fresh', async () => {
    const fetchFn = vi.fn();
    await expect(primeDerpMapCache({
      cachePath: '/example/cache/derpmap.json',
      statFn: async () => ({ mtimeMs: 1_000 }),
      fetchFn,
      now: 2_000,
      freshMs: 10_000,
    })).resolves.toMatchObject({ primed: false, reason: 'fresh' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never reaches the network from a suite that forgot to inject a fetch', async () => {
    await expect(primeDerpMapCache({ cachePath: '/example/cache/derpmap.json', statFn: async () => { throw new Error('ENOENT'); } }))
      .resolves.toEqual({ primed: false, reason: 'no-fetch' });
  });
});
