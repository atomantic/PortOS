/**
 * Where PortOS remembers a container project it had to go and FIND — one line
 * per stack in the install's own `.env`.
 *
 * Two runtimes now share this question. On Windows neither the vLLM nor the
 * SGLang Qwen3.8-27B project lives where its default resolves: Docker Desktop's
 * engine IS a WSL2 VM, so the compose project and its ~20 GB of weights sit
 * inside a distro and are reached from Windows as `\\wsl.localhost\<distro>\…`.
 * `services/wslProjectPlacement.js` asks WSL for that path; this module is where
 * the answer is written down, so the readiness poll, the Start button and the
 * next server boot all resolve the directory that run actually used.
 *
 * Everything here is keyed on the env-var NAME rather than baked to one stack —
 * a second copy of this loop is how the two would drift on the precedence rule
 * below, which is invisible on any non-Windows machine.
 *
 * **The precedence is deliberate and identical for every stack:** an exported
 * value (this run's decision) outranks the record (some earlier run's), which
 * outranks the documented default. A directory PortOS auto-detected once must
 * never quietly outlive an operator who exports the variable today.
 *
 * PortOS has no dotenv, so `.env` reaches `process.env` for nobody — a reader
 * that wants a value out of it opens the file, the same way
 * `services/localLlm.js` reads its `LLM_BACKEND` marker. Read on every call
 * rather than cached: a placement run writes it, and the readiness poll that
 * must start seeing the new directory lives in the same process without a
 * restart between them.
 */

import { PORTOS_ENV_PATH, readPortosEnvValue, upsertPortosEnvLine } from './portosEnv.js';

/**
 * The project directory PortOS recorded under `envVar`, or `''` when there is
 * none.
 *
 * @param {string} envVar
 * @param {string} [envPath]
 * @returns {string}
 */
export function readRecordedProjectDir(envVar, envPath = PORTOS_ENV_PATH) {
  return readPortosEnvValue(envVar, envPath) || '';
}

/**
 * Remember where a project was found, so nothing has to detect it twice.
 *
 * `upsertPortosEnvLine` rather than an append: a file accumulating one line per
 * detection run is a config whose meaning depends on which reader opens it
 * (some take the first mention, some the last). Atomic, because PortOS's `.env`
 * also carries the database password and a half-written truncate is readable by
 * a concurrent boot.
 *
 * @param {string} envVar
 * @param {string} dir
 * @param {string} [envPath]
 */
export async function recordProjectDir(envVar, dir, envPath = PORTOS_ENV_PATH) {
  await upsertPortosEnvLine(envVar, dir, envPath);
}

/**
 * Whether anything already answers "where does this project live", so a caller
 * knows whether detecting it is still worth a subprocess.
 *
 * Exported so the placement service asks THIS module rather than re-listing the
 * two sources — a precedence change made in one place and not the other is
 * invisible on any non-Windows machine.
 *
 * @param {string} envVar
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath]
 * @returns {boolean}
 */
export function projectDirIsSettled(envVar, env = process.env, envPath = PORTOS_ENV_PATH) {
  return Boolean(String(env?.[envVar] || '').trim() || readRecordedProjectDir(envVar, envPath));
}

/**
 * The configured directory, what PortOS recorded, or the stack's documented
 * default — in that order. The one place that order is written down.
 *
 * @param {string} envVar
 * @param {() => string} defaultDir - evaluated only when neither source answers
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envPath]
 * @returns {string}
 */
export function resolveRecordedProjectDir(envVar, defaultDir, env = process.env, envPath = PORTOS_ENV_PATH) {
  const configured = String(env?.[envVar] || '').trim();
  if (configured) return configured;
  return readRecordedProjectDir(envVar, envPath) || defaultDir();
}
