/**
 * Where PortOS remembers a container project it had to FIND: one line per stack in the install's own `.env`.
 *
 * On Windows the vLLM and SGLang Qwen3.8-27B projects sit in a WSL2 distro (Docker Desktop's engine IS a WSL2 VM), reached as a `wsl.localhost` UNC path that `services/wslProjectPlacement.js` asks WSL for; this records it so the readiness poll, Start button and next boot agree. Keyed on the env-var NAME so stacks can't drift on precedence.
 * **Precedence:** an exported value (this run's decision) outranks the record, which outranks the documented default. PortOS has no dotenv, so readers open the file on every call (as `services/localLlm.js` does for `LLM_BACKEND`).
 */
import { PORTOS_ENV_PATH, readPortosEnvValue, upsertPortosEnvLine } from './portosEnv.js';

/** The project directory PortOS recorded under `envVar`, or `''`.
/** The project directory PortOS recorded under `envVar`, or `''`. */
export function readRecordedProjectDir(envVar, envPath = PORTOS_ENV_PATH) {
  return readPortosEnvValue(envVar, envPath) || '';
}

/** Remember where a project was found so nothing detects it twice. `upsertPortosEnvLine`, not an append (one line per detection makes meaning depend on whether a reader takes the first or last mention) and atomic, since `.env` also carries the database password and a half-written truncate is readable by a concurrent boot. */
export async function recordProjectDir(envVar, dir, envPath = PORTOS_ENV_PATH) {
  await upsertPortosEnvLine(envVar, dir, envPath);
}

/** Whether anything already answers "where does this project live", so a caller knows if detecting it is worth a subprocess; the placement service asks THIS module so a precedence change can't land in one place only. */
export function projectDirIsSettled(envVar, env = process.env, envPath = PORTOS_ENV_PATH) {
  return Boolean(String(env?.[envVar] || '').trim() || readRecordedProjectDir(envVar, envPath));
}

/** The configured directory, what PortOS recorded, or the stack's documented default, in that order (the one place it is written down). */
export function resolveRecordedProjectDir(envVar, defaultDir, env = process.env, envPath = PORTOS_ENV_PATH) {
  const configured = String(env?.[envVar] || '').trim();
  if (configured) return configured;
  return readRecordedProjectDir(envVar, envPath) || defaultDir();
}
