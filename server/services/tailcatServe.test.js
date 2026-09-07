import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseServeListenAddr,
  ensureServeKey,
  startServeProcess,
  ensureTailcatServe,
  getTailcatServeStatus,
  stopTailcatServe,
  retryTailcatServe,
  restoreServe,
  _resetLiveServeForTests,
  _liveServeForTests,
  DEFAULT_KEY_NAME,
  DEFAULT_SERVE_PORT,
} from './tailcatServe.js';

vi.mock('../lib/fileUtils.js', async (original) => ({
  ...(await original()),
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
}));
import { readJSONFile, atomicWrite } from '../lib/fileUtils.js';

vi.mock('../lib/bufferedSpawn.js', async (original) => ({
  ...(await original()),
  bufferedSpawn: vi.fn(),
}));
import { bufferedSpawn } from '../lib/bufferedSpawn.js';

const EXAMPLE_TC = 'tcEXAMPLE' + 'C'.repeat(40);

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

describe('tailcatServe helpers', () => {
  beforeEach(() => {
    _resetLiveServeForTests();
    vi.clearAllMocks();
    readJSONFile.mockResolvedValue({ version: 1, serve: null });
  });

  afterEach(() => {
    _resetLiveServeForTests();
  });

  it('parses --json listenAddr and rejects placeholders', () => {
    expect(parseServeListenAddr(JSON.stringify({ listenAddr: EXAMPLE_TC }))).toBe(EXAMPLE_TC);
    expect(parseServeListenAddr(`noise\n{"listenAddr":"${EXAMPLE_TC}"}\n`)).toBe(EXAMPLE_TC);
    expect(parseServeListenAddr(EXAMPLE_TC)).toBe(EXAMPLE_TC);
    expect(parseServeListenAddr('tcEXAMPLE…')).toBe(null);
    expect(parseServeListenAddr('')).toBe(null);
  });

  it('ensureServeKey treats an existing key as success', async () => {
    bufferedSpawn.mockResolvedValue({
      success: false,
      code: 1,
      timedOut: false,
      stderr: 'key already exists; use --force to overwrite\n',
      stdout: '',
    });
    const result = await ensureServeKey({ bin: '/usr/bin/tailcat', keyName: 'portos-api' });
    expect(result).toMatchObject({ created: false, keyName: 'portos-api' });
    expect(bufferedSpawn).toHaveBeenCalledWith(
      '/usr/bin/tailcat',
      ['genkey', '--key=portos-api'],
      expect.any(Object),
    );
  });

  it('startServeProcess resolves when stdout prints listenAddr JSON', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ listenAddr: EXAMPLE_TC })}\n`));
      return child;
    });
    const started = await startServeProcess({
      bin: '/usr/bin/tailcat',
      localPort: 5555,
      keyName: 'portos-api',
      spawnFn,
      readyMs: 2_000,
      readFileFn: async () => { throw new Error('no file'); },
      mkdirFn: async () => {},
    });
    expect(started.tcAddress).toBe(EXAMPLE_TC);
    expect(started.localPort).toBe(5555);
    expect(spawnFn).toHaveBeenCalledWith(
      '/usr/bin/tailcat',
      ['serve', '--verbose', '--full-address', '--json', '--key=portos-api', '5555'],
      expect.any(Object),
    );
  });

  it('ensureTailcatServe persists enabled config and returns copyable address', async () => {
    const child = fakeChild();
    let saved = null;
    atomicWrite.mockImplementation(async (_path, data) => { saved = data; });
    readJSONFile.mockImplementation(async () => saved || { version: 1, serve: null });

    const status = await ensureTailcatServe({
      ensureInstalled: async () => ({ bin: '/usr/bin/tailcat', installed: false }),
      primeDerpMap: async () => ({ primed: false }),
      ensureKey: async () => ({ created: true, keyName: DEFAULT_KEY_NAME }),
      startServe: async () => ({ child, tcAddress: EXAMPLE_TC, localPort: DEFAULT_SERVE_PORT, keyName: DEFAULT_KEY_NAME }),
    });

    expect(status.live).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.tcAddress).toBe(EXAMPLE_TC);
    expect(status.hasAddress).toBe(true);
    expect(status.tcAddressRedacted).not.toBe(EXAMPLE_TC);
    expect(status.tcAddressRedacted).toContain('…');
    expect(_liveServeForTests()?.child).toBe(child);
    expect(saved?.serve?.enabled).toBe(true);
    expect(saved?.serve?.tcAddress).toBe(EXAMPLE_TC);
  });

  it('stopTailcatServe disables restore-on-boot', async () => {
    const child = fakeChild();
    let saved = {
      version: 1,
      serve: {
        enabled: true,
        status: 'active',
        localPort: 5555,
        keyName: 'portos-api',
        tcAddress: EXAMPLE_TC,
        lastError: null,
        lastErrorAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    readJSONFile.mockImplementation(async () => saved);
    atomicWrite.mockImplementation(async (_path, data) => { saved = data; });

    await ensureTailcatServe({
      ensureInstalled: async () => ({ bin: '/x', installed: false }),
      primeDerpMap: async () => ({}),
      ensureKey: async () => ({ created: false, keyName: 'portos-api' }),
      startServe: async () => ({ child, tcAddress: EXAMPLE_TC, localPort: 5555, keyName: 'portos-api' }),
    });
    expect(_liveServeForTests()).not.toBe(null);

    const stopped = await stopTailcatServe({ disable: true });
    expect(stopped.live).toBe(false);
    expect(stopped.enabled).toBe(false);
    expect(stopped.status).toBe('stopped');
    expect(child.kill).toHaveBeenCalled();
    expect(_liveServeForTests()).toBe(null);
  });

  it('restoreServe starts when enabled and skips when disabled', async () => {
    const child = fakeChild();
    readJSONFile.mockResolvedValue({
      version: 1,
      serve: {
        enabled: true,
        status: 'active',
        localPort: 5555,
        keyName: 'portos-api',
        tcAddress: EXAMPLE_TC,
        lastError: null,
        lastErrorAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    atomicWrite.mockResolvedValue(undefined);

    const ok = await restoreServe({
      ensureInstalled: async () => ({ bin: '/usr/bin/tailcat' }),
      primeDerpMap: async () => ({}),
      ensureKey: async () => ({ created: false, keyName: 'portos-api' }),
      startServe: async () => ({ child, tcAddress: EXAMPLE_TC, localPort: 5555, keyName: 'portos-api' }),
    });
    expect(ok).toEqual({ restored: true });
    expect(_liveServeForTests()?.child).toBe(child);

    _resetLiveServeForTests();
    readJSONFile.mockResolvedValue({ version: 1, serve: { enabled: false, status: 'stopped', localPort: 5555, keyName: 'portos-api', tcAddress: null } });
    const skipped = await restoreServe({
      ensureInstalled: async () => ({ bin: '/usr/bin/tailcat' }),
      startServe: async () => { throw new Error('should not run'); },
    });
    expect(skipped).toMatchObject({ restored: false, reason: 'disabled' });
  });

  it('retryTailcatServe kills a live child then restarts', async () => {
    const first = fakeChild();
    const second = fakeChild();
    let saved = {
      version: 1,
      serve: {
        enabled: true,
        status: 'failed',
        localPort: 5555,
        keyName: 'portos-api',
        tcAddress: EXAMPLE_TC,
        lastError: 'boom',
        lastErrorAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    readJSONFile.mockImplementation(async () => saved);
    atomicWrite.mockImplementation(async (_path, data) => { saved = data; });

    // Seed a live child by ensuring once.
    await ensureTailcatServe({
      ensureInstalled: async () => ({ bin: '/x' }),
      primeDerpMap: async () => ({}),
      ensureKey: async () => ({ created: false, keyName: 'portos-api' }),
      startServe: async () => ({ child: first, tcAddress: EXAMPLE_TC, localPort: 5555, keyName: 'portos-api' }),
    });

    const status = await retryTailcatServe({
      ensureInstalled: async () => ({ bin: '/x' }),
      primeDerpMap: async () => ({}),
      ensureKey: async () => ({ created: false, keyName: 'portos-api' }),
      startServe: async () => ({ child: second, tcAddress: EXAMPLE_TC, localPort: 5555, keyName: 'portos-api' }),
    });
    expect(first.kill).toHaveBeenCalled();
    expect(status.live).toBe(true);
    expect(_liveServeForTests()?.child).toBe(second);
  });

  it('getTailcatServeStatus never invents a live process', async () => {
    const status = await getTailcatServeStatus();
    expect(status).toMatchObject({
      enabled: false,
      live: false,
      localPort: DEFAULT_SERVE_PORT,
      keyName: DEFAULT_KEY_NAME,
      hasAddress: false,
      tcAddress: null,
    });
  });
});
