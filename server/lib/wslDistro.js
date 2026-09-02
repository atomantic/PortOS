/**
 * Where a native-Win32 PortOS should put Linux-side work, and what that
 * directory is called from Windows.
 *
 * Docker Desktop's engine IS a WSL2 VM. Anything the engine reads out of a
 * Windows path is reached from inside that VM over a 9p share, so a
 * multi-tens-of-gigabytes model checkout placed on `C:\` is slow in a way that
 * is invisible until it has already cost the download. The documented layout is
 * the distro's own filesystem, reached from Windows as
 * `\\wsl.localhost\<distro>\home\<user>` — a path Node can stat and
 * `CreateProcess` accepts as a working directory.
 *
 * PortOS used to make the operator work that out: it refused, printed that UNC
 * shape with `<distro>` and `<user>` left as literal angle brackets, and told
 * them to set an environment variable and click again. Every value in that
 * template is something the machine can answer, so this module answers it.
 *
 * **The probe runs the distro's own shell, not `wsl --list`.** `wsl.exe`'s own
 * UI output is UTF-16LE, which any UTF-8 reader mangles; the stdout of a program
 * it EXECUTES is passed through byte for byte, so `wsl.exe -e sh -c 'echo …'`
 * comes back as plain UTF-8. `WSL_DISTRO_NAME` and `HOME` are both set inside
 * the distro, which is exactly the pair the UNC path needs. The UTF-16 read is
 * confined to the failure path, where the distro list only decorates an error
 * message.
 *
 * Nothing here decides anything: it reports what WSL says, and the caller
 * decides whether to act on it (`services/vllmQwenManager.js`).
 */

import { bufferedSpawn } from './bufferedSpawn.js';
import { pathExists } from './fileCore.js';

/** The Windows-visible root of every WSL distro's filesystem. */
export const WSL_UNC_PREFIX = '\\\\wsl.localhost\\';

/**
 * A probe that must answer in seconds or not at all. A distro that is not yet
 * running is started by this call, which is the slow case; an unresponsive one
 * must not hold a setup click open forever.
 */
const PROBE_TIMEOUT_MS = 60 * 1000;

/**
 * Distros that exist to run somebody's container engine, not to hold a user's
 * files. Docker Desktop's pair is recreated from scratch on a reset and its
 * data volume is not a filesystem to clone into; the others are the same shape
 * from the engines that copied the design.
 */
const INTERNAL_DISTRO_RE = /^(docker-desktop(-data)?|rancher-desktop(-data)?|podman-machine.*)$/i;

/** Whether a distro name belongs to a container engine rather than to the user. */
const isInternalWslDistro = (name) => INTERNAL_DISTRO_RE.test(String(name || '').trim());

/**
 * Ask the DEFAULT distro what it is called and where its home is. `-e` execs
 * without a login shell, so a noisy `.bashrc` cannot prepend a banner to the
 * two lines this parses.
 */
const WSL_PROBE_ARGS = Object.freeze(['-e', 'sh', '-c', 'echo "$WSL_DISTRO_NAME"; echo "$HOME"']);

/**
 * The two lines `WSL_PROBE_ARGS` prints, or `null` when the output is not that.
 *
 * A distro answering with an empty or relative `HOME` is not usable, and reads
 * as a failure here rather than deriving a path at the root of somebody's
 * distro.
 *
 * @param {string} stdout
 * @returns {{distro: string, home: string}|null}
 */
export function parseWslProbe(stdout) {
  const [distro = '', home = ''] = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!distro || !home.startsWith('/')) return null;
  return { distro, home };
}

/**
 * `wsl.exe --list --quiet`, decoded.
 *
 * Its output is UTF-16LE, and the buffer arrives here already coerced through
 * UTF-8 by the spawn helper — for the ASCII a distro name is in practice, that
 * leaves each character followed by a NUL, so dropping NULs recovers the name.
 * Used ONLY to name the alternatives in an error message; a name this mangles
 * costs a less specific sentence, never a wrong placement.
 *
 * @param {string} stdout
 * @returns {string[]} user distros, engine plumbing removed
 */
export function parseWslDistroList(stdout) {
  return String(stdout || '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && !isInternalWslDistro(name));
}

/**
 * The Windows path for a POSIX path inside one distro.
 *
 * @param {string} distro
 * @param {string} posixPath - absolute, e.g. `/home/alice`
 * @returns {string} e.g. `\\wsl.localhost\Ubuntu\home\alice`
 */
function wslUncPath(distro, posixPath) {
  const segments = String(posixPath || '').split('/').filter(Boolean);
  return [`${WSL_UNC_PREFIX}${distro}`, ...segments].join('\\');
}

/**
 * Run `wsl.exe`, never throwing.
 *
 * `launched` separates "WSL is not on this machine" from "WSL answered and said
 * no": the first is a feature the operator installs, the second is a
 * configuration they change, and collapsing the two would send half of each
 * group to the wrong fix.
 *
 * @param {string[]} args
 * @returns {Promise<{launched: boolean, ok: boolean, stdout: string, error: string}>}
 */
async function runWsl(args) {
  // `wsl.exe` spelled with its extension: under `shell: false` a bare name is
  // matched literally, and System32 is on PATH everywhere this can work.
  const result = await bufferedSpawn('wsl.exe', args, { timeoutMs: PROBE_TIMEOUT_MS, shell: false });
  return {
    launched: !result.error,
    ok: result.success,
    stdout: result.stdout || '',
    error: String(result.error?.message || result.stderr || '').replace(/\0/g, '').trim(),
  };
}

/** The distro names to offer in a failure, or `[]` when even that is unavailable. */
async function listUserDistros(run) {
  return parseWslDistroList((await run(['--list', '--quiet'])).stdout);
}

/**
 * Find the WSL2 home directory a Windows PortOS should place `leaf` in.
 *
 * Verifies the derived UNC path is actually readable before returning it: WSL
 * being installed and its `\\wsl.localhost` share answering are separate facts,
 * and a path only the container can see would send the caller back to the same
 * 9p mistake by a longer route.
 *
 * @param {string} leaf - the directory name to place inside the distro's home
 * @param {{run?: (args: string[]) => Promise<{launched: boolean, ok: boolean, stdout: string, error: string}>,
 *   exists?: (path: string) => Promise<boolean>}} [deps]
 * @returns {Promise<{dir: string|null, distro?: string, home?: string, reason?: string, error?: string,
 *   distros?: string[]}>} `dir` is the answer; `reason` names which question
 *   failed (`no-wsl` | `no-distro` | `internal-distro` | `unreadable-share`).
 */
export async function detectWslProjectDir(leaf, { run = runWsl, exists = pathExists } = {}) {
  const probe = await run(WSL_PROBE_ARGS);
  if (!probe.launched) return { dir: null, reason: 'no-wsl', error: probe.error };

  const parsed = probe.ok ? parseWslProbe(probe.stdout) : null;
  if (!parsed) return { dir: null, reason: 'no-distro', error: probe.error, distros: await listUserDistros(run) };

  if (isInternalWslDistro(parsed.distro)) {
    // A container engine's own distro answered because it is the default one.
    // Its filesystem is disposable, so this is a refusal even though WSL works.
    return { dir: null, reason: 'internal-distro', distro: parsed.distro, distros: await listUserDistros(run) };
  }

  const homeUnc = wslUncPath(parsed.distro, parsed.home);
  if (!(await exists(homeUnc))) return { dir: null, reason: 'unreadable-share', distro: parsed.distro, home: homeUnc };

  return { dir: `${homeUnc}\\${leaf}`, distro: parsed.distro, home: homeUnc };
}
