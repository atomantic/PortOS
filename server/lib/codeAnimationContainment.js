/**
 * Containment contract for Code Animation production workers (#9388).
 *
 * A job directory is not a boundary. Generated or imported package code runs
 * under an enforced OS mechanism by default; unavailable containment never
 * automatically falls back. An explicit operator-owned trusted-local Blender
 * mode is supervised but is not a security boundary. The supported mechanism
 * is macOS Seatbelt or Linux bubblewrap with a process-denying seccomp
 * filter. Windows and hosts missing the prerequisites refuse.
 *
 * Pure: no filesystem, process or settings access.
 */
import { basename, dirname, isAbsolute, join, normalize, parse, posix } from 'node:path';
import { z } from 'zod';

export const CODE_ANIMATION_SEATBELT = '/usr/bin/sandbox-exec';
export const CODE_ANIMATION_BUBBLEWRAP = '/usr/bin/bwrap';

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
    executionMode: z.enum(['contained', 'trusted-local']).default('contained'),
    engine: z.enum(['CYCLES', 'BLENDER_EEVEE_NEXT']).default('CYCLES'),
    acknowledgeHostAccess: z.boolean().default(false),
  }).strict().refine(value => value.executionMode !== 'trusted-local' || value.acknowledgeHostAccess,
    'Trusted-local Blender requires explicit acknowledgement of host filesystem, network and process access.'),
}).strict();

/**
 * The enforced mechanism for `platform`, or a refusal reason. `seatbeltAvailable`
 * is whether `/usr/bin/sandbox-exec` is executable on this host.
 */
export function codeAnimationContainmentMechanism(platform, seatbeltAvailable, bubblewrap = null) {
  if (platform === 'darwin') {
    return seatbeltAvailable
      ? { id: 'macos-seatbelt', supported: true, reason: null }
      : { id: null, supported: false, reason: 'macOS Seatbelt (/usr/bin/sandbox-exec) is unavailable on this host.' };
  }
  if (platform === 'linux') {
    return bubblewrap?.supported
      ? { id: 'linux-bubblewrap', supported: true, reason: null }
      : { id: null, supported: false, reason: bubblewrap?.reason || 'Linux containment unavailable: bubblewrap and unrestricted user namespaces are required.' };
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
  const home = posix.join(workspace, 'home');
  const tmp = posix.join(workspace, 'tmp');
  return {
    PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    // Fixed synthetic identity: Blender's glog startup otherwise queries the
    // host account database. This never inherits the operator's username.
    USER: 'worker', LOGNAME: 'worker',
    XDG_CONFIG_HOME: posix.join(home, 'config'), XDG_CACHE_HOME: posix.join(home, 'cache'), XDG_DATA_HOME: posix.join(home, 'data'),
    // Blender reads user add-ons/startup files from here; keep them private and empty.
    BLENDER_USER_RESOURCES: posix.join(home, 'blender'),
    // Do not load the host OpenSSL configuration, including in trusted-local mode.
    OPENSSL_CONF: '/dev/null',
    PORTOS_WORKER_INPUT: posix.join(workspace, 'input'),
    PORTOS_WORKER_OUTPUT: posix.join(workspace, 'output'),
  };
}

/**
 * Classic BPF seccomp program, using Linux UAPI syscall/audit constants.
 * Native threads remain possible; fork/vfork and non-thread clone are denied.
 * clone3 returns ENOSYS so libc can fall back to the inspectable clone flags.
 * Unknown ABIs (including x32) fail closed instead of bypassing syscall checks.
 * Applied by bwrap after its supervisor/namespace setup, before tool exec.
 */
export function codeAnimationSeccompFilter(arch) {
  const abi = {
    x64: { audit: 0xc000003e, clone: 56, denied: [57, 58, 41, 272, 308] },
    arm64: { audit: 0xc00000b7, clone: 220, denied: [198, 97, 268] },
  }[arch];
  if (!abi) throw new Error('Linux worker seccomp supports only x64 and arm64.');
  const ALLOW = 0x7fff0000, KILL = 0x80000000, EPERM = 0x00050001, ENOSYS = 0x00050026;
  const instructions = [
    [0x20, 0, 0, 4],                    // seccomp_data.arch
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, KILL],
    [0x20, 0, 0, 0],                    // seccomp_data.nr
    [0x35, 0, 1, 0x40000000],           // x32/invalid syscall range
    [0x06, 0, 0, KILL],
    [0x15, 0, 1, 435],                  // clone3
    [0x06, 0, 0, ENOSYS],
    ...abi.denied.flatMap((nr) => [[0x15, 0, 1, nr], [0x06, 0, 0, EPERM]]),
    [0x15, 1, 0, abi.clone],
    [0x06, 0, 0, ALLOW],
    [0x20, 0, 0, 16],                   // clone flags, args[0] low word
    [0x45, 0, 1, 0x7e020000],           // namespace creation flags
    [0x06, 0, 0, EPERM],
    [0x45, 1, 0, 0x00010000],           // CLONE_THREAD: true skips EPERM to ALLOW
    [0x06, 0, 0, EPERM],
    [0x06, 0, 0, ALLOW],
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(k, index * 8 + 4);
  });
  return bytes;
}

/** Empty filesystem with only installed code, staged inputs and owned writes. */
export function codeAnimationBubblewrapArgs({ executable, toolRoots, workspace, sandboxWorkspace = '/workspace', argv = [] }) {
  const args = [
    '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--clearenv', '--seccomp', '3', '--info-fd', '4',
    '--proc', '/proc', '--remount-ro', '/proc',
  ];
  // Never bind the host root, /etc, /run, /tmp or the user's home.
  for (const root of new Set(['/usr/lib', '/usr/lib64', '/usr/share', '/lib', '/lib64', ...toolRoots])) {
    args.push('--ro-bind-try', root, root);
  }
  for (const device of ['null', 'zero', 'random', 'urandom']) {
    args.push('--dev-bind', `/dev/${device}`, `/dev/${device}`);
  }
  args.push('--ro-bind', posix.join(workspace, 'input'), posix.join(sandboxWorkspace, 'input'));
  for (const name of ['output', 'tmp', 'home']) {
    args.push('--bind', posix.join(workspace, name), posix.join(sandboxWorkspace, name));
  }
  for (const [key, value] of Object.entries(codeAnimationWorkerEnv(sandboxWorkspace))) args.push('--setenv', key, value);
  // The synthetic root/ancestor directories must not become unmetered scratch.
  args.push('--remount-ro', '/', '--chdir', posix.join(sandboxWorkspace, 'tmp'), '--', executable, ...argv);
  return args;
}
