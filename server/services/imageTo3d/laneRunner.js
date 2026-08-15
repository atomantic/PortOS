/**
 * Image-to-3D — shared execution-lane subprocess machinery.
 *
 * Every local target installs the same way (run an ordered list of shell steps,
 * retrying the ones that fail on a network blip) and renders the same way (spawn a
 * generator, stream its output through a progress parser, classify a non-zero exit).
 * Only the *steps*, the *arguments*, and the *error vocabulary* differ per lane.
 *
 * This module owns that machinery once so a second lane is a step list plus an arg
 * builder — not a copy of the retry policy, the cancel semantics, and the
 * `{ promise, kill }` contract. Both TRELLIS.2 lanes (`trellis2.js` on Apple
 * Silicon/MPS, `trellis2Cuda.js` on NVIDIA/CUDA) are built on it; it is deliberately
 * target-agnostic (no TRELLIS-specific paths, repos, or progress vocabulary — those
 * are injected), so a future non-TRELLIS clone-and-setup target reuses it as-is.
 *
 * Everything here is a child-process boundary running OUTSIDE the request lifecycle,
 * so outcomes flow through events and rejected promises — never a throw into Express
 * (CLAUDE.md child-process exception).
 */

import { spawn } from '../../lib/childProcess.js';
import { sleep as defaultSleep } from '../../lib/fileUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { createLineReader } from '../../lib/streamLines.js';

/**
 * Build a case-insensitive predicate testing text against an alternation of signature
 * phrases — the shape every subprocess-error classifier in this feature uses (each
 * keeps its own domain-specific phrase list; only the plumbing is shared).
 * @param {string[]} phrases
 * @returns {(text: string) => boolean}
 */
export function textMatcher(phrases) {
  const re = new RegExp(phrases.join('|'), 'i');
  return (text) => re.test(String(text ?? ''));
}

/**
 * Append a chunk of subprocess output to a bounded tail (the last `max` chars), so a
 * non-zero exit can be classified from the trailing output without retaining the
 * whole stream. Used at every child-process boundary in both lanes.
 * @param {string} prev
 * @param {*} buf
 * @param {number} [max]
 * @returns {string}
 */
export function appendTail(prev, buf, max = 4000) {
  return `${prev}${buf}`.slice(-max);
}

/**
 * Run an ordered install plan as a killable, event-emitting job.
 *
 * Emits `{type:'stage'}` per step, `{type:'log'}` for subprocess output, and a
 * terminal `{type:'complete'}`; rejects on a failed or canceled step so an SSE route
 * can emit `{type:'error'}`.
 *
 * **Transient-failure retry.** A multi-GB install over half a dozen git clones and pip
 * fetches routinely eats a mid-transfer `Connection reset` / `early EOF` (#2952) that
 * exits git 128. Install steps are *idempotent* — git removes a failed clone's target
 * dir, and setup scripts skip already-completed pieces — so a step whose output matches
 * the caller's `isTransient` signature is retried in place with a capped exponential
 * backoff. A non-transient failure (bad config, unsupported host, real setup error) is
 * NOT retried; it fails fast. `sleep` is injectable so tests don't wait on real backoff.
 *
 * **`optional` steps degrade rather than break.** A step marked `optional` that fails
 * for a non-transient reason (after burning its retries) warns and continues — for work
 * that lowers output quality but doesn't stop the install, like the MPS lane's Metal
 * Toolchain fetch (#3041). Checked AFTER the retry decision so a transient failure still
 * retries first, and scoped to a step failure so a cancel still propagates.
 *
 * @param {{steps: Array<{stage: string, command: string, args: string[], cwd?: string, optional?: boolean}>,
 *          label: string, codePrefix: string, isTransient: (text: string) => boolean,
 *          onEvent?: (ev: object) => void, spawnImpl?: Function, maxRetries?: number,
 *          sleep?: (ms: number) => Promise<void>, env?: NodeJS.ProcessEnv,
 *          verify?: (emit: (ev: object) => void) => void|Promise<void>,
 *          completeMessage?: string}} opts
 * @returns {{promise: Promise<{ok: true}>, kill: () => void}}
 */
export function runInstallSteps({
  steps,
  label,
  codePrefix,
  isTransient,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep = defaultSleep,
  env,
  verify,
  completeMessage,
}) {
  let currentChild = null;
  let canceled = false;

  const canceledError = () => {
    const err = new Error(`${label} install canceled`);
    err.code = `${codePrefix}_INSTALL_CANCELED`;
    return err;
  };

  const runStep = (step) => new Promise((resolve, reject) => {
    onEvent({ type: 'stage', stage: step.stage, message: `${step.command} ${step.args.join(' ')}` });
    const child = spawnImpl(step.command, step.args, {
      ...(step.cwd ? { cwd: step.cwd } : {}),
      ...(env ? { env } : {}),
    });
    currentChild = child;
    // Retain a bounded tail so a non-zero exit can be classified as transient-network
    // vs. a real failure — the clue is in the subprocess text, not the exit code (git
    // exits 128 for both a network drop and a bad ref).
    let outputTail = '';
    const log = (buf) => {
      const message = String(buf).trim();
      if (message) onEvent({ type: 'log', stage: step.stage, message });
      outputTail = appendTail(outputTail, buf);
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(`${label} install step '${step.stage}' exited ${code}`);
      err.code = `${codePrefix}_INSTALL_FAILED`;
      err.stage = step.stage;
      err.transient = isTransient(outputTail);
      reject(err);
    });
  });

  const runStepWithRetry = async (step) => {
    for (let attempt = 0; ; attempt += 1) {
      if (canceled) throw canceledError();
      try {
        await runStep(step);
        return;
      } catch (err) {
        const failedStep = err?.code === `${codePrefix}_INSTALL_FAILED`;
        const canRetry = failedStep && err.transient && attempt < maxRetries && !canceled;
        if (!canRetry) {
          if (step.optional && failedStep) {
            onEvent({
              type: 'log',
              stage: step.stage,
              message: `⚠️ Optional step '${step.stage}' failed (${err.message}) — continuing; output may be reduced quality.`,
            });
            return;
          }
          throw err;
        }
        const backoffMs = Math.min(30000, 2000 * 2 ** attempt);
        onEvent({
          type: 'log',
          stage: step.stage,
          message: `⚠️ Transient network error — retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 2}/${maxRetries + 1})…`,
        });
        await sleep(backoffMs);
      }
    }
  };

  const promise = (async () => {
    for (const step of steps) {
      if (canceled) throw canceledError();
      await runStepWithRetry(step);
    }
    // A setup script can exit 0 with pieces of itself missing, so a bare success would
    // report an install that silently renders garbage (#2952). The lane's own verify
    // runs BEFORE the terminal `complete` frame, which closes the client's EventSource.
    if (verify) await verify(onEvent);
    onEvent({ type: 'complete', message: completeMessage || `${label} installed.` });
    return { ok: true };
  })();

  const kill = () => {
    canceled = true;
    if (currentChild && typeof currentChild.kill === 'function') currentChild.kill('SIGTERM');
  };

  return { promise, kill };
}

/**
 * Spawn a generator subprocess and drive it to a produced asset.
 *
 * Streams combined stdout/stderr through `parseProgress` one line at a time, tracking
 * the produced asset path, and resolves `{ assetPath }` once the child exits 0 and the
 * asset has been post-processed.
 *
 * Output is split on `\r` AND `\n` via `createLineReader`: tqdm redraws its progress
 * bar in place with carriage returns, so a single chunk can carry several frames
 * separated only by `\r`. Splitting on `\n` alone would treat them as one line and
 * parse just the first (lowest) percent — under-reporting progress during the long
 * sampling phase. The reader's carry buffer is what makes that safe: chunks arrive on
 * arbitrary byte boundaries, so a stage banner straddling two `data` events would
 * otherwise be seen as two partial lines, match no signature, and stall the bar at the
 * previous percent until the next banner landed (#3578). Each stream gets its OWN
 * reader (a shared carry would splice a partial stdout line onto a stderr chunk), and
 * both are flushed on `close` so a final unterminated line — including the `Saved:`
 * line carrying the asset path — is still parsed.
 *
 * `classifiers` turn a non-zero exit into an actionable error instead of a bare
 * "exited N" — each is `{ test, code, help }` and the first match wins, so a lane can
 * name a gated-model or out-of-memory failure the user can actually fix.
 *
 * @param {{command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 *          label: string, codePrefix: string, parseProgress: (line: string) => object|null,
 *          assetPath?: string|null, onProgress?: (frame: object) => void,
 *          spawnImpl?: Function, postprocessGlb?: (path: string) => void|Promise<void>,
 *          classifiers?: Array<{test: (text: string) => boolean, code: string, help: string|(() => string)}>}} opts
 * @returns {{promise: Promise<{assetPath: string}>, kill: () => void}}
 */
export function runGenerateSubprocess({
  command,
  args,
  cwd,
  env,
  label,
  codePrefix,
  parseProgress,
  assetPath: initialAssetPath = null,
  onProgress,
  spawnImpl = spawn,
  postprocessGlb,
  classifiers = [],
}) {
  const child = spawnImpl(command, args, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
  let assetPath = initialAssetPath;
  let outputTail = '';
  const onLine = (line) => {
    const frame = parseProgress(line);
    if (!frame) return;
    if (frame.assetPath) assetPath = frame.assetPath;
    if (onProgress) onProgress(frame);
  };
  const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  // The tail is appended from the RAW chunk, not the parsed lines, so an exit
  // classifier still sees text the progress parser ignored.
  const ingest = (reader) => (buf) => {
    outputTail = appendTail(outputTail, buf);
    reader.push(buf);
  };
  const promise = new Promise((resolve, reject) => {
    child.stdout?.on('data', ingest(stdoutReader));
    child.stderr?.on('data', ingest(stderrReader));
    child.on('error', reject);
    child.on('close', (code) => {
      stdoutReader.flush();
      stderrReader.flush();
      if (code === 0 && assetPath) {
        Promise.resolve()
          .then(() => (postprocessGlb ? postprocessGlb(assetPath) : undefined))
          .then(() => resolve({ assetPath }))
          .catch((cause) => {
            const error = new Error(`${label} produced a GLB but material normalization failed: ${cause.message}`);
            error.code = `${codePrefix}_GLB_POSTPROCESS_FAILED`;
            reject(error);
          });
        return;
      }
      if (code !== 0) {
        // User-fixable setup/resource problems get named as such rather than
        // surfacing as an opaque exit code.
        const match = classifiers.find((c) => c.test(outputTail));
        if (match) {
          const err = new Error(typeof match.help === 'function' ? match.help() : match.help);
          err.code = match.code;
          reject(err);
          return;
        }
      }
      const err = new Error(
        code === 0 ? `${label} finished but produced no .glb` : `${label} generate exited ${code}`,
      );
      err.code = `${codePrefix}_GENERATE_FAILED`;
      reject(err);
    });
  });
  // Single captured child, never replaced — the helper's own exit check gates the
  // SIGKILL escalation, so `stillRunning` is unconditionally true here.
  const kill = () => killWithEscalation(child, { label: `${label} generate`, stillRunning: () => true });
  return { promise, kill };
}
