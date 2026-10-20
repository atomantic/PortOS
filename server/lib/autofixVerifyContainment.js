/**
 * Containment contract for the autofixer's verify command (#12487).
 *
 * The verify command (`npm test`, …) runs over a worktree a crash-log-driven
 * agent just edited, so a test file or `pretest` script it wrote executes
 * here. A test runner forks, so the single-process Code Animation profile
 * (`codeAnimationContainment.js`) cannot host it; this profile keeps the same
 * mechanisms (macOS Seatbelt, Linux bubblewrap, refusal elsewhere) with these
 * bounds instead:
 *   - no network, including loopback and Unix sockets (PortOS's API);
 *   - writes only to the worktree and a private scratch home/tmp;
 *   - no reads of the PortOS data directory (providers, settings, keys) or the
 *     host user's credential stores; the rest of the host stays readable so
 *     toolchains resolve;
 *   - macOS: no Mach services beyond user/log lookups (no LaunchServices,
 *     keychain or pasteboard) and no signals outside the sandbox;
 *   - an environment built from nothing — no provider key or PortOS token.
 *
 * Pure: no filesystem, process or settings access. Paths must be realpaths.
 */
import { join, posix } from 'node:path';
import { seatbeltPathLiteral } from './codeAnimationContainment.js';

/** Host-user credential stores, relative to the real home directory. */
export const AUTOFIX_VERIFY_PROTECTED_HOME_PATHS = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.azure', '.portos', '.claude', '.claude.json', '.codex',
  '.netrc', '.npmrc', '.git-credentials', '.config/gh', '.config/gcloud', '.config/git/credentials',
  'Library/Keychains',
]);

// Mach services a test runner needs for user/group lookups and logging.
const SEATBELT_MACH_ALLOW = [
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.notification_center',
  'com.apple.system.logger', 'com.apple.logd', 'com.apple.diagnosticd', 'com.apple.FSEvents',
];

/**
 * Read-protected paths for one run: the PortOS data directory plus the host
 * user's credential stores. The worktree is re-allowed by each profile even
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

/** Seatbelt profile; later rules win, so the worktree re-allow follows the denials. */
export function autofixVerifySeatbeltProfile({ worktree, scratch, protectedPaths = [] }) {
  const lit = seatbeltPathLiteral;
  const denied = protectedPaths.map((path) => `(subpath ${lit(path)})`).join(' ');
  return `(version 1)
(allow default)
(deny network*)
(deny mach-lookup)
(allow mach-lookup ${SEATBELT_MACH_ALLOW.map((name) => `(global-name ${JSON.stringify(name)})`).join(' ')})
(deny signal)
(allow signal (target same-sandbox))
(deny file-write*)
(allow file-write* (literal "/dev/null") (subpath ${lit(worktree)}) (subpath ${lit(scratch)}))
${denied ? `(deny file-read* ${denied})\n` : ''}(allow file-read* (subpath ${lit(worktree)}) (subpath ${lit(scratch)}))`;
}

/**
 * bubblewrap argv up to the command. `protectedDirs` / `protectedFiles` must
 * exist (bwrap mounts over them): directories become empty tmpfs, files
 * become /dev/null. The worktree and scratch are bound writable last.
 */
export function autofixVerifyBubblewrapArgs({ worktree, scratch, env, protectedDirs = [], protectedFiles = [] }) {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  ];
  for (const dir of protectedDirs) args.push('--tmpfs', dir);
  for (const file of protectedFiles) args.push('--ro-bind', '/dev/null', file);
  args.push('--bind', scratch, scratch, '--bind', worktree, worktree);
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  args.push('--chdir', worktree, '--');
  return args;
}
