/**
 * Turn a raw node-pty spawn failure into a diagnosis a human can act on.
 *
 * node-pty reports every POSIX launch failure as the same opaque string —
 * `posix_spawn failed: No such file or directory` — with no indication of WHICH
 * file was missing. Three very different faults collapse into it:
 *
 *   1. the target executable is gone (already ruled out upstream: the CoS runner
 *      resolves it on the child PATH and runs a `--version` capability probe
 *      before it ever opens a PTY);
 *   2. the `cwd` no longer exists — a worktree reaped out from under a spawn;
 *   3. **node-pty's own runtime is broken** — on macOS/Linux `pty.fork()` execs a
 *      sibling `spawn-helper` binary that is read from disk on EVERY spawn, so an
 *      emptied `server/node_modules` breaks all future spawns while the already
 *      loaded binding keeps the runner process itself alive and healthy-looking.
 *
 * (3) is the one that cost a day: `npm ci` run inside a CoS worktree whose
 * `server/node_modules` was symlinked at the primary checkout empties the
 * SYMLINK TARGET and then installs into a fresh real directory in the worktree —
 * see the "Agent worktrees" rule in the root `AGENTS.md`. The primary checkout is
 * left with an empty `server/node_modules`, `spawn-helper` is gone, and every
 * subsequent agent spawn fails identically forever. Classified as a generic
 * `spawn-rejected` it looks transient, so the fleet retried it: every task type
 * burned MAX_TASK_RETRIES, blocked itself, and filed a meta-investigation task
 * that failed the same way.
 *
 * The probe is what separates (3) from the rest: re-launch a trivially-known-good
 * command in a known-good directory. If THAT fails too, nothing is wrong with the
 * caller's request — the PTY layer itself is unusable.
 */

import { existsSync } from 'fs';

/**
 * Message prefix marking a broken PTY runtime. `agentTuiSpawning.js` matches it
 * to classify the run as actionable-and-blocked instead of retrying, the same way
 * it already special-cases `Command executable unavailable:`. Changing this string
 * means changing that matcher.
 */
export const PTY_UNAVAILABLE_PREFIX = 'CoS Runner PTY unavailable:';

/** Message prefix for a spawn whose working directory vanished before launch. */
export const PTY_WORKSPACE_MISSING_PREFIX = 'CoS Runner workspace missing:';

/**
 * A command guaranteed to exist on the host, used only to prove the PTY layer can
 * still fork at all. Never runs long enough to matter: the probe kills it.
 */
const PROBE_COMMAND = process.platform === 'win32' ? 'cmd.exe' : '/bin/echo';
const PROBE_ARGS = process.platform === 'win32' ? ['/c', 'exit'] : ['portos-pty-probe'];

/**
 * Can node-pty still fork? Spawns {@link PROBE_COMMAND} in `probeCwd` and kills it
 * immediately — we care only whether the constructor threw.
 *
 * @param {object} pty - the node-pty module (injected so this stays testable)
 * @param {string} probeCwd - a directory known to exist (the runner's own root)
 * @returns {boolean} true when the PTY layer is usable
 */
export function probePtyRuntime(pty, probeCwd) {
  // Outside the Express request lifecycle and deliberately best-effort: a probe
  // that itself explodes must not mask the original failure we are explaining.
  try {
    const probe = pty.spawn(PROBE_COMMAND, PROBE_ARGS, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: probeCwd,
      env: process.env,
    });
    try {
      probe.kill();
    } catch {
      // Already exited — `echo` is fast enough to beat the kill. Still a success.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Explain a `pty.spawn` throw.
 *
 * Order matters: the workspace check is a cheap `existsSync` on the exact path the
 * caller asked for, and a missing worktree is a per-request fault that says nothing
 * about the runtime. Only once that is ruled out do we spend a probe fork asking
 * whether the PTY layer is broken for everyone.
 *
 * @param {Error} err - what `pty.spawn` threw
 * @param {object} options
 * @param {string} options.cwd - the working directory the spawn requested
 * @param {string} options.probeCwd - a directory known to exist, for the probe
 * @param {(probeCwd: string) => boolean} options.runtimeProbe - returns whether the
 *   PTY layer still works; injected so callers own the node-pty import
 * @returns {{ retryable: boolean, message: string }} `retryable: false` marks a
 *   fault that will fail identically on every attempt, so the caller should block
 *   rather than burn retries.
 */
export function diagnosePtySpawnFailure(err, { cwd, probeCwd, runtimeProbe }) {
  const raw = err?.message || String(err);

  if (cwd && !existsSync(cwd)) {
    return {
      retryable: false,
      message: `${PTY_WORKSPACE_MISSING_PREFIX} the working directory for this spawn no longer exists. It was probably removed (a reaped worktree) between the request and the launch. Original error: ${raw}`,
    };
  }

  if (!runtimeProbe(probeCwd)) {
    return {
      retryable: false,
      message: `${PTY_UNAVAILABLE_PREFIX} node-pty cannot fork any process, so this is not specific to the requested command. The usual cause is an emptied or partially installed \`server/node_modules\` — node-pty execs its \`spawn-helper\` binary from disk on every spawn. Repair it with \`npm install --prefix server\` and restart the runner (\`pm2 restart portos-cos\`). Original error: ${raw}`,
    };
  }

  return { retryable: true, message: raw };
}
