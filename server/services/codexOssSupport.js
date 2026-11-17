/**
 * Does the installed Codex CLI accept `--oss` / `--local-provider` (Codex 0.153.0+)?
 *
 * The `codex-ollama` provider needs those per-invocation flags; PortOS does NOT rewrite
 * `~/.codex/config.toml` for older binaries (that would re-point every `codex` run on the machine).
 * So an older CLI must fail CLOSED with a prerequisite finding naming the version, not die mid-run on an
 * unknown flag or silently run the cloud model. `codex exec --help` is the source of truth, not `--version`.
 *
 * Sentinel discipline, as in `providerPrerequisites.js`:
 *   - `null`: NOT PROBED (cold, expired, or the probe couldn't run); never reads as unsupported.
 *   - `{ supported: true }` / `{ supported: false }`: help text was read and does / does not name both flags.
 *
 * No LLM call is made here; `--help` is a local process.
 */

import { commandOutput } from '../lib/commandExists.js';
import { CODEX_COMMAND } from '../lib/codex.js';
import { isTestRunner } from '../lib/runtimeEnv.js';

// Same window as the runtime `--version` sweep in providerRuntimeInstaller.js; expiry means "we no longer know".
const SUPPORT_TTL_MS = 60_000;

/** Both flags must be named — one without the other is not the contract. */
const OSS_FLAGS = ['--oss', '--local-provider'];

// Keyed by the configured command STRING so a pinned wrapper path is judged on the binary it will spawn.
const supportCache = new Map();

let refreshInFlight = new Map();

const readHelp = (command) => commandOutput(command, ['exec', '--help'], { timeoutMs: 10_000 });

// Under the test runner this answers NOT PROBED without spawning (#9039); tests wanting a real spawn pass their own `run`.
const defaultRun = (command) => (isTestRunner() ? Promise.resolve(null) : readHelp(command));

const resolveCommand = (command) => (typeof command === 'string' && command.trim()) || CODEX_COMMAND;

/**
 * The cached verdict for `command`, or `null` when nothing current is cached. Synchronous, no spawn.
 * @param {string} [command]
 * @returns {{supported: boolean}|null}
 */
export function peekCodexOssSupport(command) {
  const cached = supportCache.get(resolveCommand(command));
  if (!cached || Date.now() - cached.at >= SUPPORT_TTL_MS) return null;
  return cached.support;
}

/**
 * The verdict for `command`, probing when nothing current is cached. Coalesced per command so a
 * failure storm doesn't fan out one `--help` spawn per run.
 *
 * @param {string} [command]
 * @param {{fresh?: boolean, run?: (command: string) => Promise<string|null>}} [options]
 * @returns {Promise<{supported: boolean}|null>}
 */
export async function getCodexOssSupport(command, { fresh = false, run = defaultRun } = {}) {
  const resolved = resolveCommand(command);
  if (!fresh) {
    const cached = peekCodexOssSupport(resolved);
    if (cached) return cached;
    const pending = refreshInFlight.get(resolved);
    if (pending) return pending;
  }
  const probe = (async () => {
    const help = await run(resolved).catch(() => null);
    // Could not run it: NOT PROBED, deliberately not cached so the next call retries.
    if (help === null) return null;
    const support = { supported: OSS_FLAGS.every((flag) => help.includes(flag)) };
    supportCache.set(resolved, { at: Date.now(), support });
    return support;
  })().finally(() => { refreshInFlight.delete(resolved); });
  refreshInFlight.set(resolved, probe);
  return probe;
}

/**
 * Kick a probe in the background and swallow the result so the NEXT synchronous peek is accurate.
 * Errors are logged, never thrown: this runs outside the request lifecycle.
 * @param {string} [command]
 */
export function refreshCodexOssSupportInBackground(command) {
  const resolved = resolveCommand(command);
  if (refreshInFlight.has(resolved)) return;
  getCodexOssSupport(resolved).catch((err) => console.error(`❌ Codex --oss probe failed: ${err.message}`));
}

/** Test-only: drop the cache and any in-flight probe so a suite starts clean. */
export function __resetCodexOssSupport() {
  supportCache.clear();
  refreshInFlight = new Map();
}
