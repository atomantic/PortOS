import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// A PORTOS_DATA_ROOT pin is ignored in a CoS worktree, so it would put these fixtures in the checkout's data/.
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('mkserve-manager-test-'),
}));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('../lib/downloadPreflight.js', async (original) => ({ ...await original(), assessDownloadPreflight: vi.fn() }));
import { assessDownloadPreflight } from '../lib/downloadPreflight.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import * as fileCore from '../lib/fileCore.js';
import * as api from './mkserveRuntimeInstall.js';

const marker = () => join(lazyTempDataRoot('mkserve-manager-test-'), 'cache', 'mkserve', 'installed.json');
const previous = { bundle: 'a'.repeat(40), version: 'b'.repeat(40), revision: 'c'.repeat(40), files: [['weights', 3]] };

beforeEach(() => {
  runStreamingCommand.mockReset();
  assessDownloadPreflight.mockReset().mockResolvedValue({ verdict: 'ok' });
});

afterAll(cleanupTempDataRoots);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedPrevious(record = previous) {
  const paths = api.mkserveInstallPaths(record.bundle, record.revision);
  await Promise.all([
    mkdir(dirname(paths.python), { recursive: true }),
    mkdir(join(paths.source, 'mkserve'), { recursive: true }),
    mkdir(paths.weights, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.python, 'synthetic test executable'),
    writeFile(join(paths.source, 'mkserve', '__main__.py'), 'main'),
    writeFile(join(paths.weights, 'weights'), 'abc'),
    writeFile(marker(), JSON.stringify(record)),
  ]);
  await chmod(paths.python, 0o755);
  return paths;
}

describe('mkserve pinned installation', () => {
  it('removes the selected release and install marker without removing the checkpoint', async () => {
    const paths = await seedPrevious();
    await api.removeMkserveRelease(await api.readMkserveInstall());
    await expect(access(paths.work)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(api.readMkserveInstall()).resolves.toBeNull();
    expect(await readFile(join(paths.weights, 'weights'), 'utf8')).toBe('abc');
  });

  it('does not activate an update or run a substituted download after a digest mismatch', async () => {
    await seedPrevious();
    runStreamingCommand.mockImplementation(async (file, args) => {
      expect(file).toBe('/usr/bin/curl');
      const output = args[args.indexOf('--output') + 1];
      await writeFile(output, 'not a trusted archive');
      return { success: true };
    });
    await expect(api.installPinnedMkserve(() => {}, await api.readMkserveInstall())).rejects.toMatchObject({ status: 502, code: 'MKSERVE_INSTALL_FAILED', message: expect.stringContaining('failed SHA-256 verification') });
    expect(runStreamingCommand).toHaveBeenCalledTimes(1);
    await expect(api.readMkserveInstall()).resolves.toMatchObject(previousWithoutFiles());
    const paths = api.mkserveInstallPaths(previous.bundle, previous.revision);
    await expect(access(paths.work)).resolves.toBeUndefined();
    await expect(access(paths.weights)).resolves.toBeUndefined();
  });

  it('refuses an install the volume cannot hold before any download, counting a resumable partial', async () => {
    assessDownloadPreflight.mockResolvedValue({ verdict: 'insufficient', freeBytes: 1 });
    await expect(api.installPinnedMkserve(() => {})).rejects.toMatchObject({ code: 'DISK_INSUFFICIENT' });
    const [{ destPath, expectedBytes }] = assessDownloadPreflight.mock.calls[0];
    await mkdir(destPath, { recursive: true });
    await writeFile(join(destPath, 'config.json.part'), 'abc');
    await expect(api.installPinnedMkserve(() => {})).rejects.toMatchObject({ code: 'DISK_INSUFFICIENT' });
    expect(assessDownloadPreflight.mock.calls[1][0].expectedBytes).toBe(expectedBytes - 3);
    expect(runStreamingCommand).not.toHaveBeenCalled();
  });

  it('reports checkpoint bytes, keeps the cancelled partial and resumes it after retry', async () => {
    const sha256File = fileCore.sha256File;
    vi.spyOn(fileCore, 'sha256File').mockImplementation((file, options) => {
      if (/uv\.tar\.gz(?:\.part)?$/.test(file)) return '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731';
      if (/source\.tar\.gz(?:\.part)?$/.test(file)) return 'c72e99348f3ba301df71ae6bce755be959f1a3e8db8fafc8c4275d6db4f9f5f3';
      return sha256File(file, options);
    });
    runStreamingCommand.mockImplementation(async (file, args) => {
      if (file === '/usr/bin/curl') await writeFile(args[args.indexOf('--output') + 1], 'fixture archive');
      return { success: true };
    });
    const controller = new AbortController();
    const fetchCheckpoint = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array(512)); },
    }), { headers: { 'Content-Length': '6868', ETag: '"fixture"' } }));
    vi.stubGlobal('fetch', fetchCheckpoint);
    const emit = vi.fn();
    const outcome = api.installPinnedMkserve(emit, undefined, { signal: controller.signal }).catch((error) => error);
    await vi.waitFor(() => expect(assessDownloadPreflight).toHaveBeenCalled());
    const [{ destPath }] = assessDownloadPreflight.mock.calls[0];
    const partial = join(destPath, 'chat_template.jinja.partial');
    try {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('Downloading chat_template.jinja: 7% (512 / 6868 bytes)'));
      await vi.waitFor(async () => expect((await readFile(partial)).length).toBe(512));
    } finally {
      controller.abort();
    }
    expect(await outcome).toBe(controller.signal.reason);

    fetchCheckpoint.mockResolvedValueOnce(new Response(new Uint8Array(6356), {
      status: 206, headers: { 'Content-Range': 'bytes 512-6867/6868', 'Content-Length': '6356' },
    }));
    await expect(api.installPinnedMkserve(emit)).rejects.toThrow(/failed SHA-256 verification/);
    expect(fetchCheckpoint.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=512-', 'If-Range': '"fixture"' });
    expect(emit).toHaveBeenCalledWith('Downloading chat_template.jinja: 100% (6868 / 6868 bytes)');
    await expect(access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(destPath, 'chat_template.jinja.partial.etag'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears only the engine cache when repairing a verified installation', async () => {
    const paths = await seedPrevious();
    await mkdir(paths.build, { recursive: true });
    await writeFile(join(paths.build, 'stale'), 'broken engine');
    const controller = new AbortController();
    runStreamingCommand.mockImplementationOnce(async (file, args, _onLine, options) => {
      expect(file).toBe(paths.python);
      expect(args).toEqual(expect.arrayContaining(['pull', '--workdir', paths.build, '--model-dir', paths.weights]));
      expect(options.signal).toBe(controller.signal);
      await expect(access(paths.build)).rejects.toMatchObject({ code: 'ENOENT' });
      return { success: true };
    });
    await api.rebuildMkserveEngine(paths, vi.fn(), { repair: true, signal: controller.signal });
    expect(runStreamingCommand).toHaveBeenCalledOnce();
    await expect(readFile(join(paths.weights, 'weights'), 'utf8')).resolves.toBe('abc');
    await expect(api.readMkserveInstall()).resolves.toMatchObject(previousWithoutFiles());
  });

  it('retires only the previous managed bundle and replaced checkpoint after activating the update', async () => {
    const previousPaths = await seedPrevious();
    const unrelated = api.mkserveInstallPaths('d'.repeat(40), 'e'.repeat(40));
    await Promise.all([mkdir(unrelated.work, { recursive: true }), mkdir(unrelated.weights, { recursive: true })]);
    await api.activateMkserveInstall(await api.readMkserveInstall());
    expect(JSON.parse(await readFile(marker(), 'utf8')).bundle).toBe(api.MKSERVE_BUNDLE);
    await expect(access(previousPaths.work)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(previousPaths.weights)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(unrelated.work)).resolves.toBeUndefined();
    await expect(access(unrelated.weights)).resolves.toBeUndefined();
  });

  it('keeps the shared checkpoint when only the runtime bundle changes', async () => {
    await api.activateMkserveInstall();
    const active = JSON.parse(await readFile(marker(), 'utf8'));
    const previousPaths = await seedPrevious({ ...previous, revision: active.revision });
    await api.activateMkserveInstall(await api.readMkserveInstall());
    await expect(access(previousPaths.work)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(previousPaths.weights, 'weights'), 'utf8')).resolves.toBe('abc');
  });

  it('will not advertise a checkpoint with a missing or truncated shard as ready to start', async () => {
    const paths = await seedPrevious();
    await writeFile(join(paths.weights, 'weights'), 'ab');
    await expect(api.readMkserveInstall()).resolves.toBeNull();
  });
});

function previousWithoutFiles() {
  const { bundle, version, revision } = previous;
  return { bundle, version, revision };
}
