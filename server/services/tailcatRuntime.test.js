import { describe, it, expect, vi, beforeEach } from 'vitest';
import { delimiter, join } from 'node:path';
import {
  ensureTailcatInstalled, detectTailcat, findTooOldTailcat, listTailcatInstallers,
  listCandidateTailcatBins, manualInstallHint, derpMapCachePath, primeDerpMapCache,
} from './tailcatRuntime.js';
import { MIN_TAILCAT_VERSION } from '../lib/tailcatVersion.js';

// Keep installer execution mocked while exercising its real result handling.
vi.mock('../lib/bufferedSpawn.js', async (original) => ({
  ...(await original()),
  bufferedSpawn: vi.fn(),
}));
import { bufferedSpawn } from '../lib/bufferedSpawn.js';

describe('Tailcat CLI runtime', () => {
  beforeEach(() => { vi.clearAllMocks(); });

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
      findTooOld: async () => null,
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
      findTooOld: async () => null,
      installers: [{ label: 'go install', run: async () => {} }],
    })).rejects.toMatchObject({
      code: 'TAILCAT_INSTALL_FAILED',
      message: expect.stringContaining('go install finished but no tailcat binary was found'),
    });
  });

  it('ensureTailcatInstalled fails clearly when no package manager is present', async () => {
    await expect(ensureTailcatInstalled({
      detect: async () => null,
      findTooOld: async () => null,
      installers: [],
    })).rejects.toMatchObject({ code: 'TAILCAT_MISSING', status: 503 });
  });

  it('detectTailcat skips binaries below the minimum version', async () => {
    expect(MIN_TAILCAT_VERSION).toBe('0.6.0');
    const readOutput = vi.fn(async (bin) => {
      if (bin === '/old/tailcat') return 'v0.5.0';
      if (bin === '/new/tailcat') return 'v0.6.0';
      return null;
    });
    await expect(detectTailcat({
      candidates: ['/old/tailcat', '/new/tailcat'],
      readOutput,
    })).resolves.toBe('/new/tailcat');
    await expect(detectTailcat({
      candidates: ['/old/tailcat'],
      readOutput,
    })).resolves.toBeNull();
  });

  it('findTooOldTailcat reports a runnable but outdated binary', async () => {
    await expect(findTooOldTailcat({
      candidates: ['/old/tailcat'],
      readOutput: async () => 'v0.5.0',
    })).resolves.toEqual({ bin: '/old/tailcat', version: '0.5.0' });
  });

  it('ensureTailcatInstalled refuses a leftover 0.5.x after brew claims success', async () => {
    const run = vi.fn(async () => {});
    const error = await ensureTailcatInstalled({
      detect: async () => null,
      findTooOld: async () => ({ bin: '/opt/homebrew/bin/tailcat', version: '0.5.0' }),
      platform: 'darwin',
      installers: [{ label: 'brew install/upgrade tailcat', run }],
    }).catch((err) => err);
    expect(run).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: 'TAILCAT_VERSION_TOO_OLD', status: 503 });
    expect(error.message).toContain('0.6.0+');
    expect(error.message).toContain('found 0.5.0');
    expect(error.message).toContain('brew upgrade tailcat');
    expect(error.message).toContain('Do not set --psk=false');
  });

  it('ensureTailcatInstalled upgrades via installers when only an old binary is present', async () => {
    let detectCalls = 0;
    const run = vi.fn(async () => {});
    const result = await ensureTailcatInstalled({
      detect: async () => {
        detectCalls += 1;
        return detectCalls === 1 ? null : '/example/go/bin/tailcat';
      },
      findTooOld: async () => ({ bin: '/opt/homebrew/bin/tailcat', version: '0.5.0' }),
      installers: [{ label: 'go install', run }],
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({ bin: '/example/go/bin/tailcat', installed: true });
  });

  it('ensureTailcatInstalled reports VERSION_TOO_OLD when no package manager and only 0.5.x exists', async () => {
    await expect(ensureTailcatInstalled({
      detect: async () => null,
      findTooOld: async () => ({ bin: '/usr/local/bin/tailcat', version: '0.5.0' }),
      installers: [],
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'TAILCAT_VERSION_TOO_OLD', status: 503 });
  });

  it('points macOS at Homebrew, since tailcat ships no darwin release binary', () => {
    expect(manualInstallHint('darwin')).toContain('brew upgrade tailcat');
    expect(manualInstallHint('darwin')).toContain('brew install tailcat');
    expect(manualInstallHint('darwin')).toContain('0.6.0+');
    expect(manualInstallHint('darwin')).not.toContain('/releases');
    expect(manualInstallHint('linux')).toContain('https://github.com/tailscale/tailcat/releases');
    expect(manualInstallHint('linux')).toContain('0.6.0+');
  });

  it('lists brew before go, and only for package managers that exist', () => {
    const runInstall = vi.fn(async () => {});
    expect(listTailcatInstallers({ brewBin: '/opt/homebrew/bin/brew', goBin: '/usr/bin/go', runInstall })
      .map((i) => i.label)).toEqual(['brew install/upgrade tailcat', 'go install']);
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
    expect(runInstall).toHaveBeenCalledWith('/opt/homebrew/bin/brew', ['upgrade', 'tailcat'],
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
    bufferedSpawn
      .mockResolvedValueOnce({ success: true, code: 0, stdout: '', stderr: '', timedOut: false })
      .mockResolvedValueOnce({ success: true, code: 0, stdout: '', stderr: '', timedOut: false });
    const [installer] = listTailcatInstallers({ brewBin: '/example/brew', goBin: null });
    await expect(installer.run()).resolves.toBeUndefined();
    expect(bufferedSpawn).toHaveBeenCalledWith('/example/brew', ['install', 'tailcat'],
      expect.objectContaining({ env: expect.objectContaining({ HOMEBREW_NO_AUTO_UPDATE: '1' }) }));
    expect(bufferedSpawn).toHaveBeenCalledWith('/example/brew', ['upgrade', 'tailcat'],
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
