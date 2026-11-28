import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const { installPinnedAppleUv, runStreamingCommand, spawnMock } = vi.hoisted(() => ({
  installPinnedAppleUv: vi.fn(),
  runStreamingCommand: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('../../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-avatar-install-') }));
vi.mock('../../lib/processEnv.js', () => ({
  artifactDownloadEnv: () => ({ HTTPS_PROXY: 'http://proxy.example:8080', HF_TOKEN: 'download-only-token' }),
}));
vi.mock('../../lib/streamingSpawn.js', () => ({ runStreamingCommand }));
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: spawnMock,
}));
vi.mock('../mkserveRuntimeInstall.js', () => ({ installPinnedAppleUv }));

const {
  avatarBundle,
  avatarFilesPresent,
  avatarMarker,
  avatarPython,
  avatarRoot,
  avatarWeights,
  denyNetwork,
  installAvatar,
} = await import('./avatarInstall.js');

afterAll(cleanupTempDataRoots);

const REQUIRED_WEIGHT_FILES = [
  'tensor/flow_transformer.safetensors',
  'tensor/motion_autoencoder.safetensors',
  'audio/model.safetensors',
  'audio/config.json',
  'audio/preprocessor_config.json',
];

async function writeBundleFiles(bundle, omit = null) {
  const files = [avatarPython(bundle), ...REQUIRED_WEIGHT_FILES.map(rel => join(avatarWeights, rel))];
  for (const file of files) {
    if (omit && file.endsWith(omit)) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'fixture');
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  await rm(avatarRoot, { recursive: true, force: true });
  installPinnedAppleUv.mockResolvedValue('/fixture/bin/uv');
  spawnMock.mockImplementation((cmd, argv, options) => ({ cmd, argv, options }));
});

describe('avatarInstall', () => {
  it('computes a deterministic 24-hex bundle digest and verifies all required files', async () => {
    const bundle = await avatarBundle();
    expect(bundle).toMatch(/^[a-f0-9]{24}$/);
    expect(await avatarBundle()).toBe(bundle);
    expect(await avatarFilesPresent(bundle)).toBe(false);

    await writeBundleFiles(bundle, 'audio/model.safetensors');
    expect(await avatarFilesPresent(bundle)).toBe(false);

    await writeBundleFiles(bundle);
    expect(await avatarFilesPresent(bundle)).toBe(true);
  });

  it('installs hash-locked wheels, downloads weights with network env, converts offline under sandbox-exec, and writes the marker', async () => {
    const calls = [];
    runStreamingCommand.mockImplementation(async (file, args, _onOutput, opts) => {
      const spawned = opts.spawnImpl(file, args, { cwd: opts.cwd });
      calls.push({ file, args, env: spawned.options.env });
      if (args.includes('download')) await mkdir(avatarWeights, { recursive: true });
      return { success: true };
    });

    const progress = vi.fn();
    const controller = new AbortController();
    await installAvatar({ signal: controller.signal, progress });

    const bundle = await avatarBundle();
    expect(installPinnedAppleUv).toHaveBeenCalledWith(avatarRoot, progress, controller.signal);
    expect(calls).toHaveLength(4);

    // 1. Managed Python venv
    expect(calls[0].file).toBe('/fixture/bin/uv');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--no-config', 'venv', '--managed-python', join(avatarRoot, bundle)]));
    expect(calls[0].env).toMatchObject({ HTTPS_PROXY: 'http://proxy.example:8080', HF_TOKEN: 'download-only-token' });

    // 2. Hash-locked binary-only wheel sync
    expect(calls[1].file).toBe('/fixture/bin/uv');
    expect(calls[1].args).toEqual(expect.arrayContaining(['--no-config', 'pip', 'sync', '--require-hashes', '--only-binary', ':all:']));
    expect(calls[1].env).toHaveProperty('HTTPS_PROXY');

    // 3. Verified weight download
    expect(calls[2].file).toBe(avatarPython(bundle));
    expect(calls[2].args).toEqual(expect.arrayContaining(['-B', 'download', avatarWeights]));
    expect(calls[2].env).toHaveProperty('HF_TOKEN');

    // 4. Offline conversion under sandbox-exec without download credentials or proxy env
    expect(calls[3].file).toBe('/usr/bin/sandbox-exec');
    expect(calls[3].args[0]).toBe('-D');
    expect(calls[3].args[1]).toMatch(/^WEIGHTS=.+\/weights$/);
    expect(calls[3].args[2]).toBe('-p');
    expect(calls[3].args[3]).toContain(denyNetwork);
    expect(calls[3].args[3]).toContain('(deny file-write*)');
    expect(calls[3].args[3]).toContain('(allow file-write* (subpath (param "WEIGHTS")))');
    expect(calls[3].env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONNOUSERSITE: '1' });
    expect(calls[3].env).not.toHaveProperty('HTTPS_PROXY');
    expect(calls[3].env).not.toHaveProperty('HF_TOKEN');

    expect(await readFile(avatarMarker, 'utf8')).toBe(bundle);
  });

  it('refuses symlinked weights directories before running sandbox-exec conversion or writing the marker', async () => {
    const outsideDir = join(dirname(avatarRoot), 'outside-weights');
    await mkdir(outsideDir, { recursive: true });
    runStreamingCommand.mockImplementation(async (_file, args) => {
      if (args.includes('download')) await symlink(outsideDir, avatarWeights);
      return { success: true };
    });

    await expect(installAvatar({ signal: new AbortController().signal, progress: vi.fn() }))
      .rejects.toThrow('AvatarForcing weights cannot be symlinked.');

    expect(runStreamingCommand).toHaveBeenCalledTimes(3);
    expect(runStreamingCommand.mock.calls.some(([file]) => file === '/usr/bin/sandbox-exec')).toBe(false);
    await expect(readFile(avatarMarker, 'utf8')).rejects.toThrow();
  });

  it('stops on step failure and never writes the installed marker when aborted', async () => {
    runStreamingCommand
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });

    await expect(installAvatar({ signal: new AbortController().signal, progress: vi.fn() }))
      .rejects.toThrow('Could not install verified AvatarForcing wheels.');
    expect(runStreamingCommand).toHaveBeenCalledTimes(2);
    await expect(readFile(avatarMarker, 'utf8')).rejects.toThrow();

    // Aborting during the final conversion step must prevent writing the marker.
    const controller = new AbortController();
    runStreamingCommand.mockReset();
    runStreamingCommand.mockImplementation(async (file, args) => {
      if (args.includes('download')) await mkdir(avatarWeights, { recursive: true });
      if (file === '/usr/bin/sandbox-exec') controller.abort(new Error('canceled'));
      return { success: true };
    });

    await expect(installAvatar({ signal: controller.signal, progress: vi.fn() })).rejects.toThrow('canceled');
    await expect(readFile(avatarMarker, 'utf8')).rejects.toThrow();
  });
});
