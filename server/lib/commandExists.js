/**
 * `commandExists(cmd, args, opts)` probes whether a command runs successfully, with a spawn deadline
 * that settles even if the child ignores signals.
 */

import { spawn } from './childProcess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// execFile's own default.
const DEFAULT_MAX_BUFFER = 1024 * 1024;
// POSIX grace between the deadline's SIGTERM and the SIGKILL escalation.
const PROBE_KILL_GRACE_MS = 2_000;

/**
 * Run a bounded capability probe and return its trimmed stdout, or `null` when
 * the command could not run or exited non-zero.
 *
 * The command goes through `prepareCliSpawn` first: on Windows an npm-installed
 * CLI is a `.cmd` shim that a `shell: false` spawn can neither find by bare name
 * (ENOENT) nor launch (EINVAL, CVE-2024-27980), which would read as "not
 * installed". It is a no-op off Windows.
 *
 * stdin is `'ignore'`: `agy models` blocks on an open stdin and prints nothing
 * until it closes (same as `_execCliModelList` in `lib/aiToolkit/providers.js`).
 *
 * The deadline settles the result ITSELF rather than waiting for `close`
 * (#10604): `execFile`'s `timeout` only signals, so a child ignoring SIGTERM
 * would hang the caller and the scratch cleanup. On expiry the probe resolves
 * `null` and terminates only its own child: Windows `killProcessTree` (`taskkill /T`);
 * POSIX process group (`detached`) gets SIGTERM, then SIGKILL after a grace.
 * Output past `maxBuffer` on either stream fails the probe the same way. Events
 * after the result is fixed are ignored, and a signal/cleanup failure never
 * replaces the result.
 *
 * `TMPDIR`/`TMP`/`TEMP` are pinned to a per-probe mkdtemp directory removed once
 * it settles: CLIs like kilo and opencode write scratch/cache state into their
 * inherited temp dir on every invocation, which would pile up in the host temp
 * dir (and fail the run-scoped vitest temp root, #9032/#9039). A caller's other
 * `env` vars are untouched.
 */
function probe(cmd, args, { timeoutMs, env, cwd, maxBuffer = DEFAULT_MAX_BUFFER }) {
  let scratchDir;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), 'portos-cli-probe-'));
  } catch {
    // Fail closed like any probe failure: callers treat this as a promise that never rejects.
    return Promise.resolve(null);
  }
  const probeEnv = { ...(env || process.env), TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir };
  const cleanup = () => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort: must not throw out of a probe that already has its answer.
    }
  };
  // Lazy import keeps this widely-reached module under the import budget (see "Import
  // scoping" in server/AGENTS.md); it also gives a microtask boundary so synchronous
  // spawn throws (e.g. ENOEXEC on macOS) take the rejected-promise path.
  return import('./bufferedSpawn.js')
    .then((lifecycle) => runProbe(lifecycle, cmd, args, probeEnv, { timeoutMs, cwd, maxBuffer }))
    .catch(() => null)
    .finally(cleanup);
}

function runProbe({ prepareCliSpawn, killProcessTree, IS_WIN32 }, cmd, args, probeEnv, { timeoutMs, cwd, maxBuffer }) {
  return new Promise((resolve) => {
    // Resolve against the child's env so an overridden PATH probes its own binary.
    const launch = prepareCliSpawn(cmd, args, probeEnv);
    const child = spawn(launch.command, launch.args, {
      env: probeEnv,
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX group lets the deadline reach the CLI's children; on Windows `detached` opens a console.
      detached: !IS_WIN32,
    });
    const chunks = [];
    let settled = false;
    let deadline = null;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };
    const signal = (sig) => {
      try {
        killProcessTree(child, sig, { processGroup: !IS_WIN32 });
      } catch (err) {
        console.warn(`⚠️ ${cmd} probe could not send ${sig}: ${err?.code || err?.message}`);
      }
    };
    const terminate = () => {
      signal('SIGTERM');
      if (IS_WIN32) return; // taskkill /T /F already force-killed the tree
      if (!child.pid) return;
      // Escalate on the GROUP: a CLI that exits on SIGTERM can leave a descendant that ignored it.
      // The group id cannot be reused while any member lives, so ESRCH means the group is gone.
      const escalation = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ESRCH — every process in the group has exited.
        }
      }, PROBE_KILL_GRACE_MS);
      escalation.unref?.();
    };

    // Each stream is held to maxBuffer separately, as execFile did; stderr is
    // only counted, never kept.
    const capStream = (stream, keep) => {
      let bytes = 0;
      stream?.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBuffer) {
          terminate();
          settle(null);
          return;
        }
        keep?.(chunk);
      });
    };
    capStream(child.stdout, (chunk) => chunks.push(chunk));
    capStream(child.stderr);
    // Listeners stay attached after settling so a late `error` is never unhandled.
    child.on('error', () => settle(null));
    child.on('close', (code) => {
      settle(code === 0 ? Buffer.concat(chunks).toString('utf8').trim() : null);
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadline = setTimeout(() => {
        if (settled) return;
        terminate();
        settle(null);
      }, timeoutMs);
    }
  });
}

/**
 * Does running `cmd args` succeed? A capability probe (not a PATH lookup like
 * `whichFirst`): it invokes the command, so it catches a broken binary on PATH.
 * The 5s default suits lightweight system tools; heavier agentic CLIs
 * (`codex`, `grok`, `agy`) need a longer `timeoutMs` (15s in `imageGen/`).
 *
 * @param {string} cmd
 * @param {string[]} [args] - defaults to `['--version']`, the common probe
 * @param {{timeoutMs?: number, env?: object, cwd?: string}} [opts]
 * @returns {Promise<boolean>}
 */
export async function commandExists(cmd, args = ['--version'], { timeoutMs = 5_000, env, cwd } = {}) {
  return (await probe(cmd, args, { timeoutMs, env, cwd })) !== null;
}

/**
 * The trimmed stdout of `cmd args`, or `null` when it could not run or exited
 * non-zero. Output-returning sibling of {@link commandExists}.
 *
 * `null` is the NOT-KNOWN sentinel, distinct from `''` (ran, said nothing): the
 * harness registry reads null as "no version available", never "out of date".
 *
 * @param {string} cmd
 * @param {string[]} [args] - defaults to `['--version']`, the common probe
 * @param {{timeoutMs?: number, env?: object, cwd?: string, maxBuffer?: number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function commandOutput(cmd, args = ['--version'], { timeoutMs = 5_000, env, cwd, maxBuffer } = {}) {
  return probe(cmd, args, { timeoutMs, env, cwd, maxBuffer });
}
