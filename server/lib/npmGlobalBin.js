/**
 * Where `npm install --global` actually writes its executables.
 *
 * The AI Providers page installs a CLI with a fixed `npm install --global` and
 * then asks whether PortOS can run it. Those two questions have different
 * answers on any host whose npm prefix is not the directory the platform's Node
 * installer put on PATH: a machine-wide Windows prefix while PATH still carries
 * the per-user `%APPDATA%\npm` default, an `NPM_CONFIG_PREFIX` an admin set, an
 * nvm/Volta switch, a `prefix=` in a user or global npmrc. The install writes a
 * perfectly good `codex.cmd` and nothing on PATH names the directory holding
 * it — so the card reported "the installer finished, but PortOS still cannot
 * run `codex`" and advised a restart, which cannot fix a directory the machine
 * PATH has never contained.
 *
 * npm resolves its prefix through a config cascade (cli flags, `npm_config_*`
 * env, project/user/global npmrc, and a builtin npmrc that itself interpolates
 * env vars), so re-deriving it from `%APPDATA%`/`$HOME` guesses would just
 * reproduce the same class of bug on the next host. The only correct answer is
 * npm's own, hence one cached `npm prefix -g`.
 *
 * `adoptPathDirs` does the rest; see its docstring in `processEnv.js` for why
 * extending `process.env.PATH` is what a bare-name node-pty launch needs.
 */

import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { bufferedSpawn, prepareCliSpawn, resolveCmdShimLaunch } from './bufferedSpawn.js';
import { adoptPathDirs, findCommandOnPath, safeChildProcessEnv } from './processEnv.js';

const IS_WIN = process.platform === 'win32';

const samePath = (a, b, isWindows) => isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, file) => {
  const rel = relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs];
const safeRelative = value => typeof value === 'string' && value.length > 0
  && !isAbsolute(value) && !/[\\:]/.test(value) && !value.split('/').includes('..');

function optionalLstat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function windowsShimMatches(file, suffix, prefix, target, env) {
  if (suffix === '.cmd') {
    const shim = resolveCmdShimLaunch(file, env);
    const shimTarget = shim?.args[0] || shim?.command;
    return Boolean(shimTarget) && samePath(realpathSync(shimTarget), target, true);
  }
  const source = readFileSync(file, 'utf8');
  const powershell = suffix === '.ps1';
  if (!source.startsWith(powershell ? '#!/usr/bin/env pwsh' : '#!/bin/sh')) return false;
  const lines = source.split(/\r?\n/).filter(line => powershell
    ? /(?:^|\s)&\s/.test(line) && /\$args\s*$/.test(line)
    : /^\s*exec\s/.test(line) && /"\$@"\s*$/.test(line));
  return lines.length > 0 && lines.every(line => {
    const paths = [...line.matchAll(/"\$basedir\/([^\"]+)"/g)];
    const candidate = paths.at(-1)?.[1];
    return candidate && samePath(realpathSync(resolve(prefix, candidate)), target, true);
  });
}

function verifyArtifact(file, target, { isWindows, suffix, prefix, env }, artifacts) {
  const stat = optionalLstat(file);
  if (stat) {
    const matches = isWindows
      ? stat.isFile() && windowsShimMatches(file, suffix, prefix, target, env)
      : stat.isSymbolicLink() && samePath(realpathSync(file), target, false);
    if (!matches) return false;
  }
  artifacts.push({ file, stat: stat ? fingerprint(stat) : null });
  return true;
}

/**
 * Identify an npm-compatible global package supplying the selected command.
 * This verifies layout and the package's declared bin; it does not claim to
 * know which tool originally installed it. Return private, recheckable proof.
 */
export function inspectNpmGlobalCommand(command, packageName, {
  env = process.env, findCommand = findCommandOnPath, isWindows = IS_WIN,
} = {}) {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(packageName || '') || !/^[\w.-]+$/.test(command || '')) return null;
  try {
    const found = findCommand(command, { env });
    if (!found) return null;
    const binDir = realpathSync(dirname(found));
    const executable = join(binDir, basename(found));
    if (!isWindows && basename(binDir) !== 'bin') return null;
    if (isWindows && basename(executable).toLowerCase() !== `${command.toLowerCase()}.cmd`) return null;
    const prefix = isWindows ? binDir : dirname(binDir);
    if (/[\r\n]/.test(prefix)) return null;
    const packageDir = join(prefix, ...(isWindows ? [] : ['lib']), 'node_modules', ...packageName.split('/'));
    // A linked package can be managed outside this prefix. Do not delete it.
    if (!samePath(realpathSync(packageDir), packageDir, isWindows)) return null;
    const manifestPath = join(packageDir, 'package.json');
    if (!samePath(realpathSync(manifestPath), manifestPath, isWindows)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== packageName || manifest.directories?.bin || manifest.directories?.man) return null;
    const bins = typeof manifest.bin === 'string'
      ? { [packageName.split('/').at(-1)]: manifest.bin }
      : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? manifest.bin : null;
    if (!bins || !Object.hasOwn(bins, command)) return null;
    const artifacts = [];
    const targets = [];
    for (const [name, bin] of Object.entries(bins).sort(([a], [b]) => a.localeCompare(b))) {
      // npm normalizes unusual keys and paths; refuse them rather than miss a
      // link npm would also remove after normalization.
      if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..' || !safeRelative(bin)) return null;
      const declared = resolve(packageDir, bin);
      if (!inside(packageDir, declared)) return null;
      const target = realpathSync(declared);
      if (!inside(packageDir, target) || !statSync(target).isFile()) return null;
      targets.push({ target, stat: fingerprint(statSync(target)) });
      for (const suffix of isWindows ? ['', '.cmd', '.ps1'] : ['']) {
        if (!verifyArtifact(join(binDir, `${name}${suffix}`), target, { isWindows, suffix, prefix, env }, artifacts)) return null;
      }
    }
    if (!artifacts.some(item => samePath(item.file, executable, isWindows) && item.stat)) return null;
    if (!isWindows && manifest.man) {
      const mans = Array.isArray(manifest.man) ? manifest.man : [manifest.man];
      for (const man of mans) {
        const section = typeof man === 'string' ? man.match(/\.([0-9]+)(?:\.gz)?$/)?.[1] : null;
        if (!section || !safeRelative(man)) return null;
        const declared = resolve(packageDir, man);
        if (!inside(packageDir, declared)) return null;
        const target = realpathSync(declared);
        if (!inside(packageDir, target) || !statSync(target).isFile()) return null;
        const link = join(prefix, 'share', 'man', `man${section}`, basename(man));
        if (!verifyArtifact(link, target, { isWindows: false }, artifacts)) return null;
        targets.push({ target, stat: fingerprint(statSync(target)) });
      }
    }
    return {
      prefix, executable, packageDir, artifacts, targets,
      manifestStat: fingerprint(statSync(manifestPath)),
    };
  } catch {
    return null;
  }
}

// `npm prefix -g` reads config files and can pay a cold Node start, so it gets
// more room than the 5s PATH probes — but it must never hang a status refresh.
const PREFIX_TIMEOUT_MS = 15_000;

// npm's answer, held as a promise so concurrent callers share one spawn: a host
// does not change its global prefix underneath a running server.
let binDirProbe = null;

/** One `npm prefix -g`, mapped to the platform's global bin directory. */
async function probeNpmGlobalBinDir(spawnImpl) {
  // npm is itself a large Node CLI that writes its OWN module compile cache
  // under `TMPDIR`/`node-compile-cache` on every invocation (same class of
  // problem `commandExists.js`'s `probe()` isolates for `kilo`/`opencode` —
  // see its docstring, #9039). A throwaway scratch dir scoped to THIS one
  // spawn keeps that cache out of the caller's real `TMPDIR` (and, under
  // PortOS's own run-scoped vitest temp root, out of the leak report).
  const scratchDir = mkdtempSync(join(tmpdir(), 'portos-cli-probe-'));
  const env = { ...safeChildProcessEnv(), TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir };
  try {
    // `shell: false` + `prepareCliSpawn`, not `bufferedSpawn`'s `needsShell('npm')`
    // default: that default is `shell: true` with an args array, which node
    // space-joins WITHOUT escaping (DEP0190). The argv here is fixed, but the
    // warning would print at every boot in both processes.
    const { command, args } = prepareCliSpawn('npm', ['prefix', '-g'], env);
    const { stdout } = await spawnImpl(command, args, { env, shell: false, timeoutMs: PREFIX_TIMEOUT_MS });
    const prefix = String(stdout || '').trim().split(/\r?\n/)[0]?.trim() || '';
    // Windows drops binaries straight in the prefix; POSIX uses `<prefix>/bin`.
    return prefix ? (IS_WIN ? prefix : join(prefix, 'bin')) : null;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort — a lingering handle on a still-terminating npm must not
      // throw out of a probe that already has its answer.
    }
  }
}

/**
 * Put npm's global bin directory on this process's PATH, so a CLI installed
 * there is both discoverable and launchable by bare name. Idempotent, and a
 * no-op when npm cannot be asked or the directory is not there yet.
 *
 * The existence check is deliberately NOT cached with npm's answer: the prefix
 * directory does not exist until the first global install, and making that
 * install visible without a restart is the whole point.
 *
 * @param {{spawnImpl?: Function}} [deps]
 * @returns {Promise<string|null>} the directory now on PATH, or `null`
 */
export async function adoptNpmGlobalBinDir({ spawnImpl = bufferedSpawn } = {}) {
  // A probe that cannot answer resolves null rather than rejecting: an
  // unreachable npm means "PortOS keeps the PATH it has", not a failed caller.
  binDirProbe = binDirProbe || probeNpmGlobalBinDir(spawnImpl).catch(() => null);
  const dir = await binDirProbe;
  if (!dir || !existsSync(dir)) return null;
  const [adopted] = adoptPathDirs([dir]);
  if (adopted) console.log(`🔗 Adopted npm global bin directory onto PortOS's PATH: ${adopted}`);
  return dir;
}

/** Test-only: forget npm's answer so the next read re-probes. */
export function __resetNpmGlobalBinCache() {
  binDirProbe = null;
}
