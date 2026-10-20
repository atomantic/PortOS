/**
 * Containment contract for the autofixer's verify command (#12487).
 *
 * The verify command (`npm test`, …) runs over a worktree a crash-log-driven
 * agent just edited, so a test file or `pretest` script it wrote executes
 * here. A test runner forks, so the single-process Code Animation profile
 * (`codeAnimationContainment.js`) cannot host it; this profile keeps the same
 * Linux bubblewrap mechanism, with refusal elsewhere, and these bounds:
 *   - no network, including loopback and pathname Unix sockets (PortOS's API,
 *     a Docker or database socket): a network namespace plus a seccomp filter
 *     refusing AF_UNIX sockets and io_uring;
 *   - writes only to the worktree and a private scratch home/tmp;
 *   - no reads of the PortOS data directory (providers, settings, keys) or the
 *     host user's credential stores; the rest of the host stays readable so
 *     toolchains resolve;
 *   - a PID namespace so detached descendants cannot survive their supervisor;
 *   - an environment built from nothing — no provider key or PortOS token.
 *
 * Pure: no filesystem, process or settings access. Paths must be realpaths.
 */
import { join, posix } from 'node:path';
import { encodeSeccompProgram } from './codeAnimationContainment.js';

/** Host-user credential stores, relative to the real home directory. */
export const AUTOFIX_VERIFY_PROTECTED_HOME_PATHS = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', '.portos', '.claude', '.claude.json', '.codex',
  '.netrc', '.npmrc', '.git-credentials', '.config/gh', '.config/gcloud', '.config/git/credentials',
  'Library/Keychains',
]);

/**
 * Read-protected paths for one run: the PortOS data directory plus the host
 * user's credential stores. The worktree is re-allowed by the profile even
 * when it sits under the data directory.
 */
export function autofixVerifyProtectedPaths({ dataDir, realHome }) {
  return [dataDir, ...AUTOFIX_VERIFY_PROTECTED_HOME_PATHS.map((rel) => join(realHome, rel))].filter(Boolean);
}

/** The verify command's complete environment; `path` is the host PATH. */
export function autofixVerifyEnv({ scratch, path }) {
  const home = posix.join(scratch, 'home');
  const tmp = posix.join(scratch, 'tmp');
  return {
    PATH: path || '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', USER: 'worker', LOGNAME: 'worker',
    XDG_CONFIG_HOME: posix.join(home, 'config'), XDG_CACHE_HOME: posix.join(home, 'cache'), XDG_DATA_HOME: posix.join(home, 'data'),
    CI: '1',
  };
}

/**
 * Linux seccomp program for the verify command: `socket(AF_UNIX, …)` fails
 * with EPERM, so a host pathname socket visible through the read-only root
 * cannot be connected to. io_uring is refused too: its socket operations bypass
 * the socket syscall. Only stream `socketpair` (child-process stdio) is allowed:
 * datagram endpoints can reconnect/send to a host pathname socket.
 * Unknown ABIs (including x32) are killed rather than bypassing the check.
 */
export function autofixVerifySeccompFilter(arch) {
  const abi = { x64: { audit: 0xc000003e, socket: 41, socketpair: 53 }, arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199 } }[arch];
  if (!abi) throw new Error('Autofix verify seccomp supports only x64 and arm64.');
  const ALLOW = 0x7fff0000, KILL = 0x80000000, EPERM = 0x00050001, AF_UNIX = 1;
  return encodeSeccompProgram([
    [0x20, 0, 0, 4],                    // seccomp_data.arch
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, KILL],
    [0x20, 0, 0, 0],                    // seccomp_data.nr
    [0x35, 0, 1, 0x40000000],           // x32/invalid syscall range
    [0x06, 0, 0, KILL],
    ...[425, 426, 427].flatMap(nr => [  // io_uring_setup/enter/register, both ABIs
      [0x15, 0, 1, nr],
      [0x06, 0, 0, EPERM],
    ]),
    [0x15, 0, 5, abi.socketpair],
    [0x20, 0, 0, 24],                  // socketpair type, args[1] low word
    [0x54, 0, 0, 0xf],                 // strip SOCK_CLOEXEC/SOCK_NONBLOCK
    [0x15, 1, 0, 1],                   // SOCK_STREAM only
    [0x06, 0, 0, EPERM],
    [0x06, 0, 0, ALLOW],
    [0x15, 0, 3, abi.socket],
    [0x20, 0, 0, 16],                   // socket domain, args[0] low word
    [0x15, 0, 1, AF_UNIX],
    [0x06, 0, 0, EPERM],
    [0x06, 0, 0, ALLOW],
  ]);
}

/**
 * bubblewrap argv up to the command; the caller writes
 * `autofixVerifySeccompFilter` to fd 3. `protectedDirs` / `protectedFiles` must
 * exist (bwrap mounts over them): directories become empty tmpfs, files
 * become /dev/null. The worktree and scratch are bound writable last.
 */
export function autofixVerifyBubblewrapArgs({ worktree, scratch, env, protectedDirs = [], protectedFiles = [] }) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv', '--seccomp', '3',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run',
  ];
  for (const dir of protectedDirs) args.push('--tmpfs', dir);
  for (const file of protectedFiles) args.push('--ro-bind', '/dev/null', file);
  args.push('--bind', scratch, scratch, '--bind', worktree, worktree);
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  args.push('--chdir', worktree, '--');
  return args;
}
