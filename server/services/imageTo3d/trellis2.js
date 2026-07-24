/**
 * TRELLIS.2 (local Apple Silicon / MPS) target — install detection, pure command
 * builders, a robust progress parser, and a guarded generate runner.
 *
 * Phase 2a of #2951/#2952: the *scaffolding* the install SSE route and the 3D page
 * will drive. Everything here is either pure (path/arg/step builders, the progress
 * parser) or exercised only through injectable dependencies (`exists`, `spawnImpl`)
 * so the wiring is unit-testable **without** downloading the ~15 GB model or running
 * a live GPU render. `runTrellis2Generate` is the one real-subprocess boundary and
 * NEVER auto-runs — it throws unless the model is installed and is only reached from
 * an explicit user action (CLAUDE.md no-cold-bootstrap policy). The exact wording of
 * `generate.py`'s progress output is refined during hands-on validation, so the
 * parser keys on format-agnostic signals (a percentage, a `.glb` path) rather than
 * guessing internal stage names.
 *
 * Install layout mirrors the FLUX.2 venv convention in `pythonSetup.js`
 * (`~/.portos/...`): the `trellis-mac` repo is cloned to `~/.portos/trellis2` and its
 * `setup.sh` builds a `.venv` inside it.
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const HOME = homedir();
const IS_WIN = platform() === 'win32';

/** The Apple Silicon MPS port of Microsoft TRELLIS.2. */
export const TRELLIS2_REPO = 'https://github.com/shivampkumar/trellis-mac';

/** Clone/install root. `base` overridable for tests. */
export function trellis2Root(base = join(HOME, '.portos')) {
  return join(base, 'trellis2');
}

/** The venv Python the `setup.sh` script builds inside the clone. */
export function trellis2VenvPython(base) {
  const root = trellis2Root(base);
  return IS_WIN
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python3');
}

/** The port's single-image entrypoint (`python generate.py <image>`). */
export function trellis2GenerateScript(base) {
  return join(trellis2Root(base), 'generate.py');
}

/**
 * Installed ⇔ the venv Python AND the generate script both exist. `exists` is
 * injectable so the check is deterministic in tests.
 * @param {{base?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {boolean}
 */
export function isTrellis2Installed({ base, exists = existsSync } = {}) {
  return exists(trellis2VenvPython(base)) && exists(trellis2GenerateScript(base));
}

/**
 * The install as an ordered list of `{stage, command, args, cwd?}` steps: shallow-
 * clone the port, then run its `setup.sh` (which builds the venv + fetches weights).
 * Pure — the SSE install route executes these; keeping them a data structure makes
 * the plan assertable without running it.
 * @param {string} [base]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string}>}
 */
export function buildInstallSteps(base) {
  const root = trellis2Root(base);
  return [
    { stage: 'clone', command: 'git', args: ['clone', '--depth', '1', TRELLIS2_REPO, root] },
    { stage: 'setup', command: 'bash', args: ['setup.sh'], cwd: root },
  ];
}

/**
 * The generate invocation: `<venv-python> generate.py <image> [--output <glb>]`.
 * Pure. Throws when no source image is given (a render with no input is a bug, not
 * an empty run).
 * @param {{imagePath: string, outputPath?: string, base?: string}} opts
 * @returns {{command: string, args: string[]}}
 */
export function buildGenerateArgs({ imagePath, outputPath, base } = {}) {
  if (!imagePath) throw new Error('buildGenerateArgs: imagePath is required');
  const args = [trellis2GenerateScript(base), imagePath];
  if (outputPath) args.push('--output', outputPath);
  return { command: trellis2VenvPython(base), args };
}

/**
 * Parse one line of `generate.py` output into a progress frame, or null when the
 * line carries no signal. Format-agnostic on purpose (the port's exact wording is
 * confirmed during hands-on validation): it extracts a percentage and/or a written
 * `.glb` path rather than matching guessed internal stage names.
 * @param {string} line
 * @returns {{stage: string, percent?: number, assetPath?: string, message: string}|null}
 */
export function parseGenerateProgress(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const pct = text.match(/(\d{1,3})\s*%/);
  const glb = text.match(/(\S+\.glb)\b/i);
  const frame = { message: text };
  if (pct) frame.percent = Math.min(100, Number(pct[1]));
  if (glb) {
    frame.stage = 'export';
    frame.assetPath = glb[1];
  } else if (pct) {
    frame.stage = 'generating';
  } else {
    return null;
  }
  return frame;
}

/**
 * Run the install as a killable, event-emitting job: execute `buildInstallSteps()`
 * sequentially (clone the MPS port → run its `setup.sh`, ~15 GB), emitting a
 * `{ type:'stage' }` per step, `{ type:'log' }` for subprocess output, and a
 * terminal `{ type:'complete' }` on success (it throws on a failed/canceled step so
 * the SSE route can emit `{ type:'error' }`). Real subprocesses — user-triggered
 * only. `spawnImpl` injectable so the step sequencing / cancel / failure paths are
 * unit-testable without a real 15 GB install.
 *
 * @param {{base?: string, onEvent?: (ev: object) => void, spawnImpl?: Function}} [opts]
 * @returns {{promise: Promise<{ok: true}>, kill: () => void}}
 */
export function installTrellis2({ base, onEvent = () => {}, spawnImpl = spawn } = {}) {
  const steps = buildInstallSteps(base);
  let currentChild = null;
  let canceled = false;

  const runStep = (step) => new Promise((resolve, reject) => {
    onEvent({ type: 'stage', stage: step.stage, message: `${step.command} ${step.args.join(' ')}` });
    // Child-process boundary — outcomes flow through events, not a throw into the
    // request lifecycle (CLAUDE.md child-process exception).
    const child = spawnImpl(step.command, step.args, step.cwd ? { cwd: step.cwd } : {});
    currentChild = child;
    const log = (buf) => {
      const message = String(buf).trim();
      if (message) onEvent({ type: 'log', stage: step.stage, message });
    };
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(`TRELLIS.2 install step '${step.stage}' exited ${code}`);
      err.code = 'TRELLIS2_INSTALL_FAILED';
      err.stage = step.stage;
      reject(err);
    });
  });

  const promise = (async () => {
    for (const step of steps) {
      if (canceled) {
        const err = new Error('TRELLIS.2 install canceled');
        err.code = 'TRELLIS2_INSTALL_CANCELED';
        throw err;
      }
      await runStep(step);
    }
    onEvent({ type: 'complete', message: 'TRELLIS.2 installed.' });
    return { ok: true };
  })();

  const kill = () => {
    canceled = true;
    if (currentChild && typeof currentChild.kill === 'function') currentChild.kill('SIGTERM');
  };

  return { promise, kill };
}

/**
 * Run a single image→GLB generation. The one real-subprocess boundary — GUARDED:
 * throws `TRELLIS2_NOT_INSTALLED` unless the model is present, so it can never run
 * from a cold boot. `spawnImpl`/`exists` are injectable so the wiring (right command,
 * progress streaming, resolve-with-asset) is unit-testable without a real render.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string,
 *          onProgress?: (frame: object) => void,
 *          spawnImpl?: Function, exists?: (p: string) => boolean}} opts
 * @returns {Promise<{assetPath: string}>}
 */
export function runTrellis2Generate({
  imagePath,
  outputPath,
  base,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
} = {}) {
  if (!isTrellis2Installed({ base, exists })) {
    const err = new Error('TRELLIS.2 is not installed — install it before generating.');
    err.code = 'TRELLIS2_NOT_INSTALLED';
    return Promise.reject(err);
  }
  const { command, args } = buildGenerateArgs({ imagePath, outputPath, base });
  return new Promise((resolve, reject) => {
    // Child-process boundary — errors surface via the 'error'/'close' events, not a
    // throw into the request lifecycle (CLAUDE.md child-process exception).
    const child = spawnImpl(command, args, { cwd: trellis2Root(base) });
    let assetPath = outputPath || null;
    const ingest = (buf) => {
      for (const line of String(buf).split('\n')) {
        const frame = parseGenerateProgress(line);
        if (!frame) continue;
        if (frame.assetPath) assetPath = frame.assetPath;
        if (onProgress) onProgress(frame);
      }
    };
    child.stdout?.on('data', ingest);
    child.stderr?.on('data', ingest);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && assetPath) {
        resolve({ assetPath });
        return;
      }
      const err = new Error(
        code === 0 ? 'TRELLIS.2 finished but produced no .glb' : `TRELLIS.2 generate exited ${code}`,
      );
      err.code = 'TRELLIS2_GENERATE_FAILED';
      reject(err);
    });
  });
}
