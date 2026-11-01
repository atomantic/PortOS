import { cp, copyFile, mkdtemp, readdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, ensureDir, rmGuarded } from '../../lib/fileUtils.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { assessDownloadPreflight, assertDownloadFits } from '../../lib/downloadPreflight.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { MOSS_MANIFEST, mossRuntimeRoot, mossRuntimeDirectory, mossHostProblem, mossChildEnv, probeMossBinary } from './mossRuntime.js';

// Rosetta makes `swift build` target x86_64. MLX needs the arm64 slice of the
// same toolchain; the image/video shell re-exec does not cover this installer.
// Leading underscore: the arch contract test is the only out-of-file caller.
export function _mossSwiftCommand(args, {
  platform = process.platform,
  arch = process.arch,
  appleSilicon = isAppleSilicon({ platform, arch }),
} = {}) {
  if (platform === 'darwin' && arch !== 'arm64' && appleSilicon) {
    return ['/usr/bin/arch', ['-arm64', 'swift', ...args]];
  }
  return ['swift', args];
}

let installing = false;

export function installMossRuntime(emit) {
  if (installing) throw new ServerError('A MOSS runtime install is already running.', { status: 409, code: 'MOSS_INSTALL_BUSY' });
  installing = true;
  let cancelled = false;
  const check = () => { if (cancelled) throw new Error('MOSS runtime installation cancelled.'); };
  const command = async (bin, args, cwd, capture = false) => {
    check();
    const lines = [];
    const result = await runStreamingCommand(bin, args, line => {
      if (capture) lines.push(line);
      else emit({ type: 'log', message: line });
    }, { cwd, timeoutMs: 30 * 60_000, env: mossChildEnv(), isCancelled: () => cancelled, processGroup: true });
    if (!result.success) throw new Error(`${bin}: ${result.error}`);
    check();
    return lines.join('\n');
  };
  const promise = (async () => {
    let staging;
    try {
      const problem = mossHostProblem();
      if (problem) throw new Error(problem);
      emit({ type: 'stage', stage: 'detect', message: 'Checking Swift 6.3+ and Apple Metal compiler.' });
      const version = await command('swift', ['--version'], undefined, true);
      const match = version.match(/Swift version (\d+)\.(\d+)/);
      if (!match || Number(match[1]) < 6 || (Number(match[1]) === 6 && Number(match[2]) < 3)) {
        throw new Error('MOSS requires Swift 6.3 or later. Select a compatible Xcode toolchain.');
      }
      await command('xcrun', ['metal', '--version']);
      await ensureDir(mossRuntimeRoot());
      assertDownloadFits(await assessDownloadPreflight({ destPath: mossRuntimeRoot(), expectedBytes: 10 * 1024 ** 3 }));
      staging = await mkdtemp(join(mossRuntimeRoot(), 'build-'));
      const source = join(staging, 'source');
      emit({ type: 'stage', stage: 'source', message: `Fetching reviewed MOSS Swift revision ${MOSS_MANIFEST.sourceRevision.slice(0, 12)} (MIT).` });
      await command('git', ['init', source]);
      await command('git', ['-C', source, 'fetch', '--depth', '1', MOSS_MANIFEST.sourceUrl, MOSS_MANIFEST.sourceRevision]);
      await command('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
      const head = await command('git', ['-C', source, 'rev-parse', 'HEAD'], undefined, true);
      if (head.trim() !== MOSS_MANIFEST.sourceRevision) throw new Error('MOSS source revision mismatch.');
      const lock = join(PATHS.root, 'scripts', 'moss-image', 'Package.resolved');
      await copyFile(lock, join(source, 'Package.resolved'));
      await copyFile(join(PATHS.root, 'scripts', 'moss_image.swift'), join(source, 'Sources', 'MossImageGate', 'main.swift'));
      emit({ type: 'stage', stage: 'build', message: 'Building pinned dependencies and the PortOS adapter. Weights download separately.' });
      const buildArgs = ['build', '-c', 'release', '--product', 'MossImageGate', '--jobs', '4', '--force-resolved-versions'];
      const [buildBin, buildCmd] = _mossSwiftCommand(buildArgs);
      await command(buildBin, buildCmd, source);
      if (await readFile(lock, 'utf8') !== await readFile(join(source, 'Package.resolved'), 'utf8')) throw new Error('Swift changed the reviewed dependency lock.');
      const [pathBin, pathCmd] = _mossSwiftCommand([...buildArgs, '--show-bin-path']);
      const binaryDir = (await command(pathBin, pathCmd, source, true)).trim();
      const output = join(staging, 'installed');
      await ensureDir(output);
      await copyFile(join(binaryDir, 'MossImageGate'), join(output, 'moss-image'));
      for (const name of await readdir(binaryDir)) {
        if (name.endsWith('.bundle')) await cp(join(binaryDir, name), join(output, name), { recursive: true });
      }
      await copyFile(join(source, 'LICENSE'), join(output, 'LICENSE'));
      await copyFile(lock, join(output, 'Package.resolved'));
      const checkouts = join(source, '.build', 'checkouts');
      for (const dependency of await readdir(checkouts)) {
        const directory = join(checkouts, dependency);
        const notices = (await readdir(directory)).filter(name => /^(license|licence|notice|copying)(\.|$)/i.test(name));
        if (!notices.length) throw new Error(`No license notice found for ${dependency}.`);
        const noticeDir = join(output, 'licenses', dependency);
        await ensureDir(noticeDir);
        for (const name of notices) await cp(join(directory, name), join(noticeDir, name), { recursive: true });
      }
      // Cmlx compiles vendored components that are not separate Swift checkouts.
      for (const notice of ['fmt/LICENSE', 'json/LICENSE.MIT', 'metal-cpp/LICENSE.txt', 'mlx-c/LICENSE', 'mlx/LICENSE']) {
        const destination = join(output, 'licenses', 'mlx-swift', 'Source', 'Cmlx', notice);
        await ensureDir(join(destination, '..'));
        await copyFile(join(checkouts, 'mlx-swift', 'Source', 'Cmlx', notice), destination);
      }
      emit({ type: 'stage', stage: 'verify', message: 'Testing the relocated executable and Metal resources.' });
      await probeMossBinary(join(output, 'moss-image'));
      check();
      // Preserve the prior runtime on a failed rebuild. Only a proven replacement is published.
      const previous = join(staging, 'previous');
      let moved = false;
      try { await rename(mossRuntimeDirectory(), previous); moved = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { check(); await rename(output, mossRuntimeDirectory()); }
      catch (error) { if (moved) await rename(previous, mossRuntimeDirectory()); throw error; }
      // Publication has succeeded; cleanup trouble must not report an installation failure.
      await rmGuarded(staging, { recursive: true, force: true }).catch(error => {
        emit({ type: 'log', message: `Runtime installed; temporary build cleanup failed: ${error.message}` });
      });
      emit({ type: 'complete', message: 'MOSS Swift runtime installed. Download the 27.2 GB SFT weights separately.' });
    } finally {
      // Failed source trees stay available for diagnosis; successful trees are reproducible from the shipped pins.
      installing = false;
    }
  })();
  return { promise, kill: () => { cancelled = true; } };
}
