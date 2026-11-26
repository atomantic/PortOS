import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// A PORTOS_DATA_ROOT pin is ignored in a CoS worktree, so it would put these fixtures in the checkout's data/.
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('mkserve-manager-test-'),
}));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('../lib/downloadPreflight.js', async (original) => ({ ...await original(), assessDownloadPreflight: vi.fn() }));
import { assessDownloadPreflight } from '../lib/downloadPreflight.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import * as api from './mkserveRuntimeInstall.js';

const marker = () => join(lazyTempDataRoot('mkserve-manager-test-'), 'cache', 'mkserve', 'installed.json');
const previous = { bundle: 'a'.repeat(40), version: 'b'.repeat(40), revision: 'c'.repeat(40), files: [['weights', 3]] };

beforeEach(() => {
  runStreamingCommand.mockReset();
  assessDownloadPreflight.mockReset().mockResolvedValue({ verdict: 'ok' });
});

afterAll(cleanupTempDataRoots);

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
    await expect(api.installPinnedMkserve(() => {}, await api.readMkserveInstall())).rejects.toThrow('failed SHA-256 verification');
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
