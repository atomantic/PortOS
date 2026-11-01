import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ data: '', failBuild: false, holdBuild: null, buildEntered: null }));
vi.mock('../../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: new Proxy(actual.PATHS, { get: (target, key) => key === 'data' ? fixture.data : target[key] }) };
});
// The fixture compiler writes bytes, not a 10 GiB build; admission must not depend on CI disk size.
vi.mock('../../lib/downloadPreflight.js', async original => ({
  ...await original(), assessDownloadPreflight: vi.fn(async () => ({ verdict: 'ok' })),
}));
vi.mock('../../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('./mossRuntime.js', async original => ({ ...await original(), mossHostProblem: () => null, probeMossBinary: vi.fn() }));
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { MOSS_MANIFEST, mossRuntimeDirectory, probeMossBinary } from './mossRuntime.js';
import { installMossRuntime, mossSwiftCommand } from './mossInstall.js';

beforeEach(async () => {
  fixture.data = await mkdtemp(join(tmpdir(), 'portos-moss-install-'));
  fixture.failBuild = false;
  fixture.holdBuild = null;
  fixture.buildEntered = null;
  vi.clearAllMocks();
  probeMossBinary.mockImplementation(async binary => {
    expect(await readFile(join(binary, '..', 'mlx-swift_Cmlx.bundle', 'default.metallib'), 'utf8')).toBe('fixture-metal');
    return { metal: true };
  });
  runStreamingCommand.mockImplementation(async (bin, args, line, { cwd } = {}) => {
    const swiftArgs = bin === 'swift' ? args
      : (bin === '/usr/bin/arch' && args[0] === '-arm64' && args[1] === 'swift' ? args.slice(2) : null);
    if (bin === 'git' && args[0] === 'init') {
      await mkdir(join(args[1], 'Sources', 'MossImageGate'), { recursive: true });
      await writeFile(join(args[1], 'LICENSE'), 'fixture-source-license');
    }
    if (args.includes('rev-parse')) line(MOSS_MANIFEST.sourceRevision);
    if (swiftArgs?.includes('--version')) line('Swift version 6.4');
    if (swiftArgs?.[0] === 'build') {
      const products = join(cwd, '.build', 'release');
      if (swiftArgs.includes('--show-bin-path')) line(products);
      else {
        fixture.buildEntered?.();
        await fixture.holdBuild;
        if (fixture.failBuild) return { success: false, error: 'fixture compiler failure' };
        await mkdir(join(products, 'mlx-swift_Cmlx.bundle'), { recursive: true });
        await mkdir(join(cwd, '.build', 'checkouts', 'dependency'), { recursive: true });
        await writeFile(join(products, 'MossImageGate'), 'fixture-executable');
        await writeFile(join(products, 'mlx-swift_Cmlx.bundle', 'default.metallib'), 'fixture-metal');
        await writeFile(join(cwd, '.build', 'checkouts', 'dependency', 'LICENSE'), 'fixture-dependency-license');
        for (const notice of ['LICENSE', 'Source/Cmlx/fmt/LICENSE', 'Source/Cmlx/json/LICENSE.MIT', 'Source/Cmlx/metal-cpp/LICENSE.txt', 'Source/Cmlx/mlx-c/LICENSE', 'Source/Cmlx/mlx/LICENSE']) {
          const target = join(cwd, '.build', 'checkouts', 'mlx-swift', notice);
          await mkdir(join(target, '..'), { recursive: true });
          await writeFile(target, 'fixture-vendored-license');
        }
      }
    }
    return { success: true };
  });
});
afterEach(async () => { await rm(fixture.data, { recursive: true, force: true }); });

describe('MOSS Swift target', () => {
  it('builds arm64 when Node is translated on Apple Silicon', () => {
    expect(mossSwiftCommand(['build', '--show-bin-path'], { platform: 'darwin', arch: 'x64', appleSilicon: true }))
      .toEqual(['/usr/bin/arch', ['-arm64', 'swift', 'build', '--show-bin-path']]);
  });

  it('keeps the swift binary on native arm64 and on Intel', () => {
    expect(mossSwiftCommand(['build'], { platform: 'darwin', arch: 'arm64', appleSilicon: true })).toEqual(['swift', ['build']]);
    expect(mossSwiftCommand(['build'], { platform: 'darwin', arch: 'x64', appleSilicon: false })).toEqual(['swift', ['build']]);
    expect(mossSwiftCommand(['build'], { platform: 'linux', arch: 'x64', appleSilicon: false })).toEqual(['swift', ['build']]);
  });
});

describe('MOSS runtime installation publication', () => {
  it('publishes only the pinned build with relocated Metal resources and dependency notices', async () => {
    const events = [];
    await installMossRuntime(event => events.push(event)).promise;
    const directory = mossRuntimeDirectory();
    expect(await readFile(join(directory, 'moss-image'), 'utf8')).toBe('fixture-executable');
    expect(await readFile(join(directory, 'licenses', 'dependency', 'LICENSE'), 'utf8')).toBe('fixture-dependency-license');
    expect(runStreamingCommand).toHaveBeenCalledWith('git', expect.arrayContaining(['fetch', MOSS_MANIFEST.sourceUrl, MOSS_MANIFEST.sourceRevision]), expect.any(Function), expect.any(Object));
    const buildArgs = ['build', '-c', 'release', '--product', 'MossImageGate', '--jobs', '4', '--force-resolved-versions'];
    const [swiftBin, swiftArgs] = mossSwiftCommand(buildArgs);
    expect(runStreamingCommand).toHaveBeenCalledWith(swiftBin, swiftArgs, expect.any(Function), expect.any(Object));
    const [pathBin, pathArgs] = mossSwiftCommand([...buildArgs, '--show-bin-path']);
    expect(runStreamingCommand).toHaveBeenCalledWith(pathBin, pathArgs, expect.any(Function), expect.any(Object));
    expect(await readFile(join(directory, 'licenses', 'mlx-swift', 'Source', 'Cmlx', 'json', 'LICENSE.MIT'), 'utf8')).toBe('fixture-vendored-license');
    expect(probeMossBinary).toHaveBeenCalledTimes(1);
    expect(events.at(-1).type).toBe('complete');
    expect(runStreamingCommand.mock.calls.some(([bin]) => bin === 'python' || bin === 'pip')).toBe(false);
  });

  it('preserves an installed runtime after a failed rebuild and releases admission', async () => {
    await mkdir(mossRuntimeDirectory(), { recursive: true });
    await writeFile(join(mossRuntimeDirectory(), 'moss-image'), 'previous-runtime');
    fixture.failBuild = true;
    await expect(installMossRuntime(() => {}).promise).rejects.toThrow('fixture compiler failure');
    expect(await readFile(join(mossRuntimeDirectory(), 'moss-image'), 'utf8')).toBe('previous-runtime');
    expect(probeMossBinary).not.toHaveBeenCalled();
    fixture.failBuild = false;
    await installMossRuntime(() => {}).promise;
    expect(await readFile(join(mossRuntimeDirectory(), 'moss-image'), 'utf8')).toBe('fixture-executable');
  });

  it('holds one install slot and never publishes a cancelled build', async () => {
    let release;
    fixture.holdBuild = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { fixture.buildEntered = resolve; });
    const events = [];
    const handle = installMossRuntime(event => events.push(event));
    expect(() => installMossRuntime(() => {})).toThrow(/already running/);
    await entered;
    handle.kill();
    release();
    await expect(handle.promise).rejects.toThrow(/cancelled/);
    expect(events.some(event => event.type === 'complete')).toBe(false);
    expect(probeMossBinary).not.toHaveBeenCalled();
    await expect(readFile(join(mossRuntimeDirectory(), 'moss-image'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
