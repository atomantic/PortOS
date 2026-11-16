/**
 * Where a native-Win32 PortOS should put Linux-side work, and what that directory is called from Windows.
 *
 * Docker Desktop's engine IS a WSL2 VM that reads Windows paths over a slow 9p share, so a multi-tens-of-GB model checkout on `C:\\` is slow in a way invisible until the download is spent; the documented layout is the distro's own filesystem, reached as `\\\\wsl.localhost\\<distro>\\home\\<user>` (Node can stat it, `CreateProcess` accepts it as a cwd). Every value of that template is answerable by the machine, so this module answers it rather than making the operator.
 *
 * **The probe runs the distro's own shell, not `wsl --list`:** `wsl.exe`'s own UI output is UTF-16LE (mangled by UTF-8 readers) while the stdout of a program it EXECUTES passes through byte for byte, so
 * `wsl.exe -e sh -c 'echo …'` returns plain UTF-8 with `WSL_DISTRO_NAME` and `HOME`, the pair the UNC path needs. UTF-16 is read only on the failure path, to decorate an error.
 * Nothing here decides anything: it reports what WSL says; the caller (`services/vllmQwenManager.js`) decides.
 */

import { bufferedSpawn } from './bufferedSpawn.js';
import { pathExists } from './fileCore.js';

/** The Windows-visible root of every WSL distro's filesystem. */
export const WSL_UNC_PREFIX = '\\\\wsl.localhost\\';

/** A probe must answer in seconds or not at all: a not-yet-running distro is started by the call (the slow case), and an unresponsive one must not hold a setup click open. */
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Distros that exist to run somebody's container engine, not hold user files (Docker Desktop's pair is recreated on reset and its data volume isn't a filesystem to clone into; others copy the design). */
const INTERNAL_DISTRO_RE = /^(docker-desktop(-data)?|rancher-desktop(-data)?|podman-machine.*)$/i;

const isInternalWslDistro = (name) => INTERNAL_DISTRO_RE.test(String(name || '').trim());

/** Ask the DEFAULT distro its name and home. `-e` execs without a login shell so a noisy `.bashrc` can't prepend a banner to the two lines parsed. */
const WSL_PROBE_ARGS = Object.freeze(['-e', 'sh', '-c', 'echo "$WSL_DISTRO_NAME"; echo "$HOME"']);

/**
 * The two lines `WSL_PROBE_ARGS` prints, or `null` when the output is not that. An empty or relative `HOME` is unusable and reads as a failure rather than deriving a path at the distro root.
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
 * `wsl.exe --list --quiet`, decoded. The UTF-16LE output arrives already coerced through UTF-8, so for the ASCII of real distro names each character is followed by a NUL and dropping NULs recovers it.
 * Used ONLY to name alternatives in an error message (a mangled name costs a vaguer sentence, never a wrong placement).
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
 * Run `wsl.exe`, never throwing. `launched` separates "WSL is not on this machine" (a feature to install) from "WSL answered and said no" (a configuration to change), which would otherwise send users to the wrong fix.
 *
 * @param {string[]} args
 * @returns {Promise<{launched: boolean, ok: boolean, stdout: string, error: string}>}
 */
async function runWsl(args) {
  const result = await bufferedSpawn('wsl.exe', args, { timeoutMs: PROBE_TIMEOUT_MS, shell: false });
  return {
    launched: !result.error,
    ok: result.success,
    stdout: result.stdout || '',
    error: String(result.error?.message || result.stderr || '').replace(/\0/g, '').trim(),
  };
}

async function listUserDistros(run) {
  return parseWslDistroList((await run(['--list', '--quiet'])).stdout);
}

/**
 * Find the WSL2 home directory a Windows PortOS should place `leaf` in. Verifies the derived UNC path is actually readable (WSL being installed and its `\\\\wsl.localhost` share answering are separate facts,
 * and a path only the container can see repeats the 9p mistake).
 *
 * @param {string} leaf - the directory name to place inside the distro's home
 * @param {{run?: (args: string[]) => Promise<{launched: boolean, ok: boolean, stdout: string, error: string}>,
 *   exists?: (path: string) => Promise<boolean>}} [deps]
 * @returns {Promise<{dir: string|null, distro?: string, home?: string, reason?: string, error?: string,
 *   distros?: string[]}>} `dir` is the answer; `reason` names which question failed (`no-wsl` | `no-distro` | `internal-distro` | `unreadable-share`).
 */
export async function detectWslProjectDir(leaf, { run = runWsl, exists = pathExists } = {}) {
  const probe = await run(WSL_PROBE_ARGS);
  if (!probe.launched) return { dir: null, reason: 'no-wsl', error: probe.error };

  const parsed = probe.ok ? parseWslProbe(probe.stdout) : null;
  if (!parsed) return { dir: null, reason: 'no-distro', error: probe.error, distros: await listUserDistros(run) };

  if (isInternalWslDistro(parsed.distro)) {
    // A container engine's own distro answered because it is the default; its filesystem is disposable, so refuse even though WSL works.
    return { dir: null, reason: 'internal-distro', distro: parsed.distro, distros: await listUserDistros(run) };
  }

  const homeUnc = wslUncPath(parsed.distro, parsed.home);
  if (!(await exists(homeUnc))) return { dir: null, reason: 'unreadable-share', distro: parsed.distro, home: homeUnc };

  return { dir: `${homeUnc}\\${leaf}`, distro: parsed.distro, home: homeUnc };
}
