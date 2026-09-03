import { execFile } from './childProcess.js';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Run a bounded capability probe and return its trimmed stdout, or `null` when
 * the command could not run or exited non-zero.
 *
 * The child's stdin is closed immediately. `agy models` blocks on an open stdin
 * and prints NOTHING until it closes — with execFile's default pipe that is a
 * full timeout's hang ending in SIGTERM and empty output. (execFile ignores an
 * `stdio` option, so ending the stream is the way to do it.) Not every vendor
 * needs it, but it costs one FD close and makes every probe immune. Same
 * reasoning, and the same incident, as `_execCliModelList` in
 * `lib/aiToolkit/providers.js`.
 */
function probe(cmd, args, { timeoutMs, env, cwd, maxBuffer }) {
  const options = {
    timeout: timeoutMs,
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  };
  // Some spawn failures (notably ENOEXEC for a broken text shim on macOS)
  // are thrown synchronously by the child-process wrapper before it can
  // return a promise. Start the call in a microtask so those failures follow
  // the same null result as an ordinary rejected execFile promise.
  return Promise.resolve()
    .then(() => {
      const pending = execFileAsync(cmd, args, options);
      pending.child?.stdin?.end();
      return pending;
    })
    .then(({ stdout }) => String(stdout ?? '').trim())
    .catch(() => null);
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
