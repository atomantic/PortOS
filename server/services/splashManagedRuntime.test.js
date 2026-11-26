import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessDownloadPreflight } from '../lib/downloadPreflight.js';
import * as fileCore from '../lib/fileCore.js';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { SPLASH_MODEL, SPLASH_ORIGIN } from '../lib/splashRuntime.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import {
  installPinnedSplash, probeSplashEndpoint, readInstalledSplashVersion, splashRoot, SPLASH_VERSION, supportsManagedSplash,
} from './splashManagedRuntime.js';

let dataRoot;
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: () => dataRoot }));
vi.mock('../lib/downloadPreflight.js', async (original) => ({
  ...await original(),
  assessDownloadPreflight: vi.fn(),
}));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));

const asset = `splash-${SPLASH_VERSION}-arm64-macos26`;
const marker = () => join(splashRoot(), 'active-version');
const previousVersion = '1.0.0';
const previousRelease = () => join(splashRoot(), `runtime-${previousVersion}`);

async function writeRelease(directory) {
  const python = join(directory, 'python', 'bin', 'python3');
  const launcher = join(directory, 'install', 'launcher.py');
  await Promise.all([
    mkdir(dirname(python), { recursive: true }),
    mkdir(dirname(launcher), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(python, 'fixture executable', { mode: 0o755 }),
    writeFile(launcher, 'fixture launcher'),
  ]);
}

async function seedPreviousRelease() {
  await writeRelease(previousRelease());
  await writeFile(marker(), `${previousVersion}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Splash platform support', () => {
  it.each([
    ['darwin', 'arm64', '26.3', 'Apple M3', false],
    ['darwin', 'arm64', '26.4', 'Apple M1 Max', false],
    ['darwin', 'arm64', '26.4', 'Apple M2 Ultra', false],
    ['darwin', 'arm64', '26.4', 'Apple M3', true],
    ['darwin', 'arm64', '27.0', 'Apple M5 Max', true],
    ['darwin', 'x64', '26.4', 'Intel', false],
    ['linux', 'arm64', '26.4', 'Apple M3', false],
  ])('%s %s %s with %s has support=%s', async (platform, arch, macVersion, cpuModel, supported) => {
    await expect(supportsManagedSplash({ platform, arch, macVersion, cpuModel })).resolves.toBe(supported);
  });
});

describe('Splash installation', () => {
  beforeEach(() => {
    dataRoot = createTempDataRoot('portos-splash-runtime-test-');
    assessDownloadPreflight.mockReset().mockResolvedValue({ verdict: 'ok' });
    runStreamingCommand.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('fixture archive')));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('recognizes only a valid selected release with its runtime files present', async () => {
    await expect(readInstalledSplashVersion()).resolves.toBeNull();
    await seedPreviousRelease();
    await expect(readInstalledSplashVersion()).resolves.toBe(previousVersion);
    await rm(join(previousRelease(), 'install', 'launcher.py'));
    await expect(readInstalledSplashVersion()).resolves.toBeNull();
    await writeRelease(previousRelease());
    await writeFile(marker(), 'invalid version\n');
    await expect(readInstalledSplashVersion()).resolves.toBeNull();
  });

  it('rejects a SHA-256 mismatch before extraction, preserves the active release, and cleans staging', async () => {
    await seedPreviousRelease();
    await expect(installPinnedSplash({ previousVersion, emit: vi.fn() })).rejects.toMatchObject({
      code: 'DOWNLOAD_HASH_MISMATCH',
    });
    expect(runStreamingCommand).not.toHaveBeenCalled();
    await expect(readInstalledSplashVersion()).resolves.toBe(previousVersion);
    expect((await readdir(splashRoot())).sort()).toEqual(['active-version', 'home', `runtime-${previousVersion}`]);
  });

  it.each([true, false])('keeps the previous release selected until preparation succeeds (success=%s)', async (success) => {
    await seedPreviousRelease();
    // Model the official digest for the fixture archive so the real download
    // helper can pass verification without fetching the vendor's release.
    vi.spyOn(fileCore, 'sha256File').mockResolvedValue('40a1e6d585ed8f51b2f2e17c331e7d9533a1b666e1e6e418ddd623bdd3a29e2b');
    runStreamingCommand
      .mockImplementationOnce(async (_command, _args, _onLine, { cwd }) => {
        await writeRelease(join(cwd, asset));
        return { success: true };
      })
      .mockResolvedValueOnce({ success: true })
      .mockImplementationOnce(async (_command, _args, onLine) => {
        await expect(readInstalledSplashVersion()).resolves.toBe(previousVersion);
        onLine('unstructured progress');
        const frame = { event: 'download', total: 100 };
        for (const done of [0, 10, 19, 9, 25, 110]) onLine(JSON.stringify({ ...frame, done }));
        onLine(JSON.stringify({ ...frame, done: 15, repo: 'incoai/Inkling-2-Mini-DFlash2' }));
        onLine(JSON.stringify({ ...frame, done: 30, total: 0 }));
        return { success };
      });
    const emit = vi.fn();
    const pending = installPinnedSplash({ previousVersion, emit });
    if (success) {
      await pending;
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'SPLASH_INSTALL_FAILED' });
    }
    const selected = success ? SPLASH_VERSION : previousVersion;
    await expect(readInstalledSplashVersion()).resolves.toBe(selected);
    expect((await readdir(splashRoot())).sort()).toEqual(['active-version', 'home', `runtime-${selected}`]);
    expect(emit.mock.calls.map(([message]) => message).filter((message) => message.startsWith('Downloading Inkling'))).toEqual([
      'Downloading Inkling 2 Mini model: 0%',
      'Downloading Inkling 2 Mini model: 10%',
      'Downloading Inkling 2 Mini model: 20%',
      'Downloading Inkling 2 Mini model: 100%',
      'Downloading Inkling 2 Mini drafter: 10%',
    ]);
  });
});

describe('Splash endpoint probing', () => {
  const ready = () => Response.json({ status: 'ready' });

  it('reports recovering service without consulting the model listing', async () => {
    const fetchProbe = vi.fn().mockResolvedValue(Response.json({ status: 'unavailable' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchProbe);
    await expect(probeSplashEndpoint()).resolves.toEqual({ state: 'not-ready' });
    expect(fetchProbe).toHaveBeenCalledExactlyOnceWith(`${SPLASH_ORIGIN}/ready`, expect.objectContaining({ redirect: 'error' }));
  });

  it('ignores models owned by another runtime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce(Response.json({
      data: [{ id: SPLASH_MODEL, owned_by: 'other-runtime' }],
    })));
    await expect(probeSplashEndpoint()).resolves.toEqual({ state: 'unrecognized' });
  });

  it.each([
    [{ max_model_len: 65536, context_length: 32768 }, 65536],
    [{ max_model_len: -1, context_length: 32768 }, 32768],
  ])('prefers the pinned model and reads its valid context window (%j)', async (fields, servedContextWindow) => {
    const fetchProbe = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce(Response.json({
      data: [
        { id: 'alternate-splash-model', owned_by: 'splash' },
        { id: SPLASH_MODEL, owned_by: 'splash', ...fields },
      ],
    }));
    vi.stubGlobal('fetch', fetchProbe);
    await expect(probeSplashEndpoint()).resolves.toEqual({ state: 'external', model: SPLASH_MODEL, servedContextWindow });
    expect(fetchProbe).toHaveBeenNthCalledWith(2, `${SPLASH_ORIGIN}/v1/models`, expect.objectContaining({ redirect: 'error' }));
  });

  it('stops probing when Fetch refuses a redirect at /ready', async () => {
    const fetchProbe = vi.fn().mockImplementation(async (_url, options) => {
      if (options.redirect === 'error') throw new TypeError('unexpected redirect');
      return ready();
    });
    vi.stubGlobal('fetch', fetchProbe);
    await expect(probeSplashEndpoint()).resolves.toEqual({ state: 'missing' });
    expect(fetchProbe).toHaveBeenCalledTimes(1);
  });
});
