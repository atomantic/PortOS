import { execFile } from './childProcess.js';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Run a bounded capability probe and return its trimmed stdout, or `null` when
 * the command could not run or exited non-zero.
 *
 * The command is routed through `prepareCliSpawn` first. On Windows an
 * npm-installed CLI is a `.cmd` shim, and `execFile`'s default `shell: false`
 * neither applies a PATHEXT search to a bare name (`codex` → `spawn ENOENT`)
 * nor will it launch a `.cmd` target at all post-CVE-2024-27980 (`spawn
 * EINVAL`). Both failures land in the same `.catch(() => null)` as a genuinely
 * missing binary, so EVERY npm-shimmed CLI probed through here reported as
 * "not installed" on Windows while `codex --version` worked fine in a terminal
 * — the reviewer-CLI install probe behind the Code Review picker being the
 * visible case. `prepareCliSpawn` resolves the bare name to its
 * explicit-extension path and wraps a batch target as `cmd.exe /c <path>
 * <args>`; every branch of it is a no-op off Windows.
 *
 * The child's stdin is closed immediately. `agy models` blocks on an open stdin
 * and prints NOTHING until it closes — with execFile's default pipe that is a
 * full timeout's hang ending in SIGTERM and empty output. (execFile ignores an
 * `stdio` option, so ending the stream is the way to do it.) Not every vendor
 * needs it, but it costs one FD close and makes every probe immune. Same
 * reasoning, and the same incident, as `_execCliModelList` in
 * `lib/aiToolkit/providers.js`.
 *
 * `TMPDIR`/`TMP`/`TEMP` are pinned to a throwaway directory scoped to THIS one
 * probe, mkdtemp'd before the spawn and removed once it settles. Several real
 * agentic CLIs (kilo, opencode — both self-extracting/Node-launcher binaries)
 * write their own scratch/cache state (a session dir, Node's own module
 * compile cache) directly into whatever `TMPDIR` they inherit on EVERY
 * invocation, not just a first run. Left alone that state piles up in the
 * host's real temp directory a little on every provider-readiness poll, and
 * inside PortOS's own run-scoped vitest temp root (#9032) it fails the run
 * outright once every other leak is fixed (#9039) — a probe here never
 * observes or needs its own past scratch, so isolating and discarding it costs
 * one extra mkdtemp/rmSync and removes both problems at the source. A caller
 * that already scoped its own `env` still gets its OTHER vars untouched; only
 * the three temp-dir keys are overridden on top.
 */
function probe(cmd, args, { timeoutMs, env, cwd, maxBuffer }) {
  let scratchDir;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), 'portos-cli-probe-'));
  } catch {
    // Could not even allocate the scratch dir (a full disk, an unwritable
    // tmpdir) — fail closed the same as every other probe failure, rather
    // than throwing synchronously out of what every caller treats as a
    // promise that always resolves (never rejects).
    return Promise.resolve(null);
  }
  const probeEnv = { ...(env || process.env), TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir };
  const options = {
    timeout: timeoutMs,
    env: probeEnv,
    ...(cwd === undefined ? {} : { cwd }),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  };
  const cleanup = () => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort — a lingering handle on a still-terminating child must
      // not throw out of a probe that already has its answer.
    }
  };
  // `bufferedSpawn.js` is imported lazily, not at module load: this module is
  // reached by a very large share of the server suite, and an eager edge into
  // that subtree pushed the tree-wide instantiation budget over (see "Import
  // scoping" in server/AGENTS.md). The import also supplies the microtask
  // boundary the `Promise.resolve()` used to — some spawn failures (notably
  // ENOEXEC for a broken text shim on macOS) are thrown synchronously by the
  // child-process wrapper, and this keeps them on the same rejected-promise path
  // as an ordinary failure.
  return import('./bufferedSpawn.js')
    .then(({ prepareCliSpawn }) => {
      // Resolution reads the env the CHILD will run under, so a caller that
      // overrides PATH probes its own binary, not one off the server's PATH.
      const launch = prepareCliSpawn(cmd, args, probeEnv);
      const pending = execFileAsync(launch.command, launch.args, options);
      pending.child?.stdin?.end();
      return pending;
    })
    .then(({ stdout }) => String(stdout ?? '').trim())
    .catch(() => null)
    .finally(cleanup);
}

/**
 * Does running `cmd args` succeed without error? A capability probe (not a
 * PATH lookup like `whichFirst` in processEnv.js) — it actually invokes the
 * command, so it also catches a binary that's on PATH but broken. Bounded by
 * `timeoutMs` so a hung/interactive command can't stall the caller. Default
 * 5s suits the lightweight system tools this was extracted from (`brew`,
 * `systemctl`, `ollama`); a heavier agentic CLI (`codex`, `grok`, `agy`) needs
 * the caller to pass a longer bound — `imageGen/{grok,agy,codex}.js`'s own
 * `checkConnection()` probes use 15s for exactly these binaries. Consolidates
 * two previously-private copies (localLlm.js, ollamaManager.js — see #3606).
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
 * The stdout of `cmd args`, trimmed — or `null` when the command could not run
 * or exited non-zero. The output-returning sibling of {@link commandExists}:
 * same probe, same bounded timeout, but it hands back what the command SAID so
 * a caller can read a `--version` banner or a `models` listing instead of
 * re-spawning the same child twice to learn both.
 *
 * `null` is the NOT-KNOWN sentinel, distinct from `''` (ran, said nothing) —
 * the harness registry reads a null as "no version available", never as "out of
 * date".
 *
 * @param {string} cmd
 * @param {string[]} [args] - defaults to `['--version']`, the common probe
 * @param {{timeoutMs?: number, env?: object, cwd?: string, maxBuffer?: number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function commandOutput(cmd, args = ['--version'], { timeoutMs = 5_000, env, cwd, maxBuffer } = {}) {
  return probe(cmd, args, { timeoutMs, env, cwd, maxBuffer });
}
