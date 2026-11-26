/**
 * `resolveBootstrapEnv` runs a provider's optional envCommand to obtain KEY=value credentials for
 * CLI/TUI providers, parsing without evaluation and caching them for one minute.
 *
 * Credential bootstrap wrapping for a CLI/TUI provider whose auth is minted by an external CLI at
 * spawn time (no stored `apiKey`): the bootstrap CLI is spawned in front of the harness, as
 * `<bootstrap> run <harness> <harness args...>`. PortOS never interprets the credential.
 *
 * `provider.command`/`args` keep naming the harness everywhere (vendor detection, prompt delivery,
 * TUI ready-text heuristics); spawn sites ask this module for the pair to hand to `spawn`/`pty.spawn`.
 * Anything observing the launching shell (PATH probe, missing-binary detector) reads `spawnCommand`.
 * EVERY site spawning a provider's `command` must go through here: a bare harness silently falls
 * back to ambient vendor auth (the wrong backend).
 *
 * The `sandboxed-actions` posture (`isPublicReviewActionsProfile`) is NEVER wrapped: an intermediary
 * able to rewrite the recipe's sandbox argv could turn a screened patch loose. The `no-tool`
 * postures ARE wrapped: the wrap mints the credential into the child's env downstream of the
 * `buildCliChildEnv` allowlist.
 *
 * Wrapping changes teardown: the direct child is the WRAPPER, so a per-pid SIGTERM can leave the
 * harness running (`needsProcessGroup`, `trackDetachedGroup`, `signalDetachedGroups`,
 * `processGroupKillable`). Imports stay limited to the dependency-free
 * `aiToolkit/internal/credentialBootstrap.js` leaf, `bufferedSpawn.js` and
 * `agentExecutionProfiles.js` so any spawn site (including the autofixer) can import it cheaply.
 */

import { IS_WIN32, resolveWindowsExecutable, prepareWindowsSafeSpawn, prepareCliSpawn, killProcessTree } from './bufferedSpawn.js';
import { execFile } from './childProcess.js';
import { tmpdir } from 'node:os';
import { withSpawnCwdEnv } from './spawnCwd.js';
import { isPublicReviewNoToolProfile, isPublicReviewActionsProfile } from './agent/agentExecutionProfiles.js';
import { composeBootstrapSpawn, hasCredentialBootstrap } from './aiToolkit/internal/credentialBootstrap.js';

export { hasCredentialBootstrap };
export { trackDetachedGroup, signalDetachedGroups, resetDetachedGroupsForTests } from './detachedProcessGroups.js';

// Memory-only, keyed by record + configuration so an edited command or account cannot reuse old auth.
const bootstrapEnvCache = new Map();
const BOOTSTRAP_ENV_TTL_MS = 60_000;

/**
 * Materialize credentials for a bootstrap that PRINTS `KEY=value` assignments rather than exec'ing
 * the harness. The command gets neither the prompt nor the harness argv. Sandboxed public actions
 * must never acquire these credentials. Returns `{}` when no `envCommand` is configured.
 */
export async function resolveBootstrapEnv(provider, { safetyProfile = null, timeoutMs = 15_000, signal = undefined } = {}) {
  if (signal?.aborted) throw new Error('Bootstrap credential command cancelled.');
  const argv = provider?.credentialBootstrap?.envCommand;
  if (!argv) return {};
  if (safetyProfile && !isPublicReviewNoToolProfile(safetyProfile)) {
    throw new Error('Bootstrap credentials are available only for tool-free reviews or ordinary provider runs.');
  }
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
    throw new Error('Invalid bootstrap credential command.');
  }
  const key = JSON.stringify([provider.id, argv, provider.envVars]);
  const now = Date.now();
  for (const [cachedKey, entry] of bootstrapEnvCache) {
    if (entry.expires <= now) bootstrapEnvCache.delete(cachedKey);
  }
  const cached = bootstrapEnvCache.get(key);
  if (cached) return { ...cached.env };
  const cwd = tmpdir();
  const childEnv = withSpawnCwdEnv({ ...process.env, ...provider.envVars }, cwd);
  const spawnConfig = prepareCliSpawn(argv[0], argv.slice(1), childEnv);
  const env = await new Promise((resolve, reject) => {
    // No shell, bounded runtime/output, and errors never carry stderr/stdout or the command.
    execFile(spawnConfig.command, spawnConfig.args, {
      cwd, env: childEnv,
      shell: false, timeout: Math.max(1, Math.min(15_000, timeoutMs)), signal, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error('Bootstrap credential command failed.'));
      const entries = String(stdout).split(/\r?\n/).flatMap(line => {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\0\r\n]*)$/.exec(line);
        return match ? [[match[1], match[2]]] : [];
      });
      resolve(Object.fromEntries(entries));
    });
  });
  if (!Object.keys(env).length) throw new Error('Bootstrap credential command returned no environment assignments.');
  if (bootstrapEnvCache.size >= 128) bootstrapEnvCache.delete(bootstrapEnvCache.keys().next().value);
  bootstrapEnvCache.set(key, { env, expires: Date.now() + BOOTSTRAP_ENV_TTL_MS });
  return { ...env };
}

/**
 * The command+args to actually spawn: the bootstrap CLI in front of the harness when configured,
 * else the harness unchanged. Pure; Windows shim resolution happens downstream. `wrapped` reports
 * whether the wrap applied (false for the `sandboxed-actions` skip) and drives teardown.
 *
 * @param {{credentialBootstrap?: {command: string, args?: string[], harnessId?: string, argsSeparator?: string}}|null|undefined} provider
 * @param {string} command - the harness binary PortOS would otherwise spawn
 * @param {string[]} [args] - the harness's own argv
 * @param {{safetyProfile?: string|null}} [options] - the run's execution profile; the
 *   `sandboxed-actions` posture is returned unwrapped (see module doc)
 * @returns {{command: string, args: string[], wrapped: boolean}}
 */
export function applyCredentialBootstrap(provider, command, args, { safetyProfile = null } = {}) {
  // Composing against NO provider keeps argv normalization and `wrapped` in one place.
  return composeBootstrapSpawn(isPublicReviewActionsProfile(safetyProfile) ? null : provider, command, args);
}

/**
 * Should this spawn get its own process group, so stop/timeout/cancel reaches the harness BEHIND
 * the bootstrap wrapper? A per-pid signal misses it when the wrapper doesn't forward SIGTERM, and a
 * surviving harness may hold a minted credential. POSIX-only: Windows `taskkill /T` is already
 * tree-wide and `detached` opens a console window. False for unwrapped spawns.
 *
 * @param {boolean} wrapped - the `wrapped` flag from applyCredentialBootstrap/resolveCliSpawn
 * @param {boolean} [isWin32] - injectable for tests; defaults to the real platform
 * @returns {boolean}
 */
export function needsProcessGroup(wrapped, isWin32 = IS_WIN32) {
  return Boolean(wrapped) && !isWin32;
}

/**
 * Wrap a child in the `{ pid, killed, kill(signal) }` shape the aiToolkit external-run registry
 * consumes (`registerExternalRun`), so its `stopRun` signals the whole process group: the vendored
 * toolkit `killProcessTree` has no `processGroup` option but calls a non-ChildProcess handle's
 * `.kill()`. Returns the child UNCHANGED when `processGroup` is false.
 *
 * @param {import('child_process').ChildProcess|{pid?: number, kill: Function}} child
 * @param {boolean} processGroup
 */
export function processGroupKillable(child, processGroup) {
  if (!processGroup) return child;
  return {
    get pid() { return child.pid; },
    get killed() { return child.killed; },
    kill: (signal) => killProcessTree(child, signal || 'SIGTERM', { processGroup: true }),
  };
}

/**
 * `applyCredentialBootstrap` + Windows shim resolution in one call, for headless spawn sites right
 * before `spawn()`. TUI/PTY sites do their own Windows resolution and call
 * `applyCredentialBootstrap` directly. `childEnv` is what the executable is resolved against, so a
 * provider-configured PATH override is honored; `wrapped` carries through (see `needsProcessGroup`).
 *
 * @param {object|null|undefined} provider
 * @param {string} command - the harness binary PortOS would otherwise spawn
 * @param {string[]} args - the harness's own argv
 * @param {NodeJS.ProcessEnv} childEnv - resolved against this so a provider-configured PATH
 *   override is honored
 * @param {{safetyProfile?: string|null}} [options] - forwarded to `applyCredentialBootstrap`
 * @returns {{command: string, args: string[], wrapped: boolean}} `wrapped` is carried through
 *   from `applyCredentialBootstrap` (see `needsProcessGroup`)
 */
export function resolveCliSpawn(provider, command, args, childEnv, options = {}) {
  const bootstrapped = applyCredentialBootstrap(provider, command, args, options);
  const resolvedCommand = resolveWindowsExecutable(bootstrapped.command, undefined, childEnv) || bootstrapped.command;
  return { ...prepareWindowsSafeSpawn(resolvedCommand, bootstrapped.args, undefined, childEnv), wrapped: bootstrapped.wrapped };
}
