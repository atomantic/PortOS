/**
 * Containment contract for Code Animation production workers (#9388).
 *
 * A job directory is not a boundary. Generated or imported package code runs
 * only under an enforced OS mechanism; when none is available execution is
 * refused, never downgraded to an uncontained spawn. The supported mechanism
 * on this release is the macOS Seatbelt kernel sandbox (`sandbox-exec`), the
 * same one the private security assessment harness uses. Linux and Windows
 * report no mechanism and refuse.
 *
 * Pure: no filesystem, process or settings access.
 */
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { z } from 'zod';

export const CODE_ANIMATION_SEATBELT = '/usr/bin/sandbox-exec';

/** Upper bounds a caller may request; defaults suit one preview render. */
export const codeAnimationWorkerLimitsSchema = z.object({
  wallSeconds: z.number().int().min(1).max(86400).default(300),
  // Every byte the worker can write: output, scratch and its private home.
  diskBytes: z.number().int().min(1024).max(1_000_000_000_000).default(512 * 1024 * 1024),
  maxFiles: z.number().int().min(1).max(200_000).default(20_000),
  memoryBytes: z.number().int().min(16 * 1024 * 1024).max(1024 * 1024 * 1024 * 1024).default(8 * 1024 * 1024 * 1024),
  openFiles: z.number().int().min(64).max(65536).default(1024),
}).strict();

/**
 * Operator-owned installed tools, kept in the machine-local settings slice
 * `codeAnimationExecution`. Packages never name an executable, install
 * command or mount; only this operator-gated configuration does.
 */
export const codeAnimationExecutionToolsSchema = z.object({
  blender: z.object({
    executable: z.string().trim().max(4096).nullable(),
  }).strict(),
}).strict();

/**
 * The enforced mechanism for `platform`, or a refusal reason. `seatbeltAvailable`
 * is whether `/usr/bin/sandbox-exec` is executable on this host.
 */
export function codeAnimationContainmentMechanism(platform, seatbeltAvailable) {
  if (platform === 'darwin') {
    return seatbeltAvailable
      ? { id: 'macos-seatbelt', supported: true, reason: null }
      : { id: null, supported: false, reason: 'macOS Seatbelt (/usr/bin/sandbox-exec) is unavailable on this host.' };
  }
  return {
    id: null, supported: false,
    reason: `No enforced worker containment is implemented for ${platform}. Production code execution is refused; package import/export and the browser preview sandbox remain available.`,
  };
}

// SBPL string literals: refuse anything that could close the literal or the form.
const sbplPath = (path) => {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || /["\\()\0\r\n]/.test(path)) {
    throw new Error('Containment paths must be normalized absolute paths without quote, backslash or parenthesis characters');
  }
  return JSON.stringify(path);
};

const ancestors = (path) => {
  const out = [];
  for (let current = dirname(path); current !== parse(current).root; current = dirname(current)) out.push(current);
  return out;
};

/**
 * The installed tool's read-only roots. A macOS app bundle is read as a whole
 * (frameworks, Python and data files live inside it). A binary in a prefix's
 * `bin/` reads that prefix's code directories, never the whole prefix (where
 * `var/` or `etc/` may hold other programs' data); any other binary reads
 * only its own directory.
 */
export function codeAnimationToolRoots(executable) {
  const marker = executable.lastIndexOf('.app/Contents/MacOS/');
  if (marker > 0) return [executable.slice(0, marker + 4)];
  const dir = dirname(executable);
  if (basename(dir) !== 'bin' || dirname(dir) === parse(dir).root) return [dir];
  return ['bin', 'lib', 'libexec', 'share', 'Frameworks'].map((name) => join(dirname(dir), name));
}

// System libraries plus Homebrew's installed-package code (a Homebrew binary
// links its sibling formulae through opt/). Homebrew's var/ and etc/, which
// hold other programs' data, are not included.
const SYSTEM_READ_ROOTS = [
  '/System', '/usr/lib', '/usr/share', '/private/var/db/dyld', '/private/var/db/timezone',
  '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/usr/local/Cellar', '/usr/local/opt',
];

/**
 * Deny-by-default Seatbelt profile for one worker. All paths must already be
 * realpaths. Grants:
 *   - exec of exactly the operator-configured executable; fork is denied, so
 *     the worker is one process that cannot start a shell, installer or helper;
 *   - read of system and Homebrew package libraries, the tool's install roots
 *     and the staged input;
 *   - read/write of the workspace's output, scratch and private home only;
 *   - metadata (stat, not listing or content) of the ancestors of those roots,
 *     which path resolution needs.
 * Everything else is denied: network (including loopback and Unix sockets, so
 * PortOS's own API is unreachable), Mach/XPC services (keychain, pasteboard,
 * launchd), IPC, other files, device files beyond the null/random devices.
 */
export function codeAnimationSeatbeltProfile({ executable, toolRoots, workspace }) {
  const staged = join(workspace, 'input');
  const writable = ['output', 'tmp', 'home'].map((name) => join(workspace, name));
  const readRoots = [...SYSTEM_READ_ROOTS, ...toolRoots, staged, ...writable];
  const metadata = [...new Set([...readRoots, executable].flatMap(ancestors))];
  return `(version 1)
(deny default)
(allow process-exec (literal ${sbplPath(executable)}))
(allow sysctl-read)
(allow file-read-metadata (literal "/") ${metadata.map((path) => `(literal ${sbplPath(path)})`).join(' ')})
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom")
  ${readRoots.map((path) => `(subpath ${sbplPath(path)})`).join(' ')})
(allow file-write* (literal "/dev/null") ${writable.map((path) => `(subpath ${sbplPath(path)})`).join(' ')})`;
}

/**
 * The worker's complete environment. Built from nothing — never a copy of the
 * server's — so no PortOS token, provider key, cloud credential or proxy
 * setting can be inherited.
 */
export function codeAnimationWorkerEnv(workspace) {
  const home = join(workspace, 'home');
  const tmp = join(workspace, 'tmp');
  return {
    PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    // Blender reads user add-ons/startup files from here; keep them private and empty.
    BLENDER_USER_RESOURCES: join(home, 'blender'),
    // Workers have no network; an OpenSSL build's config outside the sandbox is not needed.
    OPENSSL_CONF: '/dev/null',
    PORTOS_WORKER_INPUT: join(workspace, 'input'),
    PORTOS_WORKER_OUTPUT: join(workspace, 'output'),
  };
}
