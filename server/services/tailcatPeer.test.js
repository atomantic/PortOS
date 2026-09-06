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
