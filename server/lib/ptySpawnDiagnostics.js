/**
 * Turn a raw node-pty spawn failure into an actionable diagnosis.
 *
 * node-pty reports every POSIX launch failure as `posix_spawn failed: No such file or directory` without saying WHICH file was missing; three faults collapse into it: (1) the executable is gone (ruled out upstream: the CoS runner resolves it on the child PATH and runs a `--version` probe before opening a PTY); (2) the `cwd` no longer exists (a worktree reaped from under a spawn); (3) **node-pty's own runtime is broken**: on macOS/Linux `pty.fork()` execs a sibling `spawn-helper` read from disk on EVERY spawn, so an emptied `server/node_modules` breaks all future spawns while the loaded binding keeps the runner healthy-looking. (3) cost a day: `npm ci` inside a CoS worktree whose `server/node_modules` symlinks at the primary empties the SYMLINK TARGET (see the "Never run `npm ci` …" rule in root `AGENTS.md`), so every later spawn fails identically; as a generic `spawn-rejected` it looked transient, so every task type burned MAX_TASK_RETRIES, blocked, and filed a meta-investigation that failed the same way. The probe separates (3): re-launch a known-good command in a known-good directory; if THAT fails, the PTY layer itself is unusable.
 */

import { existsSync } from 'fs';
import { withSpawnCwdEnv } from './spawnCwd.js';

/** Message prefix marking a broken PTY runtime; `agentTuiSpawning.js` matches it to classify the run as actionable-and-blocked instead of retrying (like `Command executable unavailable:`). Changing it means changing that matcher. */
export const PTY_UNAVAILABLE_PREFIX = 'CoS Runner PTY unavailable:';

/**
 * Message prefix for a spawn whose working directory vanished before launch. Deliberately NOT matched by `agentTuiSpawning.js`: unlike a broken PTY layer it is transient (each retry provisions a fresh worktree), so it falls through to the retrying
 * `spawn-rejected`; a genuinely misconfigured cwd still fails every attempt and blocks on MAX_TASK_RETRIES.
 */
export const PTY_WORKSPACE_MISSING_PREFIX = 'CoS Runner workspace missing:';

/** A command guaranteed to exist on the host, used only to prove the PTY layer can fork; the probe kills it immediately. */
const PROBE_COMMAND = process.platform === 'win32' ? 'cmd.exe' : '/bin/echo';
const PROBE_ARGS = process.platform === 'win32' ? ['/c', 'exit'] : ['portos-pty-probe'];

/**
 * Can node-pty still fork? Spawns {@link PROBE_COMMAND} in `probeCwd` and kills it; only whether the constructor threw matters.
 *
 * @param {object} pty - the node-pty module (injected so this stays testable)
 * @param {string} probeCwd - a directory known to exist (the runner's own root)
 * @returns {boolean} true when the PTY layer is usable
 */
export function probePtyRuntime(pty, probeCwd) {
  // Catching is the point ("did this throw?" IS the answer), and the probe runs while the caller is already handling a failure, so it must not replace the original error with its own.
  try {
    const probe = pty.spawn(PROBE_COMMAND, PROBE_ARGS, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: probeCwd,
      // The child is a bare `echo` that never reads PWD, but the tree-wide guard in server/test/guards/runtime/spawnCwd.test.js refuses special-casing (it stops being true if the probe command changes); pin it like every other cwd-passing spawn (#3193).
      env: withSpawnCwdEnv(process.env, probeCwd),
    });
    try {
      probe.kill();
    } catch {
      // Already exited (`echo` beat the kill): still a success.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Explain a `pty.spawn` throw. Order matters: the workspace check is a cheap `existsSync` on the requested path and a missing worktree is a per-request fault saying nothing about the runtime; only then is a probe fork spent on whether the PTY layer is broken for everyone.
 *
 * @param {Error} err - what `pty.spawn` threw
 * @param {object} options
 * @param {string} options.cwd - the working directory the spawn requested
 * @param {string} options.probeCwd - a directory known to exist, for the probe
 * @param {(probeCwd: string) => boolean} options.runtimeProbe - whether the PTY layer still works; injected so callers own the node-pty import
 * @returns {{ diagnosed: boolean, message: string }} `diagnosed: false` means neither known fault matched, so the caller lets the original error bubble rather than dress an unknown cause in a confident explanation.
 *   Whether a named fault is worth RETRYING is the caller's policy: a reaped worktree clears on retry (fresh one), a broken PTY layer reproduces forever.
 */
export function diagnosePtySpawnFailure(err, { cwd, probeCwd, runtimeProbe }) {
  const raw = err?.message || String(err);

  if (cwd && !existsSync(cwd)) {
    return {
      diagnosed: true,
      message: `${PTY_WORKSPACE_MISSING_PREFIX} the working directory for this spawn no longer exists. It was probably removed (a reaped worktree) between the request and the launch. Original error: ${raw}`,
    };
  }

  if (!runtimeProbe(probeCwd)) {
    return {
      diagnosed: true,
      message: `${PTY_UNAVAILABLE_PREFIX} node-pty cannot fork any process, so this is not specific to the requested command. The usual cause is an emptied or partially installed \`server/node_modules\` — node-pty execs its \`spawn-helper\` binary from disk on every spawn. Repair it with \`node scripts/ensure-deps.js\` in the primary checkout (plain \`npm install\` skips the node-pty rebuild because of \`ignore-scripts=true\`) and restart the runner (\`node ./server/node_modules/pm2/bin/pm2 restart portos-cos\`). Original error: ${raw}`,
    };
  }

  return { diagnosed: false, message: raw };
}
