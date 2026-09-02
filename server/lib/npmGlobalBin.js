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

import { existsSync } from 'fs';
import { join } from 'path';
import { bufferedSpawn, prepareCliSpawn } from './bufferedSpawn.js';
import { adoptPathDirs, safeChildProcessEnv } from './processEnv.js';

const IS_WIN = process.platform === 'win32';

// `npm prefix -g` reads config files and can pay a cold Node start, so it gets
// more room than the 5s PATH probes — but it must never hang a status refresh.
const PREFIX_TIMEOUT_MS = 15_000;

// npm's answer, held as a promise so concurrent callers share one spawn: a host
// does not change its global prefix underneath a running server.
let binDirProbe = null;

/** One `npm prefix -g`, mapped to the platform's global bin directory. */
async function probeNpmGlobalBinDir(spawnImpl) {
  const env = safeChildProcessEnv();
  // `shell: false` + `prepareCliSpawn`, not `bufferedSpawn`'s `needsShell('npm')`
  // default: that default is `shell: true` with an args array, which node
  // space-joins WITHOUT escaping (DEP0190). The argv here is fixed, but the
  // warning would print at every boot in both processes.
  const { command, args } = prepareCliSpawn('npm', ['prefix', '-g'], env);
  const { stdout } = await spawnImpl(command, args, { env, shell: false, timeoutMs: PREFIX_TIMEOUT_MS });
  const prefix = String(stdout || '').trim().split(/\r?\n/)[0]?.trim() || '';
  // Windows drops binaries straight in the prefix; POSIX uses `<prefix>/bin`.
  return prefix ? (IS_WIN ? prefix : join(prefix, 'bin')) : null;
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
