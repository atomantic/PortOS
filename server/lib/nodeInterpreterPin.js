/**
 * The Node.js interpreter PortOS's own pm2 apps are pinned to.
 *
 * `ecosystem.config.cjs` used to launch every app with `interpreter: 'node'`,
 * which pm2 resolves against the DAEMON's PATH — so the Node that actually ran
 * PortOS was whichever `node` came first there (often Homebrew's), not the one
 * nvm installed or the one the terminal reports. Recording an absolute path in
 * `.env` as `PORTOS_NODE_INTERPRETER` makes the runtime an explicit choice the
 * Node runtime panel can change and report.
 *
 * Precedence follows `portosEnv.js`: an exported value wins over the saved one.
 * A candidate that is not an absolute path to an existing `node` binary is
 * skipped rather than trusted — an nvm version removed after it was pinned must
 * fall back to PATH resolution, never leave pm2 unable to start the server.
 * `ecosystem.config.cjs` carries the CJS twin of `resolvePinnedNodeInterpreter`
 * (it cannot import ESM); keep the two rules identical.
 */

import { existsSync } from 'fs';
import { basename, delimiter, dirname, isAbsolute } from 'path';
import { readPortosEnvValue } from './portosEnv.js';

export const NODE_INTERPRETER_ENV_KEY = 'PORTOS_NODE_INTERPRETER';

const NODE_BINARY_NAMES = new Set(['node', 'node.exe']);

export function isUsableNodeInterpreter(candidate, exists = existsSync) {
  return typeof candidate === 'string'
    && isAbsolute(candidate)
    && NODE_BINARY_NAMES.has(basename(candidate).toLowerCase())
    && exists(candidate);
}

/**
 * The pinned interpreter in effect, or null when PortOS runs on PATH's `node`.
 * @param {{ env?: object, envPath?: string, exists?: (path: string) => boolean }} [options]
 */
export function resolvePinnedNodeInterpreter({ env = process.env, envPath, exists = existsSync } = {}) {
  const exported = env[NODE_INTERPRETER_ENV_KEY];
  if (isUsableNodeInterpreter(exported, exists)) return exported;
  const saved = readPortosEnvValue(NODE_INTERPRETER_ENV_KEY, envPath);
  return isUsableNodeInterpreter(saved, exists) ? saved : null;
}

/**
 * `env` with the interpreter's bin directory first on PATH, so a script that
 * calls bare `node`/`npm` (update.sh) runs on the pinned runtime and rebuilds
 * native modules for it. Returns `env` unchanged when nothing is pinned.
 */
export function withNodeBinOnPath(env, interpreter) {
  if (!interpreter) return env;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [pathKey]: [dirname(interpreter), env[pathKey]].filter(Boolean).join(delimiter) };
}
