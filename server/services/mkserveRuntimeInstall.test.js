import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function seedPrevious() {
  const paths = api.mkserveInstallPaths(previous.bundle, previous.revision);
  await Promise.all([
    mkdir(dirname(paths.python), { recursive: true }),
    mkdir(join(paths.source, 'mkserve'), { recursive: true }),
    mkdir(paths.weights, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.python, 'synthetic test executable'),
    writeFile(join(paths.source, 'mkserve', '__main__.py'), 'main'),
    writeFile(join(paths.weights, 'weights'), 'abc'),
    writeFile(join(root, 'data', 'cache', 'mkserve', 'installed.json'), JSON.stringify(previous)),
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
    await expect(api.installPinnedMkserve(() => {})).rejects.toThrow('failed SHA-256 verification');
    expect(runStreamingCommand).toHaveBeenCalledTimes(1);
    await expect(api.readMkserveInstall()).resolves.toMatchObject(previousWithoutFiles());
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
