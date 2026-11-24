import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
import { runStreamingCommand } from '../lib/streamingSpawn.js';

let root;
let api;
const previous = { bundle: 'a'.repeat(40), version: 'b'.repeat(40), revision: 'c'.repeat(40), files: [['weights', 3]] };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mkserve-manager-test-'));
  vi.stubEnv('PORTOS_DATA_ROOT', root);
  api = await import('./mkserveRuntimeInstall.js');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
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
    writeFile(join(root, 'data', 'cache', 'mkserve', 'installed.json'), JSON.stringify(record)),
  ]);
  await chmod(paths.python, 0o755);
  return paths;
}

describe('mkserve pinned installation', () => {
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

  it('retires only the previous managed bundle and replaced checkpoint after activating the update', async () => {
    const marker = join(root, 'data', 'cache', 'mkserve', 'installed.json');
    const previousPaths = await seedPrevious();
    const unrelated = api.mkserveInstallPaths('d'.repeat(40), 'e'.repeat(40));
    await Promise.all([mkdir(unrelated.work, { recursive: true }), mkdir(unrelated.weights, { recursive: true })]);
    await api.activateMkserveInstall(await api.readMkserveInstall());
    expect(JSON.parse(await readFile(marker, 'utf8')).bundle).toBe(api.MKSERVE_BUNDLE);
    await expect(access(previousPaths.work)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(previousPaths.weights)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(unrelated.work)).resolves.toBeUndefined();
    await expect(access(unrelated.weights)).resolves.toBeUndefined();
  });

  it('keeps the shared checkpoint when only the runtime bundle changes', async () => {
    await api.activateMkserveInstall();
    const marker = join(root, 'data', 'cache', 'mkserve', 'installed.json');
    const active = JSON.parse(await readFile(marker, 'utf8'));
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
